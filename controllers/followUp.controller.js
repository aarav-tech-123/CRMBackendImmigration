import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";
import { getRequestInfo } from "../helpers/requestInfo.js";
import { parsePositiveInt, paginationParams } from "../helpers/parsers.js";
import { getCaseOrNull, getLeadOrNull, resolveCaseIdForLead } from "../helpers/caseHelpers.js";

const STATUSES = ["Scheduled", "Completed", "Cancelled", "Rescheduled"];
const PRIORITIES = ["Low", "Medium", "High", "Urgent"];

const isValidDate = (value) => !Number.isNaN(new Date(value).getTime());

const FOLLOWUP_SELECT = `
  f.followup_id, f.lead_id, f.case_id, f.assigned_to, f.followup_type, f.subject,
  f.description, f.scheduled_at, f.completed_at, f.status, f.priority, f.remarks,
  f.created_at, f.updated_at, u.name AS assigned_user_name
`;

// ---------------------------------------------------------------------------
// GET /lead/:leadId
// ---------------------------------------------------------------------------
export const getFollowUpsForLead = async (req, res) => {
  const leadId = parsePositiveInt(req.params.leadId);
  if (!leadId) {
    return res.status(400).json({ success: false, message: "A valid leadId is required." });
  }
  const { page, pageSize, offset } = paginationParams(req);

  try {
    const pool = await poolPromise;

    const lead = await getLeadOrNull(pool, leadId);
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    const [dataResult, countResult] = await Promise.all([
      pool
        .request()
        .input("lead_id", sql.Int, leadId)
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize)
        .query(`
          SELECT ${FOLLOWUP_SELECT}
          FROM FollowUps f
          LEFT JOIN Users u ON u.id = f.assigned_to
          WHERE f.lead_id = @lead_id
          ORDER BY f.scheduled_at DESC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      pool.request().input("lead_id", sql.Int, leadId).query("SELECT COUNT(*) AS total FROM FollowUps WHERE lead_id = @lead_id"),
    ]);

    return res.status(200).json({
      success: true,
      leadId,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      followups: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getFollowUpsForLead] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch follow-ups." });
  }
};

// ---------------------------------------------------------------------------
// GET /case/:caseId
// ---------------------------------------------------------------------------
export const getFollowUpsForCase = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }
  const { page, pageSize, offset } = paginationParams(req);

  try {
    const pool = await poolPromise;

    const caseRow = await getCaseOrNull(pool, caseId);
    if (!caseRow) {
      return res.status(404).json({ success: false, message: "Immigration case not found." });
    }

    const [dataResult, countResult] = await Promise.all([
      pool
        .request()
        .input("case_id", sql.Int, caseId)
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize)
        .query(`
          SELECT ${FOLLOWUP_SELECT}
          FROM FollowUps f
          LEFT JOIN Users u ON u.id = f.assigned_to
          WHERE f.case_id = @case_id
          ORDER BY f.scheduled_at DESC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      pool.request().input("case_id", sql.Int, caseId).query("SELECT COUNT(*) AS total FROM FollowUps WHERE case_id = @case_id"),
    ]);

    return res.status(200).json({
      success: true,
      caseId,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      followups: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getFollowUpsForCase] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch follow-ups." });
  }
};

// ---------------------------------------------------------------------------
// GET /mine?status=&upcoming=1 — follow-ups assigned to the requesting user
// ---------------------------------------------------------------------------
export const getMyFollowUps = async (req, res) => {
  const { page, pageSize, offset } = paginationParams(req);
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const upcomingOnly = req.query.upcoming === "1";

  try {
    const pool = await poolPromise;

    const buildRequest = () =>
      pool
        .request()
        .input("assigned_to", sql.Int, req.user.id)
        .input("status", sql.VarChar(20), status)
        .input("upcoming_only", sql.Bit, upcomingOnly ? 1 : 0);

    const [dataResult, countResult] = await Promise.all([
      buildRequest()
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize)
        .query(`
          SELECT ${FOLLOWUP_SELECT}
          FROM FollowUps f
          LEFT JOIN Users u ON u.id = f.assigned_to
          WHERE f.assigned_to = @assigned_to
            AND (@status IS NULL OR f.status = @status)
            AND (@upcoming_only = 0 OR f.scheduled_at >= GETDATE())
          ORDER BY f.scheduled_at ASC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      buildRequest().query(`
        SELECT COUNT(*) AS total
        FROM FollowUps f
        WHERE f.assigned_to = @assigned_to
          AND (@status IS NULL OR f.status = @status)
          AND (@upcoming_only = 0 OR f.scheduled_at >= GETDATE());
      `),
    ]);

    return res.status(200).json({
      success: true,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      followups: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getMyFollowUps] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch follow-ups." });
  }
};

// ---------------------------------------------------------------------------
// POST /lead/:leadId
//
// case_id is auto-resolved from the lead's most recent ImmigrationCases row
// (null if the lead hasn't been converted yet). Pass case_id explicitly to
// override, e.g. for a lead with more than one case.
// ---------------------------------------------------------------------------
export const createFollowUp = async (req, res) => {
  const leadId = parsePositiveInt(req.params.leadId);
  if (!leadId) {
    return res.status(400).json({ success: false, message: "A valid leadId is required." });
  }

  const { followup_type, subject, description, scheduled_at, assigned_to, priority, remarks, case_id } = req.body || {};
  const createdBy = req.user?.id;

  if (!followup_type || !String(followup_type).trim()) {
    return res.status(400).json({ success: false, message: "followup_type is required." });
  }
  if (!subject || !String(subject).trim()) {
    return res.status(400).json({ success: false, message: "subject is required." });
  }
  if (!scheduled_at || !isValidDate(scheduled_at)) {
    return res.status(400).json({ success: false, message: "A valid scheduled_at is required." });
  }
  if (priority !== undefined && priority !== null && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ success: false, message: `priority must be one of: ${PRIORITIES.join(", ")}.` });
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

    let assignedTo = parsePositiveInt(assigned_to) || createdBy;
    if (assigned_to !== undefined && assigned_to !== null && assigned_to !== "" && !parsePositiveInt(assigned_to)) {
      return res.status(400).json({ success: false, message: "Invalid assigned_to." });
    }
    const userCheck = await pool.request().input("id", sql.Int, assignedTo).query("SELECT id FROM Users WHERE id = @id");
    if (userCheck.recordset.length === 0) {
      return res.status(400).json({ success: false, message: "assigned_to user does not exist." });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const insertResult = await transaction
      .request()
      .input("lead_id", sql.Int, leadId)
      .input("case_id", sql.Int, resolvedCaseId)
      .input("assigned_to", sql.Int, assignedTo)
      .input("followup_type", sql.VarChar(50), followup_type.trim())
      .input("subject", sql.NVarChar(255), subject.trim())
      .input("description", sql.NVarChar(sql.MAX), description || null)
      .input("scheduled_at", sql.DateTime, new Date(scheduled_at))
      .input("status", sql.VarChar(20), "Scheduled")
      .input("priority", sql.VarChar(20), priority || "Medium")
      .input("remarks", sql.NVarChar(sql.MAX), remarks || null)
      .query(`
        INSERT INTO FollowUps
          (lead_id, case_id, assigned_to, followup_type, subject, description,
           scheduled_at, completed_at, status, priority, remarks, created_at, updated_at)
        OUTPUT INSERTED.*
        VALUES
          (@lead_id, @case_id, @assigned_to, @followup_type, @subject, @description,
           @scheduled_at, NULL, @status, @priority, @remarks, GETDATE(), GETDATE())
      `);
    const createdFollowUp = insertResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId,
      caseId: resolvedCaseId,
      userId: createdBy,
      activityType: "FOLLOWUP_CREATED",
      entityType: resolvedCaseId ? "CASE" : "LEAD",
      entityId: resolvedCaseId || leadId,
      oldValue: null,
      newValue: createdFollowUp.status,
      description: `Follow-up "${createdFollowUp.subject}" scheduled.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(201).json({ success: true, message: "Follow-up created successfully.", data: createdFollowUp });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[createFollowUp] Rollback failed:", rollbackErr);
      }
    }
    console.error("[createFollowUp] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to create follow-up." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /:followupId
// ---------------------------------------------------------------------------
export const updateFollowUp = async (req, res) => {
  const followupId = parsePositiveInt(req.params.followupId);
  if (!followupId) {
    return res.status(400).json({ success: false, message: "A valid followupId is required." });
  }

  const { followup_type, subject, description, scheduled_at, assigned_to, status, priority, remarks } = req.body || {};
  const changedBy = req.user?.id;

  if (status !== undefined && status !== null && !STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: `status must be one of: ${STATUSES.join(", ")}.` });
  }
  if (priority !== undefined && priority !== null && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ success: false, message: `priority must be one of: ${PRIORITIES.join(", ")}.` });
  }
  if (scheduled_at !== undefined && scheduled_at !== null && !isValidDate(scheduled_at)) {
    return res.status(400).json({ success: false, message: "Invalid scheduled_at." });
  }

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const existingResult = await pool
      .request()
      .input("followup_id", sql.Int, followupId)
      .query("SELECT * FROM FollowUps WHERE followup_id = @followup_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Follow-up not found." });
    }
    const existingFollowUp = existingResult.recordset[0];

    let assignedTo = existingFollowUp.assigned_to;
    if (assigned_to !== undefined) {
      assignedTo = parsePositiveInt(assigned_to);
      if (!assignedTo) {
        return res.status(400).json({ success: false, message: "Invalid assigned_to." });
      }
      const userCheck = await pool.request().input("id", sql.Int, assignedTo).query("SELECT id FROM Users WHERE id = @id");
      if (userCheck.recordset.length === 0) {
        return res.status(400).json({ success: false, message: "assigned_to user does not exist." });
      }
    }

    // completed_at follows status, but only moves when status is actually changing.
    let completedAtSql = "completed_at";
    if (status !== undefined && status !== existingFollowUp.status) {
      completedAtSql = status === "Completed" ? "GETDATE()" : "NULL";
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const updateResult = await transaction
      .request()
      .input("followup_id", sql.Int, followupId)
      .input("followup_type", sql.VarChar(50), followup_type !== undefined ? followup_type : existingFollowUp.followup_type)
      .input("subject", sql.NVarChar(255), subject !== undefined ? subject : existingFollowUp.subject)
      .input("description", sql.NVarChar(sql.MAX), description !== undefined ? description : existingFollowUp.description)
      .input("scheduled_at", sql.DateTime, scheduled_at !== undefined ? new Date(scheduled_at) : existingFollowUp.scheduled_at)
      .input("assigned_to", sql.Int, assignedTo)
      .input("status", sql.VarChar(20), status !== undefined ? status : existingFollowUp.status)
      .input("priority", sql.VarChar(20), priority !== undefined ? priority : existingFollowUp.priority)
      .input("remarks", sql.NVarChar(sql.MAX), remarks !== undefined ? remarks : existingFollowUp.remarks)
      .query(`
        UPDATE FollowUps
        SET
          followup_type = @followup_type,
          subject = @subject,
          description = @description,
          scheduled_at = @scheduled_at,
          assigned_to = @assigned_to,
          status = @status,
          priority = @priority,
          remarks = @remarks,
          completed_at = ${completedAtSql},
          updated_at = GETDATE()
        OUTPUT INSERTED.*
        WHERE followup_id = @followup_id
      `);
    const updatedFollowUp = updateResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: existingFollowUp.lead_id,
      caseId: existingFollowUp.case_id,
      userId: changedBy,
      activityType: "FOLLOWUP_UPDATED",
      entityType: existingFollowUp.case_id ? "CASE" : "LEAD",
      entityId: existingFollowUp.case_id || existingFollowUp.lead_id,
      oldValue: existingFollowUp.status,
      newValue: updatedFollowUp.status,
      description: `Follow-up "${updatedFollowUp.subject}" updated.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Follow-up updated successfully.", data: updatedFollowUp });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[updateFollowUp] Rollback failed:", rollbackErr);
      }
    }
    console.error("[updateFollowUp] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update follow-up." });
  }
};

// ---------------------------------------------------------------------------
// DELETE /:followupId
// ---------------------------------------------------------------------------
export const deleteFollowUp = async (req, res) => {
  const followupId = parsePositiveInt(req.params.followupId);
  if (!followupId) {
    return res.status(400).json({ success: false, message: "A valid followupId is required." });
  }
  const changedBy = req.user?.id;

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const existingResult = await pool
      .request()
      .input("followup_id", sql.Int, followupId)
      .query("SELECT followup_id, lead_id, case_id, subject FROM FollowUps WHERE followup_id = @followup_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Follow-up not found." });
    }
    const existingFollowUp = existingResult.recordset[0];

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    await transaction.request().input("followup_id", sql.Int, followupId).query("DELETE FROM FollowUps WHERE followup_id = @followup_id");

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: existingFollowUp.lead_id,
      caseId: existingFollowUp.case_id,
      userId: changedBy,
      activityType: "FOLLOWUP_DELETED",
      entityType: existingFollowUp.case_id ? "CASE" : "LEAD",
      entityId: existingFollowUp.case_id || existingFollowUp.lead_id,
      oldValue: existingFollowUp.subject,
      newValue: null,
      description: `Follow-up "${existingFollowUp.subject}" deleted.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Follow-up deleted successfully." });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[deleteFollowUp] Rollback failed:", rollbackErr);
      }
    }
    console.error("[deleteFollowUp] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete follow-up." });
  }
};
