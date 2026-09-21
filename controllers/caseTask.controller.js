import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";
import { getRequestInfo } from "../helpers/requestInfo.js";
import { parsePositiveInt, paginationParams } from "../helpers/parsers.js";
import { getCaseOrNull } from "../helpers/caseHelpers.js";

const PRIORITIES = ["Low", "Medium", "High", "Urgent"];

const getDefaultTaskStatus = async (executor) => {
  const result = await executor
    .request()
    .query("SELECT TOP 1 task_status_id, status_name FROM TaskStatuses WHERE is_active = 1 ORDER BY sort_order");
  return result.recordset[0] || null;
};

const getTaskStatusOrNull = async (executor, taskStatusId) => {
  const result = await executor
    .request()
    .input("task_status_id", sql.Int, taskStatusId)
    .query("SELECT task_status_id, status_name FROM TaskStatuses WHERE task_status_id = @task_status_id AND is_active = 1");
  return result.recordset[0] || null;
};

const getCaseStepOrNull = async (executor, caseId, caseStepId) => {
  const result = await executor
    .request()
    .input("case_id", sql.Int, caseId)
    .input("case_step_id", sql.Int, caseStepId)
    .query("SELECT case_step_id FROM CaseSteps WHERE case_step_id = @case_step_id AND case_id = @case_id");
  return result.recordset[0] || null;
};

const isValidDate = (value) => {
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
};

// ---------------------------------------------------------------------------
// GET /:caseId/tasks?case_step_id=&task_status_id=&assigned_to=
// ---------------------------------------------------------------------------
export const getCaseTasks = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }
  const { page, pageSize, offset } = paginationParams(req);

  const caseStepId = parsePositiveInt(req.query.case_step_id);
  const taskStatusId = parsePositiveInt(req.query.task_status_id);
  const assignedTo = parsePositiveInt(req.query.assigned_to);

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
        .input("case_step_id", sql.Int, caseStepId)
        .input("task_status_id", sql.Int, taskStatusId)
        .input("assigned_to", sql.Int, assignedTo);

    const [dataResult, countResult] = await Promise.all([
      buildRequest()
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize)
        .query(`
          SELECT
            t.task_id, t.case_id, t.case_step_id, t.task_name, t.task_description,
            t.task_status_id, ts.status_name, t.assigned_to, u.name AS assigned_user_name,
            t.priority, t.due_date, t.started_at, t.completed_at, t.remarks,
            t.created_at, t.updated_at
          FROM CaseTasks t
          INNER JOIN TaskStatuses ts ON ts.task_status_id = t.task_status_id
          LEFT JOIN Users u ON u.id = t.assigned_to
          WHERE t.case_id = @case_id
            AND (@case_step_id IS NULL OR t.case_step_id = @case_step_id)
            AND (@task_status_id IS NULL OR t.task_status_id = @task_status_id)
            AND (@assigned_to IS NULL OR t.assigned_to = @assigned_to)
          ORDER BY t.due_date ASC, t.created_at DESC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      buildRequest().query(`
        SELECT COUNT(*) AS total
        FROM CaseTasks t
        WHERE t.case_id = @case_id
          AND (@case_step_id IS NULL OR t.case_step_id = @case_step_id)
          AND (@task_status_id IS NULL OR t.task_status_id = @task_status_id)
          AND (@assigned_to IS NULL OR t.assigned_to = @assigned_to);
      `),
    ]);

    return res.status(200).json({
      success: true,
      caseId,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      tasks: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getCaseTasks] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch case tasks." });
  }
};

// ---------------------------------------------------------------------------
// GET /:caseId/tasks/:taskId
// ---------------------------------------------------------------------------
export const getCaseTaskById = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  const taskId = parsePositiveInt(req.params.taskId);
  if (!caseId || !taskId) {
    return res.status(400).json({ success: false, message: "A valid caseId and taskId are required." });
  }

  try {
    const pool = await poolPromise;

    const result = await pool
      .request()
      .input("case_id", sql.Int, caseId)
      .input("task_id", sql.Int, taskId)
      .query(`
        SELECT
          t.task_id, t.case_id, t.case_step_id, t.task_name, t.task_description,
          t.task_status_id, ts.status_name, t.assigned_to, u.name AS assigned_user_name,
          t.priority, t.due_date, t.started_at, t.completed_at, t.remarks,
          t.created_at, t.updated_at
        FROM CaseTasks t
        INNER JOIN TaskStatuses ts ON ts.task_status_id = t.task_status_id
        LEFT JOIN Users u ON u.id = t.assigned_to
        WHERE t.task_id = @task_id AND t.case_id = @case_id
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Task not found for this case." });
    }

    return res.status(200).json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error("[getCaseTaskById] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch task." });
  }
};

// ---------------------------------------------------------------------------
// POST /:caseId/tasks
// ---------------------------------------------------------------------------
export const createCaseTask = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }

  const {
    case_step_id,
    task_name,
    task_description,
    task_status_id,
    assigned_to,
    priority,
    due_date,
    remarks,
  } = req.body || {};
  const createdBy = req.user?.id;

  if (!task_name || !String(task_name).trim()) {
    return res.status(400).json({ success: false, message: "task_name is required." });
  }
  if (priority !== undefined && priority !== null && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ success: false, message: `priority must be one of: ${PRIORITIES.join(", ")}.` });
  }
  if (due_date !== undefined && due_date !== null && due_date !== "" && !isValidDate(due_date)) {
    return res.status(400).json({ success: false, message: "Invalid due_date." });
  }

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const caseRow = await getCaseOrNull(pool, caseId);
    if (!caseRow) {
      return res.status(404).json({ success: false, message: "Immigration case not found." });
    }
    if (caseRow.closed_at) {
      return res.status(400).json({ success: false, message: "Cannot create tasks on a closed case." });
    }

    let caseStepId = parsePositiveInt(case_step_id);
    if (case_step_id !== undefined && case_step_id !== null && case_step_id !== "" && !caseStepId) {
      return res.status(400).json({ success: false, message: "Invalid case_step_id." });
    }
    if (caseStepId) {
      const step = await getCaseStepOrNull(pool, caseId, caseStepId);
      if (!step) {
        return res.status(400).json({ success: false, message: "case_step_id does not belong to this case." });
      }
    }

    let taskStatusId = parsePositiveInt(task_status_id);
    if (task_status_id !== undefined && task_status_id !== null && task_status_id !== "" && !taskStatusId) {
      return res.status(400).json({ success: false, message: "Invalid task_status_id." });
    }
    let resolvedStatus;
    if (taskStatusId) {
      resolvedStatus = await getTaskStatusOrNull(pool, taskStatusId);
      if (!resolvedStatus) {
        return res.status(400).json({ success: false, message: "task_status_id does not exist or is inactive." });
      }
    } else {
      resolvedStatus = await getDefaultTaskStatus(pool);
      if (!resolvedStatus) {
        return res.status(400).json({ success: false, message: "No active TaskStatuses are configured." });
      }
      taskStatusId = resolvedStatus.task_status_id;
    }

    let assignedTo = parsePositiveInt(assigned_to);
    if (assigned_to !== undefined && assigned_to !== null && assigned_to !== "" && !assignedTo) {
      return res.status(400).json({ success: false, message: "Invalid assigned_to." });
    }
    if (assignedTo) {
      const userCheck = await pool.request().input("id", sql.Int, assignedTo).query("SELECT id FROM Users WHERE id = @id");
      if (userCheck.recordset.length === 0) {
        return res.status(400).json({ success: false, message: "assigned_to user does not exist." });
      }
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const isCompleted = resolvedStatus.status_name.toLowerCase() === "completed";
    const isInProgress = resolvedStatus.status_name.toLowerCase() === "in progress";

    const insertResult = await transaction
      .request()
      .input("case_id", sql.Int, caseId)
      .input("case_step_id", sql.Int, caseStepId)
      .input("task_name", sql.NVarChar(255), task_name.trim())
      .input("task_description", sql.NVarChar(sql.MAX), task_description || null)
      .input("task_status_id", sql.Int, taskStatusId)
      .input("assigned_to", sql.Int, assignedTo)
      .input("priority", sql.VarChar(20), priority || "Medium")
      .input("due_date", sql.DateTime, due_date ? new Date(due_date) : null)
      .input("remarks", sql.NVarChar(sql.MAX), remarks || null)
      .query(`
        INSERT INTO CaseTasks
          (case_id, case_step_id, task_name, task_description, task_status_id, assigned_to,
           priority, due_date, started_at, completed_at, remarks, created_at, updated_at)
        OUTPUT INSERTED.*
        VALUES
          (@case_id, @case_step_id, @task_name, @task_description, @task_status_id, @assigned_to,
           @priority, @due_date, ${isCompleted || isInProgress ? "GETDATE()" : "NULL"}, ${isCompleted ? "GETDATE()" : "NULL"},
           @remarks, GETDATE(), GETDATE())
      `);
    const createdTask = insertResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: createdBy,
      activityType: "TASK_CREATED",
      entityType: "CASE_TASK",
      entityId: createdTask.task_id,
      oldValue: null,
      newValue: resolvedStatus.status_name,
      description: `Task "${createdTask.task_name}" created.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(201).json({ success: true, message: "Task created successfully.", data: createdTask });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[createCaseTask] Rollback failed:", rollbackErr);
      }
    }
    console.error("[createCaseTask] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to create task." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /:caseId/tasks/:taskId
// ---------------------------------------------------------------------------
export const updateCaseTask = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  const taskId = parsePositiveInt(req.params.taskId);
  if (!caseId || !taskId) {
    return res.status(400).json({ success: false, message: "A valid caseId and taskId are required." });
  }

  const {
    case_step_id,
    task_name,
    task_description,
    task_status_id,
    assigned_to,
    priority,
    due_date,
    remarks,
  } = req.body || {};
  const changedBy = req.user?.id;

  if (priority !== undefined && priority !== null && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ success: false, message: `priority must be one of: ${PRIORITIES.join(", ")}.` });
  }
  if (due_date !== undefined && due_date !== null && due_date !== "" && !isValidDate(due_date)) {
    return res.status(400).json({ success: false, message: "Invalid due_date." });
  }

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const caseRow = await getCaseOrNull(pool, caseId);
    if (!caseRow) {
      return res.status(404).json({ success: false, message: "Immigration case not found." });
    }
    if (caseRow.closed_at) {
      return res.status(400).json({ success: false, message: "Cannot update tasks on a closed case." });
    }

    const existingResult = await pool
      .request()
      .input("task_id", sql.Int, taskId)
      .input("case_id", sql.Int, caseId)
      .query("SELECT * FROM CaseTasks WHERE task_id = @task_id AND case_id = @case_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Task not found for this case." });
    }
    const existingTask = existingResult.recordset[0];

    let caseStepId = existingTask.case_step_id;
    if (case_step_id !== undefined) {
      caseStepId = parsePositiveInt(case_step_id);
      if (case_step_id !== null && case_step_id !== "" && !caseStepId) {
        return res.status(400).json({ success: false, message: "Invalid case_step_id." });
      }
      if (caseStepId) {
        const step = await getCaseStepOrNull(pool, caseId, caseStepId);
        if (!step) {
          return res.status(400).json({ success: false, message: "case_step_id does not belong to this case." });
        }
      }
    }

    let taskStatusId = existingTask.task_status_id;
    let resolvedStatus = null;
    if (task_status_id !== undefined && task_status_id !== null && task_status_id !== "") {
      taskStatusId = parsePositiveInt(task_status_id);
      if (!taskStatusId) {
        return res.status(400).json({ success: false, message: "Invalid task_status_id." });
      }
      resolvedStatus = await getTaskStatusOrNull(pool, taskStatusId);
      if (!resolvedStatus) {
        return res.status(400).json({ success: false, message: "task_status_id does not exist or is inactive." });
      }
    }

    let assignedTo = existingTask.assigned_to;
    if (assigned_to !== undefined) {
      assignedTo = parsePositiveInt(assigned_to);
      if (assigned_to !== null && assigned_to !== "" && !assignedTo) {
        return res.status(400).json({ success: false, message: "Invalid assigned_to." });
      }
      if (assignedTo) {
        const userCheck = await pool.request().input("id", sql.Int, assignedTo).query("SELECT id FROM Users WHERE id = @id");
        if (userCheck.recordset.length === 0) {
          return res.status(400).json({ success: false, message: "assigned_to user does not exist." });
        }
      }
    }

    // started_at / completed_at only move when the status is actually changing.
    let startedAtSql = "started_at";
    let completedAtSql = "completed_at";
    if (resolvedStatus) {
      const statusName = resolvedStatus.status_name.toLowerCase();
      if (statusName === "completed") {
        completedAtSql = "GETDATE()";
      } else {
        completedAtSql = "NULL";
        if (statusName === "in progress") {
          startedAtSql = "COALESCE(started_at, GETDATE())";
        }
      }
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const updateResult = await transaction
      .request()
      .input("task_id", sql.Int, taskId)
      .input("case_step_id", sql.Int, caseStepId)
      .input("task_name", sql.NVarChar(255), task_name !== undefined ? String(task_name).trim() : existingTask.task_name)
      .input("task_description", sql.NVarChar(sql.MAX), task_description !== undefined ? task_description : existingTask.task_description)
      .input("task_status_id", sql.Int, taskStatusId)
      .input("assigned_to", sql.Int, assignedTo)
      .input("priority", sql.VarChar(20), priority !== undefined ? priority : existingTask.priority)
      .input("due_date", sql.DateTime, due_date !== undefined ? (due_date ? new Date(due_date) : null) : existingTask.due_date)
      .input("remarks", sql.NVarChar(sql.MAX), remarks !== undefined ? remarks : existingTask.remarks)
      .query(`
        UPDATE CaseTasks
        SET
          case_step_id = @case_step_id,
          task_name = @task_name,
          task_description = @task_description,
          task_status_id = @task_status_id,
          assigned_to = @assigned_to,
          priority = @priority,
          due_date = @due_date,
          remarks = @remarks,
          started_at = ${startedAtSql},
          completed_at = ${completedAtSql},
          updated_at = GETDATE()
        OUTPUT INSERTED.*
        WHERE task_id = @task_id
      `);
    const updatedTask = updateResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: changedBy,
      activityType: "TASK_UPDATED",
      entityType: "CASE_TASK",
      entityId: taskId,
      oldValue: JSON.stringify({ task_status_id: existingTask.task_status_id, assigned_to: existingTask.assigned_to }),
      newValue: JSON.stringify({ task_status_id: updatedTask.task_status_id, assigned_to: updatedTask.assigned_to }),
      description: `Task "${updatedTask.task_name}" updated.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Task updated successfully.", data: updatedTask });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[updateCaseTask] Rollback failed:", rollbackErr);
      }
    }
    console.error("[updateCaseTask] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update task." });
  }
};

// ---------------------------------------------------------------------------
// DELETE /:caseId/tasks/:taskId
// ---------------------------------------------------------------------------
export const deleteCaseTask = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  const taskId = parsePositiveInt(req.params.taskId);
  if (!caseId || !taskId) {
    return res.status(400).json({ success: false, message: "A valid caseId and taskId are required." });
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

    const existingResult = await pool
      .request()
      .input("task_id", sql.Int, taskId)
      .input("case_id", sql.Int, caseId)
      .query("SELECT task_id, task_name FROM CaseTasks WHERE task_id = @task_id AND case_id = @case_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Task not found for this case." });
    }
    const existingTask = existingResult.recordset[0];

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    await transaction.request().input("task_id", sql.Int, taskId).query("DELETE FROM CaseTasks WHERE task_id = @task_id");

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: changedBy,
      activityType: "TASK_DELETED",
      entityType: "CASE_TASK",
      entityId: taskId,
      oldValue: existingTask.task_name,
      newValue: null,
      description: `Task "${existingTask.task_name}" deleted.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Task deleted successfully." });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[deleteCaseTask] Rollback failed:", rollbackErr);
      }
    }
    console.error("[deleteCaseTask] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete task." });
  }
};
