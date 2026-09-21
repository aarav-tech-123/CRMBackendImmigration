import { sql } from "../config/db.js";

export const getCaseOrNull = async (executor, caseId) => {
  const result = await executor
    .request()
    .input("case_id", sql.Int, caseId)
    .query(`
      SELECT case_id, lead_id, program_id, assigned_to, center_code, closed_at
      FROM ImmigrationCases
      WHERE case_id = @case_id
    `);
  return result.recordset[0] || null;
};

export const getLeadOrNull = async (executor, leadId) => {
  const result = await executor
    .request()
    .input("lead_id", sql.Int, leadId)
    .query("SELECT lead_id, assigned_to FROM Leads WHERE lead_id = @lead_id");
  return result.recordset[0] || null;
};

// A lead's most recent case, if it has been converted. Used to auto-attach
// lead-scoped records (Notes, FollowUps) to their case once one exists.
export const resolveCaseIdForLead = async (executor, leadId) => {
  const result = await executor
    .request()
    .input("lead_id", sql.Int, leadId)
    .query("SELECT TOP 1 case_id FROM ImmigrationCases WHERE lead_id = @lead_id ORDER BY case_id DESC");
  return result.recordset[0]?.case_id ?? null;
};
