import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";
import { getRequestInfo } from "../helpers/requestInfo.js";
import { parsePositiveInt, paginationParams } from "../helpers/parsers.js";
import { getCaseOrNull, getLeadOrNull, resolveCaseIdForLead } from "../helpers/caseHelpers.js";

const STATUSES = ["Pending", "Completed", "Dismissed"];
const PRIORITIES = ["Low", "Medium", "High", "Urgent"];

const isValidDate = (value) => !Number.isNaN(new Date(value).getTime());

const REMINDER_SELECT = `
  r.reminder_id, r.lead_id, r.case_id, r.user_id, r.created_by, r.title, r.description,
  r.remind_at, r.priority, r.status, r.is_sent, r.sent_at, r.completed_at, r.remarks,
  r.created_at, r.updated_at, u.name AS user_name, creator.name AS created_by_name
`;
const REMINDER_JOINS = `
  FROM Reminders r
  LEFT JOIN Users u ON u.id = r.user_id
  LEFT JOIN Users creator ON creator.id = r.created_by
`;

// ---------------------------------------------------------------------------
// GET /lead/:leadId
// ---------------------------------------------------------------------------
export const getRemindersForLead = async (req, res) => {
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
          SELECT ${REMINDER_SELECT}
          ${REMINDER_JOINS}
          WHERE r.lead_id = @lead_id
          ORDER BY r.remind_at ASC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      pool.request().input("lead_id", sql.Int, leadId).query("SELECT COUNT(*) AS total FROM Reminders WHERE lead_id = @lead_id"),
    ]);

    return res.status(200).json({
      success: true,
      leadId,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      reminders: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getRemindersForLead] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch reminders." });
  }
};

// ---------------------------------------------------------------------------
// GET /case/:caseId
// ---------------------------------------------------------------------------
export const getRemindersForCase = async (req, res) => {
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
          SELECT ${REMINDER_SELECT}
          ${REMINDER_JOINS}
          WHERE r.case_id = @case_id
          ORDER BY r.remind_at ASC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      pool.request().input("case_id", sql.Int, caseId).query("SELECT COUNT(*) AS total FROM Reminders WHERE case_id = @case_id"),
    ]);

    return res.status(200).json({
      success: true,
      caseId,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      reminders: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getRemindersForCase] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch reminders." });
  }
};

// ---------------------------------------------------------------------------
// GET /mine?status=&upcoming=1&overdue=1 — reminders for the requesting user
// ---------------------------------------------------------------------------
export const getMyReminders = async (req, res) => {
  const { page, pageSize, offset } = paginationParams(req);
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const upcomingOnly = req.query.upcoming === "1";
  const overdueOnly = req.query.overdue === "1";

  try {
    const pool = await poolPromise;

    const buildRequest = () =>
      pool
        .request()
        .input("user_id", sql.Int, req.user.id)
        .input("status", sql.VarChar(20), status)
        .input("upcoming_only", sql.Bit, upcomingOnly ? 1 : 0)
        .input("overdue_only", sql.Bit, overdueOnly ? 1 : 0);

    const [dataResult, countResult] = await Promise.all([
      buildRequest()
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize)
        .query(`
          SELECT ${REMINDER_SELECT}
          ${REMINDER_JOINS}
          WHERE r.user_id = @user_id
            AND (@status IS NULL OR r.status = @status)
            AND (@upcoming_only = 0 OR r.remind_at >= GETDATE())
            AND (@overdue_only = 0 OR (r.remind_at < GETDATE() AND r.status = 'Pending'))
          ORDER BY r.remind_at ASC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      buildRequest().query(`
        SELECT COUNT(*) AS total
        ${REMINDER_JOINS}
        WHERE r.user_id = @user_id
          AND (@status IS NULL OR r.status = @status)
          AND (@upcoming_only = 0 OR r.remind_at >= GETDATE())
          AND (@overdue_only = 0 OR (r.remind_at < GETDATE() AND r.status = 'Pending'));
      `),
    ]);

    return res.status(200).json({
      success: true,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      reminders: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getMyReminders] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch reminders." });
  }
};

// ---------------------------------------------------------------------------
// POST /lead/:leadId
//
// case_id is auto-resolved from the lead's most recent ImmigrationCases row
// (null if the lead hasn't been converted yet). Pass case_id explicitly to
// override. user_id defaults to the creator (a self-reminder).
// ---------------------------------------------------------------------------
export const createReminder = async (req, res) => {
  const leadId = parsePositiveInt(req.params.leadId);
  if (!leadId) {
    return res.status(400).json({ success: false, message: "A valid leadId is required." });
  }

  const { title, description, remind_at, priority, remarks, user_id, case_id } = req.body || {};
  const createdBy = req.user?.id;

  if (!title || !String(title).trim()) {
    return res.status(400).json({ success: false, message: "title is required." });
  }
  if (!remind_at || !isValidDate(remind_at)) {
    return res.status(400).json({ success: false, message: "A valid remind_at is required." });
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

    let userId = parsePositiveInt(user_id) || createdBy;
    if (user_id !== undefined && user_id !== null && user_id !== "" && !parsePositiveInt(user_id)) {
      return res.status(400).json({ success: false, message: "Invalid user_id." });
    }
    const userCheck = await pool.request().input("id", sql.Int, userId).query("SELECT id FROM Users WHERE id = @id");
    if (userCheck.recordset.length === 0) {
      return res.status(400).json({ success: false, message: "user_id does not exist." });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const insertResult = await transaction
      .request()
      .input("lead_id", sql.Int, leadId)
      .input("case_id", sql.Int, resolvedCaseId)
      .input("user_id", sql.Int, userId)
      .input("created_by", sql.Int, createdBy)
      .input("title", sql.NVarChar(255), title.trim())
      .input("description", sql.NVarChar(sql.MAX), description || null)
      .input("remind_at", sql.DateTime, new Date(remind_at))
      .input("priority", sql.VarChar(20), priority || "Medium")
      .input("remarks", sql.NVarChar(sql.MAX), remarks || null)
      .query(`
        INSERT INTO Reminders
          (lead_id, case_id, user_id, created_by, title, description, remind_at,
           priority, status, is_sent, remarks, created_at, updated_at)
        OUTPUT INSERTED.*
        VALUES
          (@lead_id, @case_id, @user_id, @created_by, @title, @description, @remind_at,
           @priority, 'Pending', 0, @remarks, GETDATE(), GETDATE())
      `);
    const createdReminder = insertResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId,
      caseId: resolvedCaseId,
      userId: createdBy,
      activityType: "REMINDER_CREATED",
      entityType: resolvedCaseId ? "CASE" : "LEAD",
      entityId: resolvedCaseId || leadId,
      oldValue: null,
      newValue: createdReminder.status,
      description: `Reminder "${createdReminder.title}" set for ${new Date(createdReminder.remind_at).toISOString()}.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(201).json({ success: true, message: "Reminder created successfully.", data: createdReminder });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[createReminder] Rollback failed:", rollbackErr);
      }
    }
    console.error("[createReminder] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to create reminder." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /:reminderId
//
// Also handles complete/dismiss/snooze: set status to Completed/Dismissed, or
// change remind_at (and optionally set status back to Pending) to snooze —
// changing remind_at always resets is_sent/sent_at so it can fire again.
// ---------------------------------------------------------------------------
export const updateReminder = async (req, res) => {
  const reminderId = parsePositiveInt(req.params.reminderId);
  if (!reminderId) {
    return res.status(400).json({ success: false, message: "A valid reminderId is required." });
  }

  const { title, description, remind_at, priority, remarks, user_id, status } = req.body || {};
  const changedBy = req.user?.id;

  if (status !== undefined && status !== null && !STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: `status must be one of: ${STATUSES.join(", ")}.` });
  }
  if (priority !== undefined && priority !== null && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ success: false, message: `priority must be one of: ${PRIORITIES.join(", ")}.` });
  }
  if (remind_at !== undefined && remind_at !== null && !isValidDate(remind_at)) {
    return res.status(400).json({ success: false, message: "Invalid remind_at." });
  }

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const existingResult = await pool
      .request()
      .input("reminder_id", sql.Int, reminderId)
      .query("SELECT * FROM Reminders WHERE reminder_id = @reminder_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Reminder not found." });
    }
    const existingReminder = existingResult.recordset[0];

    let userId = existingReminder.user_id;
    if (user_id !== undefined) {
      userId = parsePositiveInt(user_id);
      if (!userId) {
        return res.status(400).json({ success: false, message: "Invalid user_id." });
      }
      const userCheck = await pool.request().input("id", sql.Int, userId).query("SELECT id FROM Users WHERE id = @id");
      if (userCheck.recordset.length === 0) {
        return res.status(400).json({ success: false, message: "user_id does not exist." });
      }
    }

    const remindAtChanging = remind_at !== undefined && new Date(remind_at).getTime() !== new Date(existingReminder.remind_at).getTime();

    // completed_at follows status, but only moves when status is actually changing.
    let completedAtSql = "completed_at";
    if (status !== undefined && status !== existingReminder.status) {
      completedAtSql = status === "Completed" ? "GETDATE()" : "NULL";
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const updateResult = await transaction
      .request()
      .input("reminder_id", sql.Int, reminderId)
      .input("title", sql.NVarChar(255), title !== undefined ? title : existingReminder.title)
      .input("description", sql.NVarChar(sql.MAX), description !== undefined ? description : existingReminder.description)
      .input("remind_at", sql.DateTime, remind_at !== undefined ? new Date(remind_at) : existingReminder.remind_at)
      .input("user_id", sql.Int, userId)
      .input("priority", sql.VarChar(20), priority !== undefined ? priority : existingReminder.priority)
      .input("status", sql.VarChar(20), status !== undefined ? status : existingReminder.status)
      .input("remarks", sql.NVarChar(sql.MAX), remarks !== undefined ? remarks : existingReminder.remarks)
      .input("is_sent", sql.Bit, remindAtChanging ? 0 : existingReminder.is_sent)
      .query(`
        UPDATE Reminders
        SET
          title = @title,
          description = @description,
          remind_at = @remind_at,
          user_id = @user_id,
          priority = @priority,
          status = @status,
          remarks = @remarks,
          is_sent = @is_sent,
          sent_at = CASE WHEN @is_sent = 0 THEN NULL ELSE sent_at END,
          completed_at = ${completedAtSql},
          updated_at = GETDATE()
        OUTPUT INSERTED.*
        WHERE reminder_id = @reminder_id
      `);
    const updatedReminder = updateResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: existingReminder.lead_id,
      caseId: existingReminder.case_id,
      userId: changedBy,
      activityType: "REMINDER_UPDATED",
      entityType: existingReminder.case_id ? "CASE" : "LEAD",
      entityId: existingReminder.case_id || existingReminder.lead_id,
      oldValue: existingReminder.status,
      newValue: updatedReminder.status,
      description: `Reminder "${updatedReminder.title}" updated.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Reminder updated successfully.", data: updatedReminder });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[updateReminder] Rollback failed:", rollbackErr);
      }
    }
    console.error("[updateReminder] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update reminder." });
  }
};

// ---------------------------------------------------------------------------
// DELETE /:reminderId
// ---------------------------------------------------------------------------
export const deleteReminder = async (req, res) => {
  const reminderId = parsePositiveInt(req.params.reminderId);
  if (!reminderId) {
    return res.status(400).json({ success: false, message: "A valid reminderId is required." });
  }
  const changedBy = req.user?.id;

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const existingResult = await pool
      .request()
      .input("reminder_id", sql.Int, reminderId)
      .query("SELECT reminder_id, lead_id, case_id, title FROM Reminders WHERE reminder_id = @reminder_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Reminder not found." });
    }
    const existingReminder = existingResult.recordset[0];

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    await transaction.request().input("reminder_id", sql.Int, reminderId).query("DELETE FROM Reminders WHERE reminder_id = @reminder_id");

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: existingReminder.lead_id,
      caseId: existingReminder.case_id,
      userId: changedBy,
      activityType: "REMINDER_DELETED",
      entityType: existingReminder.case_id ? "CASE" : "LEAD",
      entityId: existingReminder.case_id || existingReminder.lead_id,
      oldValue: existingReminder.title,
      newValue: null,
      description: `Reminder "${existingReminder.title}" deleted.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Reminder deleted successfully." });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[deleteReminder] Rollback failed:", rollbackErr);
      }
    }
    console.error("[deleteReminder] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete reminder." });
  }
};
