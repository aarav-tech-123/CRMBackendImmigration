import { sql, poolPromise } from '../config/db.js';


export const getStageWiseCounts = async (req, res) => {
  const { programId } = req.query;
  const includeClosed = req.query.includeClosed === '1' ? 1 : 0;

  if (programId && isNaN(Number(programId))) {
    return res.status(400).json({ success: false, message: 'programId must be numeric if provided.' });
  }

  try {
    const pool = await poolPromise;

    const result = await pool
      .request()
      .input('programId', sql.Int, programId || null)
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
          ws.program_id,
          ws.stage_id,
          ws.stage_code,
          ws.stage_name,
          ws.department,
          ws.sort_order,
          ws.stage_no,
          COUNT(ic.case_id)                                           AS total_cases,
          SUM(CASE WHEN ccs.status = 'Pending'     THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN ccs.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress_count,
          SUM(CASE WHEN ccs.status = 'Completed'   THEN 1 ELSE 0 END) AS completed_count
        FROM [dbo].[WorkflowStages] ws
        LEFT JOIN CurrentCaseStage ccs
               ON ccs.stage_id = ws.stage_id AND ccs.rn = 1
        LEFT JOIN [dbo].[ImmigrationCases] ic
               ON ic.case_id = ccs.case_id
              AND ic.program_id = ws.program_id
              AND (@includeClosed = 1 OR ic.closed_at IS NULL)
        WHERE ws.is_active = 1
          AND (@programId IS NULL OR ws.program_id = @programId)
        GROUP BY ws.program_id, ws.stage_id, ws.stage_code, ws.stage_name, ws.department, ws.sort_order, ws.stage_no
        ORDER BY ws.program_id, ws.sort_order, ws.stage_no;
      `);

    return res.status(200).json({
      success: true,
      programId: programId ? Number(programId) : null,
      stages: result.recordset,
    });
  } catch (err) {
    console.error('[getStageWiseCounts] Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch stage-wise counts.' });
  }
}



export const getDashboardSummary = async (req, res) => {
  const { programId } = req.query;

  if (programId && isNaN(Number(programId))) {
    return res.status(400).json({ success: false, message: 'programId must be numeric if provided.' });
  }

  try {
    const pool = await poolPromise;
    const request = pool.request().input('programId', sql.Int, programId || null);

    const [totalsResult, byProgramResult] = await Promise.all([
      request.query(`
        SELECT
          COUNT(*)                                                                    AS total_cases,
          SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END)                          AS open_cases,
          SUM(CASE WHEN closed_at IS NOT NULL THEN 1 ELSE 0 END)                      AS closed_cases,
          SUM(CASE WHEN opened_at >= CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END)       AS opened_today,
          SUM(CASE WHEN opened_at >= DATEADD(DAY, -7, CAST(GETDATE() AS DATE)) THEN 1 ELSE 0 END)  AS opened_last_7_days,
          SUM(CASE WHEN opened_at >= DATEADD(DAY, -30, CAST(GETDATE() AS DATE)) THEN 1 ELSE 0 END) AS opened_last_30_days,
          SUM(CASE WHEN closed_at >= DATEADD(DAY, -30, CAST(GETDATE() AS DATE)) THEN 1 ELSE 0 END) AS closed_last_30_days
        FROM [dbo].[ImmigrationCases]
        WHERE (@programId IS NULL OR program_id = @programId);
      `),
      pool.request().input('programId', sql.Int, programId || null).query(`
        SELECT
          program_id,
          COUNT(*)                                              AS total_cases,
          SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END)    AS open_cases,
          SUM(CASE WHEN closed_at IS NOT NULL THEN 1 ELSE 0 END) AS closed_cases
        FROM [dbo].[ImmigrationCases]
        WHERE (@programId IS NULL OR program_id = @programId)
        GROUP BY program_id
        ORDER BY program_id;
      `),
    ]);

    return res.status(200).json({
      success: true,
      programId: programId ? Number(programId) : null,
      totals: totalsResult.recordset[0],
      byProgram: byProgramResult.recordset,
    });
  } catch (err) {
    console.error('[getDashboardSummary] Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch dashboard summary.' });
  }
}



// Lead status counts, broken down per user — one row per (user, status) pair,
// zero-filled so every status shows even where a user has no leads in it.
// Scoped to users who actually have at least one lead assigned, not every
// row in Users. Optional ?user_id= / ?center_code= narrow it further.
export const getLeadStatusCountsByUser = async (req, res) => {
  
  const user_id = req.user.id;
  const center_code = req.user.center_code;

  if (
    user_id &&
    (!Number.isInteger(Number(user_id)) || Number(user_id) <= 0)
  ) {
    return res.status(400).json({
      success: false,
      message: 'user_id must be a valid positive integer.',
    });
  }

  try {
    const pool = await poolPromise;

    const result = await pool
      .request()
      .input(
        'userId',
        sql.Int,
        user_id ? Number(user_id) : null
      )
      .input(
        'centerCode',
        sql.VarChar(50),
        center_code || null
      )
      .query(`
        SELECT
            ls.id AS status_id,
            ls.status_name,
            COUNT(l.lead_id) AS lead_count
        FROM [dbo].[LeadStatuses] ls

        LEFT JOIN [dbo].[Leads] l
            ON l.lead_status = ls.id
            AND l.assigned_to IS NOT NULL
            AND (@userId IS NULL OR l.assigned_to = @userId)
            AND (@centerCode IS NULL OR l.center_code = @centerCode)

        GROUP BY
            ls.id,
            ls.status_name,
            ls.sort_order

        ORDER BY
            ls.sort_order;
      `);

    // Convert result into:
    // {
    //   New: 5,
    //   Contacted: 3,
    //   "Not Qualified": 5
    // }

    const counts = {};

    result.recordset.forEach((row) => {
      counts[row.status_name] = Number(row.lead_count);
    });

    return res.status(200).json({
      success: true,
      counts,
    });

  } catch (err) {
    console.error('[getLeadStatusCountsByUser] Error:', err);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch lead status counts by user.',
    });
  }
};



