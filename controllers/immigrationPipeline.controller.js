import {sql, poolPromise} from "../config/db.js";

 export const getStagesByProgram = async (req, res) => {
  const { programId } = req.params;
  const includeClosed = req.query.includeClosed === '1' ? 1 : 0;

  if (!programId || isNaN(Number(programId))) {
    return res.status(400).json({ success: false, message: 'A valid programId is required.' });
  }

  try {
    const pool = await poolPromise;

    const result = await pool
      .request()
      .input('programId', sql.Int, programId)
      .input('includeClosed', sql.Bit, includeClosed).query(`
        WITH CurrentCaseStage AS (
          SELECT
            cs.*,
            ROW_NUMBER() OVER (
              PARTITION BY cs.case_id
              ORDER BY
                CASE WHEN cs.completed_at IS NULL THEN 0 ELSE 1 END,
                cs.started_at DESC
            ) AS rn
          FROM [dbo].[CaseStages] cs
        )
        SELECT
          ws.stage_id,
          ws.stage_code,
          ws.stage_name,
          ws.department,
          ws.sort_order,
          ws.stage_no,
          COUNT(ic.case_id)                                              AS total_cases,
          SUM(CASE WHEN ccs.status = 'Pending'     THEN 1 ELSE 0 END)    AS pending_count,
          SUM(CASE WHEN ccs.status = 'In Progress' THEN 1 ELSE 0 END)    AS in_progress_count,
          SUM(CASE WHEN ccs.status = 'Completed'   THEN 1 ELSE 0 END)    AS completed_count
        FROM [dbo].[WorkflowStages] ws
        LEFT JOIN CurrentCaseStage ccs
               ON ccs.stage_id = ws.stage_id AND ccs.rn = 1
        LEFT JOIN [dbo].[ImmigrationCases] ic
               ON ic.case_id = ccs.case_id
              AND ic.program_id = ws.program_id
              AND (@includeClosed = 1 OR ic.closed_at IS NULL)
        WHERE ws.program_id = @programId
          AND ws.is_active = 1
        GROUP BY ws.stage_id, ws.stage_code, ws.stage_name, ws.department, ws.sort_order, ws.stage_no
        ORDER BY ws.sort_order, ws.stage_no;
      `);

    return res.status(200).json({
      success: true,
      programId: Number(programId),
      stages: result.recordset,
    });
  } catch (err) {
    console.error('[getStagesByProgram] Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch stage pipeline.' });
  }
}



export const getStepsByStage = async (req, res) => {
  const { programId, stageId } = req.params;
  const includeClosed = req.query.includeClosed === '1' ? 1 : 0;

  if (!programId || !stageId || isNaN(Number(programId)) || isNaN(Number(stageId))) {
    return res.status(400).json({ success: false, message: 'A valid programId and stageId are required.' });
  }

  try {
    const pool = await poolPromise;

    const result = await pool
      .request()
      .input('programId', sql.Int, programId)
      .input('stageId', sql.Int, stageId)
      .input('includeClosed', sql.Bit, includeClosed).query(`
        WITH CurrentCaseStage AS (
          SELECT
            cs.*,
            ROW_NUMBER() OVER (
              PARTITION BY cs.case_id
              ORDER BY
                CASE WHEN cs.completed_at IS NULL THEN 0 ELSE 1 END,
                cs.started_at DESC
            ) AS rn
          FROM [dbo].[CaseStages] cs
        ),
        CasesInStage AS (
          SELECT ic.case_id
          FROM [dbo].[ImmigrationCases] ic
          INNER JOIN CurrentCaseStage ccs
                  ON ccs.case_id = ic.case_id AND ccs.rn = 1
          WHERE ccs.stage_id = @stageId
            AND ic.program_id = @programId
            AND (@includeClosed = 1 OR ic.closed_at IS NULL)
        ),
        CurrentCaseStep AS (
          SELECT
            cst.*,
            ROW_NUMBER() OVER (
              PARTITION BY cst.case_id
              ORDER BY
                CASE WHEN cst.completed_at IS NULL THEN 0 ELSE 1 END,
                cst.started_at DESC
            ) AS rn
          FROM [dbo].[CaseSteps] cst
          INNER JOIN [dbo].[WorkflowSteps] wst
                  ON wst.workflow_step_id = cst.workflow_step_id
          WHERE wst.stage_id = @stageId
        )
        SELECT
          wst.workflow_step_id,
          wst.step_code,
          wst.step_name,
          wst.department,
          wst.sort_order,
          COUNT(cis.case_id)                                                AS total_cases,
          SUM(CASE WHEN ccstep.step_status = 'Pending'     THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN ccstep.step_status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress_count,
          SUM(CASE WHEN ccstep.step_status = 'Completed'   THEN 1 ELSE 0 END) AS completed_count
        FROM [dbo].[WorkflowSteps] wst
        LEFT JOIN CurrentCaseStep ccstep
               ON ccstep.workflow_step_id = wst.workflow_step_id AND ccstep.rn = 1
        LEFT JOIN CasesInStage cis
               ON cis.case_id = ccstep.case_id
        WHERE wst.stage_id = @stageId
          AND wst.is_active = 1
        GROUP BY wst.workflow_step_id, wst.step_code, wst.step_name, wst.department, wst.sort_order
        ORDER BY wst.sort_order;
      `);

    return res.status(200).json({
      success: true,
      programId: Number(programId),
      stageId: Number(stageId),
      steps: result.recordset,
    });
  } catch (err) {
    console.error('[getStepsByStage] Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch step pipeline.' });
  }
}



export const getCasesByStep = async (req, res) => {
  const { programId, stageId, stepId } = req.params;
  const includeClosed = req.query.includeClosed === '1' ? 1 : 0;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);
  const offset = (page - 1) * pageSize;

  if ([programId, stageId, stepId].some((v) => !v || isNaN(Number(v)))) {
    return res.status(400).json({ success: false, message: 'Valid programId, stageId and stepId are required.' });
  }

  try {
    const pool = await poolPromise;

    const request = pool
      .request()
      .input('programId', sql.Int, programId)
      .input('stageId', sql.Int, stageId)
      .input('stepId', sql.Int, stepId)
      .input('includeClosed', sql.Bit, includeClosed)
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, pageSize);

    const baseCte = `
      WITH CurrentCaseStage AS (
        SELECT
          cs.*,
          ROW_NUMBER() OVER (
            PARTITION BY cs.case_id
            ORDER BY CASE WHEN cs.completed_at IS NULL THEN 0 ELSE 1 END, cs.started_at DESC
          ) AS rn
        FROM [dbo].[CaseStages] cs
      ),
      CurrentCaseStep AS (
        SELECT
          cst.*,
          ROW_NUMBER() OVER (
            PARTITION BY cst.case_id
            ORDER BY CASE WHEN cst.completed_at IS NULL THEN 0 ELSE 1 END, cst.started_at DESC
          ) AS rn
        FROM [dbo].[CaseSteps] cst
      ),
      MatchingCases AS (
        SELECT
          ic.case_id, ic.case_number, ic.lead_id, ic.assigned_to AS case_assigned_to,
          ic.center_code, ic.opened_at, ic.closed_at,
          ccstep.step_status, ccstep.started_at AS step_started_at,
          ccstep.completed_at AS step_completed_at, ccstep.assigned_to AS step_assigned_to,
          ccstep.remarks AS step_remarks
        FROM [dbo].[ImmigrationCases] ic
        INNER JOIN CurrentCaseStage ccs
                ON ccs.case_id = ic.case_id AND ccs.rn = 1 AND ccs.stage_id = @stageId
        INNER JOIN CurrentCaseStep ccstep
                ON ccstep.case_id = ic.case_id AND ccstep.rn = 1 AND ccstep.workflow_step_id = @stepId
        WHERE ic.program_id = @programId
          AND (@includeClosed = 1 OR ic.closed_at IS NULL)
      )
    `;

    const [dataResult, countResult] = await Promise.all([
      request.query(`
        ${baseCte}
        SELECT * FROM MatchingCases
        ORDER BY step_started_at DESC
        OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
      `),
      pool
        .request()
        .input('programId', sql.Int, programId)
        .input('stageId', sql.Int, stageId)
        .input('stepId', sql.Int, stepId)
        .input('includeClosed', sql.Bit, includeClosed).query(`
        ${baseCte}
        SELECT COUNT(*) AS total FROM MatchingCases;
      `),
    ]);

    return res.status(200).json({
      success: true,
      programId: Number(programId),
      stageId: Number(stageId),
      stepId: Number(stepId),
      page,
      pageSize,
      total: countResult.recordset[0].total,
      cases: dataResult.recordset,
    });
  } catch (err) {
    console.error('[getCasesByStep] Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch cases for step.' });
  }
}