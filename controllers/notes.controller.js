import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";
import { getRequestInfo } from "../helpers/requestInfo.js";
import { parsePositiveInt, paginationParams } from "../helpers/parsers.js";
import { getCaseOrNull, getLeadOrNull, resolveCaseIdForLead } from "../helpers/caseHelpers.js";

const ELEVATED_ROLES = ["Manager", "SuperAdmin"];

const canSeeAllPrivateNotes = (req) => ELEVATED_ROLES.includes(req.user?.role);
const canModifyNote = (req, note) => note.user_id === req.user?.id || canSeeAllPrivateNotes(req);

const NOTE_SELECT = `
  n.note_id, n.lead_id, n.case_id, n.user_id, n.note_type, n.note, n.is_private,
  n.created_at, n.updated_at, u.name AS user_name
`;

// ---------------------------------------------------------------------------
// GET /lead/:leadId
// ---------------------------------------------------------------------------
export const getNotesForLead = async (req, res) => {
  const leadId = parsePositiveInt(req.params.leadId);
  if (!leadId) {
    return res.status(400).json({ success: false, message: "A valid leadId is required." });
  }
  const { page, pageSize, offset } = paginationParams(req);
  const seeAllPrivate = canSeeAllPrivateNotes(req);

  try {
    const pool = await poolPromise;

    const lead = await getLeadOrNull(pool, leadId);
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    const buildRequest = () =>
      pool
        .request()
        .input("lead_id", sql.Int, leadId)
        .input("requester_id", sql.Int, req.user.id)
        .input("see_all_private", sql.Bit, seeAllPrivate ? 1 : 0);

    const [dataResult, countResult] = await Promise.all([
      buildRequest()
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize)
        .query(`
          SELECT ${NOTE_SELECT}
          FROM Notes n
          LEFT JOIN Users u ON u.id = n.user_id
          WHERE n.lead_id = @lead_id
            AND (n.is_private = 0 OR n.user_id = @requester_id OR @see_all_private = 1)
          ORDER BY n.created_at DESC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      buildRequest().query(`
        SELECT COUNT(*) AS total
        FROM Notes n
        WHERE n.lead_id = @lead_id
          AND (n.is_private = 0 OR n.user_id = @requester_id OR @see_all_private = 1);
      `),
    ]);

    return res.status(200).json({
      success: true,
      leadId,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      notes: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getNotesForLead] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch notes." });
  }
};

// ---------------------------------------------------------------------------
// GET /case/:caseId
// ---------------------------------------------------------------------------
export const getNotesForCase = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }
  const { page, pageSize, offset } = paginationParams(req);
  const seeAllPrivate = canSeeAllPrivateNotes(req);

  try {
    const pool = await poolPromise;

    const caseRow = await getCaseOrNull(pool, caseId);
    if (!caseRow) {
      return res.status(404).json({ success: false, message: "Immigration case not found." });
    }

    const buildRequest = () =>
      pool
        .request()
        .input("case_id", sql.Int, caseId)
        .input("requester_id", sql.Int, req.user.id)
        .input("see_all_private", sql.Bit, seeAllPrivate ? 1 : 0);

    const [dataResult, countResult] = await Promise.all([
      buildRequest()
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize)
        .query(`
          SELECT ${NOTE_SELECT}
          FROM Notes n
          LEFT JOIN Users u ON u.id = n.user_id
          WHERE n.case_id = @case_id
            AND (n.is_private = 0 OR n.user_id = @requester_id OR @see_all_private = 1)
          ORDER BY n.created_at DESC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      buildRequest().query(`
        SELECT COUNT(*) AS total
        FROM Notes n
        WHERE n.case_id = @case_id
          AND (n.is_private = 0 OR n.user_id = @requester_id OR @see_all_private = 1);
      `),
    ]);

    return res.status(200).json({
      success: true,
      caseId,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      notes: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getNotesForCase] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch notes." });
  }
};

// ---------------------------------------------------------------------------
// POST /lead/:leadId
//
// case_id is auto-resolved from the lead's most recent ImmigrationCases row
// (null if the lead hasn't been converted yet). Pass case_id explicitly to
// override, e.g. for a lead with more than one case.
// ---------------------------------------------------------------------------
export const createNote = async (req, res) => {
  const leadId = parsePositiveInt(req.params.leadId);
  if (!leadId) {
    return res.status(400).json({ success: false, message: "A valid leadId is required." });
  }

  const { note, note_type, is_private, case_id } = req.body || {};
  const userId = req.user?.id;

  if (!note || !String(note).trim()) {
    return res.status(400).json({ success: false, message: "note is required." });
  }

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const lead = await getLeadOrNull(pool, leadId);
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    let resolvedCaseId = parsePositiveInt(case_id);
    if (case_id !== undefined && case_id !== null && case_id !== "" && !resolvedCaseId) {
      return res.status(400).json({ success: false, message: "Invalid case_id." });
    }

    if (resolvedCaseId) {
      const caseRow = await getCaseOrNull(pool, resolvedCaseId);
      if (!caseRow || caseRow.lead_id !== leadId) {
        return res.status(400).json({ success: false, message: "case_id does not belong to this lead." });
      }
    } else {
      resolvedCaseId = await resolveCaseIdForLead(pool, leadId);
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const insertResult = await transaction
      .request()
      .input("lead_id", sql.Int, leadId)
      .input("case_id", sql.Int, resolvedCaseId)
      .input("user_id", sql.Int, userId)
      .input("note_type", sql.VarChar(50), note_type || "General")
      .input("note", sql.NVarChar(sql.MAX), note.trim())
      .input("is_private", sql.Bit, is_private ? 1 : 0)
      .query(`
        INSERT INTO Notes (lead_id, case_id, user_id, note_type, note, is_private, created_at, updated_at)
        OUTPUT INSERTED.*
        VALUES (@lead_id, @case_id, @user_id, @note_type, @note, @is_private, GETDATE(), GETDATE())
      `);
    const createdNote = insertResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId,
      caseId: resolvedCaseId,
      userId,
      activityType: "NOTE_ADDED",
      entityType: resolvedCaseId ? "CASE" : "LEAD",
      entityId: resolvedCaseId || leadId,
      oldValue: null,
      newValue: createdNote.note_type,
      description: `${createdNote.note_type} note added.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(201).json({ success: true, message: "Note added successfully.", data: createdNote });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[createNote] Rollback failed:", rollbackErr);
      }
    }
    console.error("[createNote] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to add note." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /:noteId — author, or Manager/SuperAdmin, only
// ---------------------------------------------------------------------------
export const updateNote = async (req, res) => {
  const noteId = parsePositiveInt(req.params.noteId);
  if (!noteId) {
    return res.status(400).json({ success: false, message: "A valid noteId is required." });
  }
  const { note, note_type, is_private } = req.body || {};
  const changedBy = req.user?.id;

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const existingResult = await pool.request().input("note_id", sql.Int, noteId).query("SELECT * FROM Notes WHERE note_id = @note_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Note not found." });
    }
    const existingNote = existingResult.recordset[0];

    if (!canModifyNote(req, existingNote)) {
      return res.status(403).json({ success: false, message: "You do not have permission to edit this note." });
    }
    if (note !== undefined && !String(note).trim()) {
      return res.status(400).json({ success: false, message: "note cannot be empty." });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const updateResult = await transaction
      .request()
      .input("note_id", sql.Int, noteId)
      .input("note", sql.NVarChar(sql.MAX), note !== undefined ? note.trim() : existingNote.note)
      .input("note_type", sql.VarChar(50), note_type !== undefined ? note_type : existingNote.note_type)
      .input("is_private", sql.Bit, is_private !== undefined ? (is_private ? 1 : 0) : existingNote.is_private)
      .query(`
        UPDATE Notes
        SET note = @note, note_type = @note_type, is_private = @is_private, updated_at = GETDATE()
        OUTPUT INSERTED.*
        WHERE note_id = @note_id
      `);
    const updatedNote = updateResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: existingNote.lead_id,
      caseId: existingNote.case_id,
      userId: changedBy,
      activityType: "NOTE_UPDATED",
      entityType: existingNote.case_id ? "CASE" : "LEAD",
      entityId: existingNote.case_id || existingNote.lead_id,
      oldValue: existingNote.note,
      newValue: updatedNote.note,
      description: `Note ${noteId} updated.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Note updated successfully.", data: updatedNote });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[updateNote] Rollback failed:", rollbackErr);
      }
    }
    console.error("[updateNote] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update note." });
  }
};

// ---------------------------------------------------------------------------
// DELETE /:noteId — author, or Manager/SuperAdmin, only
// ---------------------------------------------------------------------------
export const deleteNote = async (req, res) => {
  const noteId = parsePositiveInt(req.params.noteId);
  if (!noteId) {
    return res.status(400).json({ success: false, message: "A valid noteId is required." });
  }
  const changedBy = req.user?.id;

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const existingResult = await pool.request().input("note_id", sql.Int, noteId).query("SELECT * FROM Notes WHERE note_id = @note_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Note not found." });
    }
    const existingNote = existingResult.recordset[0];

    if (!canModifyNote(req, existingNote)) {
      return res.status(403).json({ success: false, message: "You do not have permission to delete this note." });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    await transaction.request().input("note_id", sql.Int, noteId).query("DELETE FROM Notes WHERE note_id = @note_id");

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: existingNote.lead_id,
      caseId: existingNote.case_id,
      userId: changedBy,
      activityType: "NOTE_DELETED",
      entityType: existingNote.case_id ? "CASE" : "LEAD",
      entityId: existingNote.case_id || existingNote.lead_id,
      oldValue: existingNote.note,
      newValue: null,
      description: `Note ${noteId} deleted.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Note deleted successfully." });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[deleteNote] Rollback failed:", rollbackErr);
      }
    }
    console.error("[deleteNote] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete note." });
  }
};
