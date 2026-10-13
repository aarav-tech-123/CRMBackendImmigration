import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";
import { getRequestInfo } from "../helpers/requestInfo.js";
import { parsePositiveInt } from "../helpers/parsers.js";
import { getCaseOrNull } from "../helpers/caseHelpers.js";

const PNP_STATUSES = ["Considering", "Applied", "Nominated", "Refused", "Withdrawn"];

const isValidDate = (value) => !Number.isNaN(new Date(value).getTime());
const isBlank = (value) => value === undefined || value === null || value === "";

const CASE_PNP_SELECT = `
  cp.case_pnp_id, cp.case_id, cp.pnp_program_id, cp.pnp_status, cp.applied_date,
  cp.decision_date, cp.remarks, cp.created_at, cp.updated_at,
  p.province_code, p.province_name, p.program_name, p.stream_type, p.is_active AS program_is_active
`;

const getCaseProgramLink = async (executor, caseId, caseProgramId) => {
  const result = await executor
    .request()
    .input("case_pnp_id", sql.Int, caseProgramId)
    .input("case_id", sql.Int, caseId)
    .query(`
      SELECT cp.*, p.program_name
      FROM CasePNPPrograms cp
      INNER JOIN PNPPrograms p ON p.pnp_program_id = cp.pnp_program_id
      WHERE cp.case_pnp_id = @case_pnp_id AND cp.case_id = @case_id
    `);
  return result.recordset[0] || null;
};

// ---------------------------------------------------------------------------
// GET /:caseId
// ---------------------------------------------------------------------------
export const getCasePnpPrograms = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }

  try {
    const pool = await poolPromise;

    const caseRow = await getCaseOrNull(pool, caseId);
    if (!caseRow) {
      return res.status(404).json({ success: false, message: "Immigration case not found." });
    }

    const result = await pool
      .request()
      .input("case_id", sql.Int, caseId)
      .query(`
        SELECT ${CASE_PNP_SELECT}
        FROM CasePNPPrograms cp
        INNER JOIN PNPPrograms p ON p.pnp_program_id = cp.pnp_program_id
        WHERE cp.case_id = @case_id
        ORDER BY cp.created_at DESC
      `);

    return res.status(200).json({ success: true, caseId, total: result.recordset.length, programs: result.recordset });
  } catch (err) {
    console.error("[getCasePnpPrograms] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch case PNP programs." });
  }
};

// ---------------------------------------------------------------------------
// POST /:caseId
// Body: { pnp_program_id, pnp_status?, applied_date?, decision_date?, remarks? }
//    or { pnp_program_ids: [1, 2, 3] } to attach several programs at once.
// ---------------------------------------------------------------------------
export const addCasePnpPrograms = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }

  const { pnp_program_id, pnp_program_ids, pnp_status, applied_date, decision_date, remarks } = req.body || {};
  const createdBy = req.user?.id;

  const rawIds = Array.isArray(pnp_program_ids) ? pnp_program_ids : [pnp_program_id];
  const programIds = [...new Set(rawIds.map(parsePositiveInt))];
  if (programIds.length === 0 || programIds.some((id) => !id)) {
    return res.status(400).json({ success: false, message: "A valid pnp_program_id (or pnp_program_ids array) is required." });
  }
  if (!isBlank(pnp_status) && !PNP_STATUSES.includes(pnp_status)) {
    return res.status(400).json({ success: false, message: `pnp_status must be one of: ${PNP_STATUSES.join(", ")}.` });
  }
  if ((!isBlank(applied_date) && !isValidDate(applied_date)) || (!isBlank(decision_date) && !isValidDate(decision_date))) {
    return res.status(400).json({ success: false, message: "Invalid applied_date or decision_date." });
  }

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const caseRow = await getCaseOrNull(pool, caseId);
    if (!caseRow) {
      return res.status(404).json({ success: false, message: "Immigration case not found." });
    }

    const programsResult = await pool.request().query(
      `SELECT pnp_program_id, program_name, province_code FROM PNPPrograms
       WHERE is_active = 1 AND pnp_program_id IN (${programIds.join(",")})`
    );
    const foundIds = new Set(programsResult.recordset.map((p) => p.pnp_program_id));
    const missing = programIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: `PNP program(s) not found or inactive: ${missing.join(", ")}.` });
    }

    const linkedResult = await pool
      .request()
      .input("case_id", sql.Int, caseId)
      .query(`SELECT pnp_program_id FROM CasePNPPrograms WHERE case_id = @case_id AND pnp_program_id IN (${programIds.join(",")})`);
    if (linkedResult.recordset.length > 0) {
      return res.status(409).json({
        success: false,
        message: `PNP program(s) already linked to this case: ${linkedResult.recordset.map((r) => r.pnp_program_id).join(", ")}.`,
      });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const created = [];
    const { ipAddress, userAgent } = getRequestInfo(req);

    for (const programId of programIds) {
      const insertResult = await transaction
        .request()
        .input("case_id", sql.Int, caseId)
        .input("pnp_program_id", sql.Int, programId)
        .input("pnp_status", sql.VarChar(30), isBlank(pnp_status) ? "Considering" : pnp_status)
        .input("applied_date", sql.DateTime, isBlank(applied_date) ? null : new Date(applied_date))
        .input("decision_date", sql.DateTime, isBlank(decision_date) ? null : new Date(decision_date))
        .input("remarks", sql.NVarChar(sql.MAX), remarks || null)
        .input("created_by", sql.Int, createdBy ?? null)
        .query(`
          INSERT INTO CasePNPPrograms
            (case_id, pnp_program_id, pnp_status, applied_date, decision_date, remarks, created_by, created_at, updated_at)
          OUTPUT INSERTED.*
          VALUES
            (@case_id, @pnp_program_id, @pnp_status, @applied_date, @decision_date, @remarks, @created_by, GETDATE(), GETDATE())
        `);
      const row = insertResult.recordset[0];
      created.push(row);

      const program = programsResult.recordset.find((p) => p.pnp_program_id === programId);
      await createActivityLog({
        transaction,
        leadId: caseRow.lead_id,
        caseId,
        userId: createdBy,
        activityType: "CASE_PNP_ADDED",
        entityType: "CASE",
        entityId: caseId,
        oldValue: null,
        newValue: row.pnp_status,
        description: `PNP program "${program.program_name}" (${program.province_code}) added to case.`,
        ipAddress,
        userAgent,
      });
    }

    await transaction.commit();
    transactionStarted = false;

    return res.status(201).json({ success: true, message: "PNP program(s) added to case.", data: created });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[addCasePnpPrograms] Rollback failed:", rollbackErr);
      }
    }
    console.error("[addCasePnpPrograms] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to add PNP program to case." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /:caseId/:casePnpId
// ---------------------------------------------------------------------------
export const updateCasePnpProgram = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  const casePnpId = parsePositiveInt(req.params.casePnpId);
  if (!caseId || !casePnpId) {
    return res.status(400).json({ success: false, message: "A valid caseId and casePnpId are required." });
  }

  const { pnp_status, applied_date, decision_date, remarks } = req.body || {};
  const changedBy = req.user?.id;

  if (!isBlank(pnp_status) && !PNP_STATUSES.includes(pnp_status)) {
    return res.status(400).json({ success: false, message: `pnp_status must be one of: ${PNP_STATUSES.join(", ")}.` });
  }
  if ((!isBlank(applied_date) && !isValidDate(applied_date)) || (!isBlank(decision_date) && !isValidDate(decision_date))) {
    return res.status(400).json({ success: false, message: "Invalid applied_date or decision_date." });
  }

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const caseRow = await getCaseOrNull(pool, caseId);
    if (!caseRow) {
      return res.status(404).json({ success: false, message: "Immigration case not found." });
    }

    const existing = await getCaseProgramLink(pool, caseId, casePnpId);
    if (!existing) {
      return res.status(404).json({ success: false, message: "PNP program link not found for this case." });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const updateResult = await transaction
      .request()
      .input("case_pnp_id", sql.Int, casePnpId)
      .input("pnp_status", sql.VarChar(30), isBlank(pnp_status) ? existing.pnp_status : pnp_status)
      .input("applied_date", sql.DateTime, applied_date !== undefined ? (isBlank(applied_date) ? null : new Date(applied_date)) : existing.applied_date)
      .input("decision_date", sql.DateTime, decision_date !== undefined ? (isBlank(decision_date) ? null : new Date(decision_date)) : existing.decision_date)
      .input("remarks", sql.NVarChar(sql.MAX), remarks !== undefined ? remarks : existing.remarks)
      .query(`
        UPDATE CasePNPPrograms
        SET pnp_status = @pnp_status,
            applied_date = @applied_date,
            decision_date = @decision_date,
            remarks = @remarks,
            updated_at = GETDATE()
        OUTPUT INSERTED.*
        WHERE case_pnp_id = @case_pnp_id
      `);
    const updated = updateResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: changedBy,
      activityType: "CASE_PNP_UPDATED",
      entityType: "CASE",
      entityId: caseId,
      oldValue: existing.pnp_status,
      newValue: updated.pnp_status,
      description: `PNP program "${existing.program_name}" updated.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Case PNP program updated successfully.", data: updated });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[updateCasePnpProgram] Rollback failed:", rollbackErr);
      }
    }
    console.error("[updateCasePnpProgram] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update case PNP program." });
  }
};

// ---------------------------------------------------------------------------
// DELETE /:caseId/:casePnpId
// ---------------------------------------------------------------------------
export const removeCasePnpProgram = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  const casePnpId = parsePositiveInt(req.params.casePnpId);
  if (!caseId || !casePnpId) {
    return res.status(400).json({ success: false, message: "A valid caseId and casePnpId are required." });
  }
  const changedBy = req.user?.id;

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const caseRow = await getCaseOrNull(pool, caseId);
    if (!caseRow) {
      return res.status(404).json({ success: false, message: "Immigration case not found." });
    }

    const existing = await getCaseProgramLink(pool, caseId, casePnpId);
    if (!existing) {
      return res.status(404).json({ success: false, message: "PNP program link not found for this case." });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    await transaction
      .request()
      .input("case_pnp_id", sql.Int, casePnpId)
      .query("DELETE FROM CasePNPPrograms WHERE case_pnp_id = @case_pnp_id");

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: changedBy,
      activityType: "CASE_PNP_REMOVED",
      entityType: "CASE",
      entityId: caseId,
      oldValue: existing.program_name,
      newValue: null,
      description: `PNP program "${existing.program_name}" removed from case.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "PNP program removed from case." });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[removeCasePnpProgram] Rollback failed:", rollbackErr);
      }
    }
    console.error("[removeCasePnpProgram] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to remove PNP program from case." });
  }
};
