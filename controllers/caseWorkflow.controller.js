import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";
import { getRequestInfo } from "../helpers/requestInfo.js";
import { parsePositiveInt, paginationParams } from "../helpers/parsers.js";
import { getCaseOrNull } from "../helpers/caseHelpers.js";

// Case-level stage status and step status share the same vocabulary.
// NOTE: this must stay in sync with the values written by leads.controller.js
// during lead -> case conversion ("In Progress" / "Pending" / "Completed").
const STAGE_STEP_STATUSES = ["Pending", "In Progress", "Completed"];

// "Current" stage = the open one (completed_at IS NULL) if any, otherwise the
// most recently started one. Mirrors the CTE used in immigrationPipeline.controller.js.
const getCurrentStage = async (executor, caseId) => {
  const result = await executor
    .request()
    .input("case_id", sql.Int, caseId)
    .query(`
      SELECT TOP 1
        cs.case_stage_id, cs.case_id, cs.stage_id, cs.status,
        cs.assigned_to, cs.started_at, cs.completed_at, cs.remarks,
        cs.created_at, cs.updated_at,
        ws.stage_code, ws.stage_name, ws.stage_no, ws.department, ws.program_id
      FROM CaseStages cs
      INNER JOIN WorkflowStages ws ON ws.stage_id = cs.stage_id
      WHERE cs.case_id = @case_id
      ORDER BY
        CASE WHEN cs.completed_at IS NULL THEN 0 ELSE 1 END,
        cs.started_at DESC
    `);
  return result.recordset[0] || null;
};

// Steps that are "current" for a given stage: one row per workflow_step_id
// (the latest attempt), the same "latest row per key" pattern used for stages.
const getCurrentStepsForStage = async (executor, caseId, stageId) => {
  const result = await executor
    .request()
    .input("case_id", sql.Int, caseId)
    .input("stage_id", sql.Int, stageId)
    .query(`
      WITH CurrentCaseStep AS (
        SELECT
          cst.*,
          ROW_NUMBER() OVER (
            PARTITION BY cst.case_id, cst.workflow_step_id
            ORDER BY
              CASE WHEN cst.completed_at IS NULL THEN 0 ELSE 1 END,
              cst.started_at DESC,
              cst.case_step_id DESC
          ) AS rn
        FROM CaseSteps cst
      )
      SELECT
        wst.workflow_step_id, wst.step_code, wst.step_name,
        wst.department, wst.sort_order,
        ccs.case_step_id, ccs.step_status, ccs.assigned_to,
        ccs.started_at, ccs.completed_at, ccs.remarks
      FROM WorkflowSteps wst
      LEFT JOIN CurrentCaseStep ccs
             ON ccs.workflow_step_id = wst.workflow_step_id
            AND ccs.case_id = @case_id
            AND ccs.rn = 1
      WHERE wst.stage_id = @stage_id
        AND wst.is_active = 1
      ORDER BY wst.sort_order;
    `);
  return result.recordset;
};

// ---------------------------------------------------------------------------
// GET /:caseId/stages — full stage history for a case
// ---------------------------------------------------------------------------
export const getCaseStageHistory = async (req, res) => {
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
        SELECT
          cs.case_stage_id, cs.stage_id, cs.status, cs.assigned_to,
          cs.started_at, cs.completed_at, cs.remarks, cs.created_at, cs.updated_at,
          ws.stage_code, ws.stage_name, ws.stage_no, ws.department,
          u.name AS assigned_user_name
        FROM CaseStages cs
        INNER JOIN WorkflowStages ws ON ws.stage_id = cs.stage_id
        LEFT JOIN Users u ON u.id = cs.assigned_to
        WHERE cs.case_id = @case_id
        ORDER BY cs.started_at ASC, cs.case_stage_id ASC;
      `);

    return res.status(200).json({ success: true, caseId, stages: result.recordset });
  } catch (err) {
    console.error("[getCaseStageHistory] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch case stage history." });
  }
};

// ---------------------------------------------------------------------------
// GET /:caseId/stages/current — current stage + its steps
// ---------------------------------------------------------------------------
export const getCurrentCaseStage = async (req, res) => {
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

    const currentStage = await getCurrentStage(pool, caseId);
    if (!currentStage) {
      return res.status(404).json({ success: false, message: "This case has no stage history yet." });
    }

    const steps = await getCurrentStepsForStage(pool, caseId, currentStage.stage_id);

    return res.status(200).json({ success: true, caseId, stage: currentStage, steps });
  } catch (err) {
    console.error("[getCurrentCaseStage] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch current case stage." });
  }
};

// ---------------------------------------------------------------------------
// GET /:caseId/transitions — available WorkflowTransitions from the current stage
// ---------------------------------------------------------------------------
export const getAvailableTransitions = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }

  const { from_stage_id, from_step_id } = req.body || {};

  const fromStageId = parsePositiveInt(from_stage_id);
  if (!fromStageId) {
    return res.status(400).json({ success: false, message: "A valid from_stage_id is required." });
  }

  let fromStepId = null;
  if (from_step_id !== undefined && from_step_id !== null && from_step_id !== "") {
    fromStepId = parsePositiveInt(from_step_id);
    if (!fromStepId) {
      return res.status(400).json({ success: false, message: "Invalid from_step_id." });
    }
  }

  try {
    const pool = await poolPromise;

    const caseRow = await getCaseOrNull(pool, caseId);
    if (!caseRow) {
      return res.status(404).json({ success: false, message: "Immigration case not found." });
    }

    // Exact match on both columns, driven entirely by what the caller passed:
    // from_step_id omitted -> only stage-level rules (from_step_id IS NULL);
    // from_step_id given -> only rules scoped to that exact step.
    const result = await pool
      .request()
      .input("from_stage_id", sql.Int, fromStageId)
      // .input("from_step_id", sql.Int, fromStepId)
      .query(`
        SELECT
          wt.transition_id, wt.condition_code, wt.condition_value, wt.transition_name,
          wt.from_stage_id, wt.from_step_id, wt.to_stage_id,
          toStage.stage_code AS to_stage_code, toStage.stage_name AS to_stage_name,
          wt.to_step_id
        FROM WorkflowTransitions wt
        INNER JOIN WorkflowStages toStage ON toStage.stage_id = wt.to_stage_id
        WHERE wt.from_stage_id = @from_stage_id
          
          AND wt.is_active = 1
        ORDER BY wt.transition_id;
      `);

      // AND (
      //       wt.from_step_id = @from_step_id
      //       OR (wt.from_step_id IS NULL AND @from_step_id IS NULL)
      //     )
    
    
    const transitStep = result.recordset.reduce((t) => t.from_step_id === fromStepId);


    const isTransit = result.recordset.length > 0;

    return res.status(200).json({
      success: true,
      caseId,
      fromStageId,
      transitStep,
      transitions: result.recordset,
      isTransit,
    });
  } catch (err) {
    console.error("[getAvailableTransitions] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch available transitions." });
  }
};

// ---------------------------------------------------------------------------
// POST /:caseId/stages/advance — move a case to a new stage
//
// Body: { stage_id } OR { condition_code, condition_value } to resolve the
// target via WorkflowTransitions from the case's current stage, plus
// optional { assigned_to, remarks }.
// ---------------------------------------------------------------------------
export const advanceCaseStage = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }

  const { stage_id, condition_code, condition_value, assigned_to, remarks, participant_role } = req.body || {};
  const changedBy = req.user?.id;
  const participantRole = participant_role || "Primary Case Officer";

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const caseRow = await getCaseOrNull(pool, caseId);
    if (!caseRow) {
      return res.status(404).json({ success: false, message: "Immigration case not found." });
    }
    if (caseRow.closed_at) {
      return res.status(400).json({ success: false, message: "Cannot change the stage of a closed case." });
    }

    const currentStage = await getCurrentStage(pool, caseId);

    // Resolve the target stage: explicit stage_id takes precedence over a
    // condition-based lookup against WorkflowTransitions.
    let targetStageId = parsePositiveInt(stage_id);

    if (!targetStageId) {
      if (!condition_code || !condition_value) {
        return res.status(400).json({
          success: false,
          message: "Either stage_id, or both condition_code and condition_value, are required.",
        });
      }
      if (!currentStage) {
        return res.status(400).json({
          success: false,
          message: "Case has no current stage to resolve a transition from.",
        });
      }

      const transitionResult = await pool
        .request()
        .input("from_stage_id", sql.Int, currentStage.stage_id)
        .input("condition_code", sql.VarChar(100), condition_code)
        .input("condition_value", sql.VarChar(100), condition_value)
        .query(`
          SELECT TOP 1 to_stage_id
          FROM WorkflowTransitions
          WHERE from_stage_id = @from_stage_id
            AND condition_code = @condition_code
            AND condition_value = @condition_value
            AND is_active = 1
          ORDER BY transition_id;
        `);

      if (transitionResult.recordset.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No matching transition rule found for the given condition.",
        });
      }

      targetStageId = transitionResult.recordset[0].to_stage_id;
    }

    const targetStageResult = await pool
      .request()
      .input("stage_id", sql.Int, targetStageId)
      .input("program_id", sql.Int, caseRow.program_id)
      .query(`
        SELECT stage_id, stage_code, stage_name, stage_no, department, program_id
        FROM WorkflowStages
        WHERE stage_id = @stage_id AND program_id = @program_id AND is_active = 1
      `);

    if (targetStageResult.recordset.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Target stage does not exist, is inactive, or does not belong to this case's program.",
      });
    }
    const targetStage = targetStageResult.recordset[0];

    if (currentStage && currentStage.stage_id === targetStage.stage_id && !currentStage.completed_at) {
      return res.status(400).json({ success: false, message: "Case is already in this stage." });
    }

    let assignedTo = parsePositiveInt(assigned_to);
    if (assigned_to !== undefined && assigned_to !== null && assigned_to !== "" && !assignedTo) {
      return res.status(400).json({ success: false, message: "Invalid assigned_to." });
    }
    // Only an explicitly-provided assigned_to should be treated as a case
    // reassignment (and logged to CaseAssignmentHistory) — the carried-over
    // fallback below is not a reassignment.
    const assignedToProvided = assignedTo !== null;
    if (!assignedTo) {
      assignedTo = currentStage?.assigned_to || caseRow.assigned_to || null;
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

    if (currentStage && !currentStage.completed_at) {
      await transaction
        .request()
        .input("case_stage_id", sql.Int, currentStage.case_stage_id)
        .query(`
          UPDATE CaseStages
          SET status = 'Completed', completed_at = GETDATE(), updated_at = GETDATE()
          WHERE case_stage_id = @case_stage_id
        `);
    }

    const newStageResult = await transaction
      .request()
      .input("case_id", sql.Int, caseId)
      .input("stage_id", sql.Int, targetStage.stage_id)
      .input("status", sql.VarChar(50), "In Progress")
      .input("assigned_to", sql.Int, assignedTo)
      .input("remarks", sql.NVarChar(sql.MAX), remarks || null)
      .query(`
        INSERT INTO CaseStages (case_id, stage_id, status, assigned_to, started_at, remarks)
        OUTPUT INSERTED.case_stage_id, INSERTED.case_id, INSERTED.stage_id, INSERTED.status,
               INSERTED.assigned_to, INSERTED.started_at, INSERTED.remarks
        VALUES (@case_id, @stage_id, @status, @assigned_to, GETDATE(), @remarks)
      `);
    const newStage = newStageResult.recordset[0];

    const workflowSteps = (
      await transaction
        .request()
        .input("stage_id", sql.Int, targetStage.stage_id)
        .query(`
          SELECT workflow_step_id, step_code, step_name, sort_order
          FROM WorkflowSteps
          WHERE stage_id = @stage_id AND is_active = 1
          ORDER BY sort_order;
        `)
    ).recordset;

    for (let index = 0; index < workflowSteps.length; index++) {
      const step = workflowSteps[index];
      const stepStatus = index === 0 ? "In Progress" : "Pending";

      await transaction
        .request()
        .input("case_id", sql.Int, caseId)
        .input("workflow_step_id", sql.Int, step.workflow_step_id)
        .input("step_status", sql.VarChar(50), stepStatus)
        .input("assigned_to", sql.Int, assignedTo)
        .query(`
          INSERT INTO CaseSteps (case_id, workflow_step_id, step_status, assigned_to, started_at)
          VALUES (@case_id, @workflow_step_id, @step_status,  @assigned_to, ${index === 0 ? "GETDATE()" : "NULL"})
        `);
    }

    // An explicit assigned_to that differs from the case's current owner is a
    // real case-level reassignment — keep ImmigrationCases.assigned_to in
    // sync and log it, same as assignCase() does.
    if (assignedToProvided && assignedTo !== caseRow.assigned_to) {
      await transaction
        .request()
        .input("case_id", sql.Int, caseId)
        .input("assigned_to", sql.Int, assignedTo)
        .query("UPDATE ImmigrationCases SET assigned_to = @assigned_to, updated_at = GETDATE() WHERE case_id = @case_id");

      await transaction
        .request()
        .input("case_id", sql.Int, caseId)
        .input("old_user_id", sql.Int, caseRow.assigned_to)
        .input("new_user_id", sql.Int, assignedTo)
        .input("assigned_by", sql.Int, changedBy)
        .input("remarks", sql.NVarChar(sql.MAX), remarks || `Reassigned while advancing to stage "${targetStage.stage_name}".`)
        .query(`
          INSERT INTO CaseAssignmentHistory (case_id, old_user_id, new_user_id, assigned_by, remarks, assigned_at)
          VALUES (@case_id, @old_user_id, @new_user_id, @assigned_by, @remarks, GETDATE())
        `);

      await transaction
        .request()
        .input("case_id", sql.Int, caseId)
        .input("participant_role", sql.VarChar(50), participantRole)
        .query(`
          UPDATE CaseParticipants
          SET is_active = 0, assigned_until = GETDATE()
          WHERE case_id = @case_id AND participant_role = @participant_role AND is_active = 1
        `);

      await transaction
        .request()
        .input("case_id", sql.Int, caseId)
        .input("user_id", sql.Int, assignedTo)
        .input("participant_role", sql.VarChar(50), participantRole)
        .query(`
          INSERT INTO CaseParticipants (case_id, user_id, participant_role, assigned_from, is_active, created_at)
          VALUES (@case_id, @user_id, @participant_role, GETDATE(), 1, GETDATE())
        `);
    }

    await transaction
      .request()
      .input("lead_id", sql.Int, caseRow.lead_id)
      .input("case_id", sql.Int, caseId)
      .input("case_stage_id", sql.Int, newStage.case_stage_id)
      .input("entity_type", sql.VarChar(50), "STAGE")
      .input("old_status", sql.VarChar(100), currentStage ? currentStage.stage_name : null)
      .input("new_status", sql.VarChar(100), targetStage.stage_name)
      .input("changed_by", sql.Int, changedBy)
      .input("remarks", sql.NVarChar(sql.MAX), remarks || "Stage advanced.")
      .query(`
        INSERT INTO StatusHistory (lead_id, case_id, case_stage_id, entity_type, old_status, new_status, changed_by, remarks, changed_at)
        VALUES (@lead_id, @case_id, @case_stage_id, @entity_type, @old_status, @new_status, @changed_by, @remarks, GETDATE())
      `);

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: changedBy,
      activityType: "STAGE_ADVANCED",
      entityType: "CASE",
      entityId: caseId,
      oldValue: currentStage ? currentStage.stage_name : null,
      newValue: targetStage.stage_name,
      description: `Case moved from "${currentStage ? currentStage.stage_name : "no stage"}" to "${targetStage.stage_name}".`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({
      success: true,
      message: "Case stage advanced successfully.",
      data: { caseId, stage: newStage, steps_created: workflowSteps.length },
    });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[advanceCaseStage] Rollback failed:", rollbackErr);
      }
    }
    console.error("[advanceCaseStage] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to advance case stage." });
  }
};

// ---------------------------------------------------------------------------
// GET /:caseId/steps?stageId= — steps for the current stage, or a given one
// ---------------------------------------------------------------------------
export const getCaseSteps = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  const stageIdQuery = req.query.stageId;
  console.log("stageIdQuery:", stageIdQuery);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }

  try {
    const pool = await poolPromise;

    const caseRow = await getCaseOrNull(pool, caseId);
    if (!caseRow) {
      return res.status(404).json({ success: false, message: "Immigration case not found." });
    }

    let stageId = parsePositiveInt(req.query.stageId);

    if (!stageId) {
      const currentStage = await getCurrentStage(pool, caseId);
      if (!currentStage) {
        return res.status(404).json({ success: false, message: "This case has no stage history yet." });
      }
      stageId = currentStage.stage_id;
    } else {
      const stageCheck = await pool
        .request()
        .input("stage_id", sql.Int, stageId)
        .input("program_id", sql.Int, caseRow.program_id)
        .query("SELECT stage_id FROM WorkflowStages WHERE stage_id = @stage_id AND program_id = @program_id");
      if (stageCheck.recordset.length === 0) {
        return res.status(400).json({ success: false, message: "stageId does not belong to this case's program." });
      }
    }

    const steps = await getCurrentStepsForStage(pool, caseId, stageId);

    return res.status(200).json({ success: true, caseId, stageId, steps });
  } catch (err) {
    console.error("[getCaseSteps] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch case steps." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /:caseId/steps/:caseStepId — update a step's status
// ---------------------------------------------------------------------------
export const updateCaseStepStatus = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  const caseStepId = parsePositiveInt(req.params.caseStepId);
  const { step_status, remarks } = req.body || {};
  const changedBy = req.user?.id;

  if (!caseId || !caseStepId) {
    return res.status(400).json({ success: false, message: "A valid caseId and caseStepId are required." });
  }
  if (!STAGE_STEP_STATUSES.includes(step_status)) {
    return res.status(400).json({
      success: false,
      message: `step_status must be one of: ${STAGE_STEP_STATUSES.join(", ")}.`,
    });
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
      return res.status(400).json({ success: false, message: "Cannot change steps on a closed case." });
    }

    const stepResult = await pool
      .request()
      .input("case_step_id", sql.Int, caseStepId)
      .input("case_id", sql.Int, caseId)
      .query(`
        SELECT cst.case_step_id, cst.case_id, cst.workflow_step_id, cst.step_status,
               ws.stage_id
        FROM CaseSteps cst
        INNER JOIN WorkflowSteps ws ON ws.workflow_step_id = cst.workflow_step_id
        WHERE cst.case_step_id = @case_step_id AND cst.case_id = @case_id
      `);
    if (stepResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Case step not found for this case." });
    }
    const existingStep = stepResult.recordset[0];

    if (existingStep.step_status === step_status) {
      return res.status(400).json({ success: false, message: `Step is already ${step_status}.` });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const updatedStepResult = await transaction
      .request()
      .input("case_step_id", sql.Int, caseStepId)
      .input("step_status", sql.VarChar(50), step_status)
      .input("remarks", sql.NVarChar(sql.MAX), remarks ?? null)
      .query(`
        UPDATE CaseSteps
        SET
          step_status = @step_status,
          remarks = COALESCE(@remarks, remarks),
          started_at = CASE WHEN @step_status = 'In Progress' AND started_at IS NULL THEN GETDATE() ELSE started_at END,
          completed_at = CASE WHEN @step_status = 'Completed' THEN GETDATE() ELSE NULL END,
          updated_at = GETDATE()
        OUTPUT INSERTED.case_step_id, INSERTED.step_status, INSERTED.started_at, INSERTED.completed_at
        WHERE case_step_id = @case_step_id
      `);
    const updatedStep = updatedStepResult.recordset[0];

    // Fetched once and reused below for the auto-complete check too, instead
    // of querying "current stage" twice.
    const currentStage = await getCurrentStage(transaction, caseId);
    
    await transaction
      .request()
      .input("lead_id", sql.Int, caseRow.lead_id)
      .input("case_id", sql.Int, caseId)
      .input("case_stage_id", sql.Int, currentStage ? currentStage.case_stage_id : null)
      .input("case_step_id", sql.Int, caseStepId)
      .input("entity_type", sql.VarChar(50), "STEP")
      .input("old_status", sql.VarChar(100), existingStep.step_status)
      .input("new_status", sql.VarChar(100), step_status)
      .input("changed_by", sql.Int, changedBy)
      .input("remarks", sql.NVarChar(sql.MAX), remarks || null)
      .query(`
        INSERT INTO StatusHistory (lead_id, case_id, case_stage_id, case_step_id, entity_type, old_status, new_status, changed_by, remarks, changed_at)
        VALUES (@lead_id, @case_id, @case_stage_id, @case_step_id, @entity_type, @old_status, @new_status, @changed_by, @remarks, GETDATE())
      `);

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: changedBy,
      activityType: "STEP_STATUS_CHANGED",
      entityType: "CASE_STEP",
      entityId: caseStepId,
      oldValue: existingStep.step_status,
      newValue: step_status,
      description: `Step ${caseStepId} changed from "${existingStep.step_status}" to "${step_status}".`,
      ipAddress,
      userAgent,
    });

    // Auto-complete the parent stage once every one of its current steps is Completed.
    let stageAutoCompleted = false;

    if (step_status === "Completed") {
      if (currentStage && currentStage.stage_id === existingStep.stage_id && !currentStage.completed_at) {
        const remainingSteps = await getCurrentStepsForStage(transaction, caseId, existingStep.stage_id);
        const allCompleted = remainingSteps.every((s) => s.step_status === "Completed");

        if (allCompleted) {
          await transaction
            .request()
            .input("case_stage_id", sql.Int, currentStage.case_stage_id)
            .query(`
              UPDATE CaseStages
              SET status = 'Completed', completed_at = GETDATE(), updated_at = GETDATE()
              WHERE case_stage_id = @case_stage_id
            `);

          await transaction
            .request()
            .input("lead_id", sql.Int, caseRow.lead_id)
            .input("case_id", sql.Int, caseId)
            .input("case_stage_id", sql.Int, currentStage.case_stage_id)
            .input("entity_type", sql.VarChar(50), "STAGE")
            .input("old_status", sql.VarChar(100), currentStage.status)
            .input("new_status", sql.VarChar(100), "Completed")
            .input("changed_by", sql.Int, changedBy)
            .input("remarks", sql.NVarChar(sql.MAX), "Auto-completed: all steps in this stage are complete.")
            .query(`
              INSERT INTO StatusHistory (lead_id, case_id, case_stage_id, entity_type, old_status, new_status, changed_by, remarks, changed_at)
              VALUES (@lead_id, @case_id, @case_stage_id, @entity_type, @old_status, @new_status, @changed_by, @remarks, GETDATE())
            `);

          await createActivityLog({
            transaction,
            leadId: caseRow.lead_id,
            caseId,
            userId: changedBy,
            activityType: "STAGE_AUTO_COMPLETED",
            entityType: "CASE",
            entityId: caseId,
            oldValue: currentStage.status,
            newValue: "Completed",
            description: `Stage "${currentStage.stage_name}" auto-completed after all its steps finished.`,
            ipAddress,
            userAgent,
          });

          stageAutoCompleted = true;
        }
      }
    }

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({
      success: true,
      message: "Case step updated successfully.",
      data: { ...updatedStep, stageAutoCompleted },
    });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[updateCaseStepStatus] Rollback failed:", rollbackErr);
      }
    }
    console.error("[updateCaseStepStatus] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update case step." });
  }
};

// ---------------------------------------------------------------------------
// POST /:caseId/assign — reassign the case's primary owner
// ---------------------------------------------------------------------------
export const assignCase = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  const assignedTo = parsePositiveInt(req.body?.assigned_to);
  const remarks = req.body?.remarks || null;
  const participantRole = req.body?.participant_role || "Primary Case Officer";
  const changedBy = req.user?.id;

  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }
  if (!assignedTo) {
    return res.status(400).json({ success: false, message: "A valid assigned_to user id is required." });
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
      return res.status(400).json({ success: false, message: "Cannot reassign a closed case." });
    }
    if (caseRow.assigned_to === assignedTo) {
      return res.status(400).json({ success: false, message: "Case is already assigned to this user." });
    }

    const userCheck = await pool.request().input("id", sql.Int, assignedTo).query("SELECT id, name FROM Users WHERE id = @id");
    if (userCheck.recordset.length === 0) {
      return res.status(400).json({ success: false, message: "assigned_to user does not exist." });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    await transaction
      .request()
      .input("case_id", sql.Int, caseId)
      .input("assigned_to", sql.Int, assignedTo)
      .query("UPDATE ImmigrationCases SET assigned_to = @assigned_to, updated_at = GETDATE() WHERE case_id = @case_id");

    await transaction
      .request()
      .input("case_id", sql.Int, caseId)
      .input("old_user_id", sql.Int, caseRow.assigned_to)
      .input("new_user_id", sql.Int, assignedTo)
      .input("assigned_by", sql.Int, changedBy)
      .input("remarks", sql.NVarChar(sql.MAX), remarks)
      .query(`
        INSERT INTO CaseAssignmentHistory (case_id, old_user_id, new_user_id, assigned_by, remarks, assigned_at)
        VALUES (@case_id, @old_user_id, @new_user_id, @assigned_by, @remarks, GETDATE())
      `);

    await transaction
      .request()
      .input("case_id", sql.Int, caseId)
      .input("participant_role", sql.VarChar(50), participantRole)
      .query(`
        UPDATE CaseParticipants
        SET is_active = 0, assigned_until = GETDATE()
        WHERE case_id = @case_id AND participant_role = @participant_role AND is_active = 1
      `);

    await transaction
      .request()
      .input("case_id", sql.Int, caseId)
      .input("user_id", sql.Int, assignedTo)
      .input("participant_role", sql.VarChar(50), participantRole)
      .query(`
        INSERT INTO CaseParticipants (case_id, user_id, participant_role, assigned_from, is_active, created_at)
        VALUES (@case_id, @user_id, @participant_role, GETDATE(), 1, GETDATE())
      `);

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: changedBy,
      activityType: "CASE_REASSIGNED",
      entityType: "CASE",
      entityId: caseId,
      oldValue: caseRow.assigned_to != null ? String(caseRow.assigned_to) : null,
      newValue: String(assignedTo),
      description: remarks || `Case reassigned to user ${assignedTo}.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({
      success: true,
      message: "Case reassigned successfully.",
      data: { caseId, assigned_to: assignedTo, assigned_user_name: userCheck.recordset[0].name },
    });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[assignCase] Rollback failed:", rollbackErr);
      }
    }
    console.error("[assignCase] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to reassign case." });
  }
};

// ---------------------------------------------------------------------------
// Paginated history readers: activity log / status history / assignment history
// ---------------------------------------------------------------------------

export const getCaseActivityLog = async (req, res) => {
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
          SELECT
            al.activity_id, al.lead_id, al.case_id, al.user_id, al.activity_type,
            al.entity_type, al.entity_id,
            CASE WHEN al.entity_type = 'CASE_STEP' AND ws.stage_name IS NOT NULL
                 THEN CONCAT(ws.stage_name, ' -> ', al.old_value)
                 ELSE al.old_value END AS old_value,
            CASE WHEN al.entity_type = 'CASE_STEP' AND ws.stage_name IS NOT NULL
                 THEN CONCAT(ws.stage_name, ' -> ', al.new_value)
                 ELSE al.new_value END AS new_value,
            al.description, al.ip_address, al.user_agent, al.created_at,
            u.name AS user_name
          FROM ActivityLogs al
          LEFT JOIN Users u ON u.id = al.user_id
          LEFT JOIN CaseSteps cst
                 ON al.entity_type = 'CASE_STEP' AND cst.case_step_id = al.entity_id
          LEFT JOIN WorkflowSteps wst ON wst.workflow_step_id = cst.workflow_step_id
          LEFT JOIN WorkflowStages ws ON ws.stage_id = wst.stage_id
          WHERE al.case_id = @case_id
          ORDER BY al.created_at DESC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      pool
        .request()
        .input("case_id", sql.Int, caseId)
        .query("SELECT COUNT(*) AS total FROM ActivityLogs WHERE case_id = @case_id"),
    ]);

    return res.status(200).json({
      success: true,
      caseId,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      activity: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getCaseActivityLog] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch case activity log." });
  }
};

export const getCaseStatusHistory = async (req, res) => {
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
          SELECT
            sh.status_history_id, sh.lead_id, sh.case_id, sh.case_stage_id, sh.case_step_id,
            sh.entity_type,
            CASE WHEN sh.entity_type = 'STEP' AND ws.stage_name IS NOT NULL
                 THEN CONCAT(ws.stage_name, ' - ', wst.step_name, ' -> ', sh.old_status)
                 ELSE sh.old_status END AS old_status,
            CASE WHEN sh.entity_type = 'STEP' AND ws.stage_name IS NOT NULL
                 THEN CONCAT(ws.stage_name, ' - ', wst.step_name, ' -> ', sh.new_status)
                 ELSE sh.new_status END AS new_status,
            sh.changed_by, sh.remarks, sh.changed_at,
            u.name AS changed_by_name
          FROM StatusHistory sh
          LEFT JOIN Users u ON u.id = sh.changed_by
          LEFT JOIN CaseSteps cst
                 ON sh.entity_type = 'STEP' AND cst.case_step_id = sh.case_step_id
          LEFT JOIN WorkflowSteps wst ON wst.workflow_step_id = cst.workflow_step_id
          LEFT JOIN WorkflowStages ws ON ws.stage_id = wst.stage_id
          WHERE sh.case_id = @case_id
          ORDER BY sh.changed_at DESC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      pool
        .request()
        .input("case_id", sql.Int, caseId)
        .query("SELECT COUNT(*) AS total FROM StatusHistory WHERE case_id = @case_id"),
    ]);

    return res.status(200).json({
      success: true,
      caseId,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      history: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getCaseStatusHistory] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch case status history." });
  }
};

export const getCaseAssignmentHistory = async (req, res) => {
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
          SELECT
            cah.*,
            oldUser.name AS old_user_name,
            newUser.name AS new_user_name,
            assignedByUser.name AS assigned_by_name
          FROM CaseAssignmentHistory cah
          LEFT JOIN Users oldUser ON oldUser.id = cah.old_user_id
          LEFT JOIN Users newUser ON newUser.id = cah.new_user_id
          LEFT JOIN Users assignedByUser ON assignedByUser.id = cah.assigned_by
          WHERE cah.case_id = @case_id
          ORDER BY cah.assigned_at DESC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      pool
        .request()
        .input("case_id", sql.Int, caseId)
        .query("SELECT COUNT(*) AS total FROM CaseAssignmentHistory WHERE case_id = @case_id"),
    ]);

    return res.status(200).json({
      success: true,
      caseId,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      assignments: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getCaseAssignmentHistory] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch case assignment history." });
  }
};
