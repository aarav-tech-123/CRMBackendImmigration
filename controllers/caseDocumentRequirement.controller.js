import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";
import { getRequestInfo } from "../helpers/requestInfo.js";
import { parsePositiveInt, paginationParams } from "../helpers/parsers.js";
import { getCaseOrNull } from "../helpers/caseHelpers.js";

// No lookup table backs this column (unlike CaseDocuments.document_status_id,
// which is driven by DocumentStatuses) — this is my assumption for the
// requirement's own lifecycle; adjust if you have different values in mind.
const REQUIREMENT_STATUSES = ["Pending", "Submitted", "Verified", "Rejected", "Waived"];

const getDocumentTypeOrNull = async (executor, documentTypeId) => {
  const result = await executor
    .request()
    .input("document_type_id", sql.Int, documentTypeId)
    .query("SELECT document_type_id, document_name FROM DocumentTypes WHERE document_type_id = @document_type_id AND is_active = 1");
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

const isValidDate = (value) => !Number.isNaN(new Date(value).getTime());

const REQUIREMENT_SELECT = `
  r.requirement_id, r.case_id, r.case_step_id, r.document_type_id, r.document_name,
  r.is_required, r.requirement_status, r.due_date, r.remarks, r.created_at, r.updated_at,
  dt.document_code, dt.document_name AS document_type_name
`;

// ---------------------------------------------------------------------------
// GET /:caseId/document-requirements?case_step_id=&requirement_status=
// ---------------------------------------------------------------------------
export const getCaseDocumentRequirements = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }
  const { page, pageSize, offset } = paginationParams(req);
  const caseStepId = parsePositiveInt(req.query.case_step_id);
  const requirementStatus = REQUIREMENT_STATUSES.includes(req.query.requirement_status) ? req.query.requirement_status : null;

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
        .input("requirement_status", sql.VarChar(20), requirementStatus);

    const [dataResult, countResult] = await Promise.all([
      buildRequest()
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize)
        .query(`
          SELECT ${REQUIREMENT_SELECT}
          FROM CaseDocumentRequirements r
          INNER JOIN DocumentTypes dt ON dt.document_type_id = r.document_type_id
          WHERE r.case_id = @case_id
            AND (@case_step_id IS NULL OR r.case_step_id = @case_step_id)
            AND (@requirement_status IS NULL OR r.requirement_status = @requirement_status)
          ORDER BY r.due_date ASC, r.created_at DESC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      buildRequest().query(`
        SELECT COUNT(*) AS total
        FROM CaseDocumentRequirements r
        WHERE r.case_id = @case_id
          AND (@case_step_id IS NULL OR r.case_step_id = @case_step_id)
          AND (@requirement_status IS NULL OR r.requirement_status = @requirement_status);
      `),
    ]);

    return res.status(200).json({
      success: true,
      caseId,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      requirements: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getCaseDocumentRequirements] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch document requirements." });
  }
};

// ---------------------------------------------------------------------------
// POST /:caseId/document-requirements
// ---------------------------------------------------------------------------
export const createCaseDocumentRequirement = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }

  const { document_type_id, case_step_id, document_name, is_required, due_date, remarks } = req.body || {};
  const createdBy = req.user?.id;

  const documentTypeId = parsePositiveInt(document_type_id);
  if (!documentTypeId) {
    return res.status(400).json({ success: false, message: "A valid document_type_id is required." });
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

    const documentType = await getDocumentTypeOrNull(pool, documentTypeId);
    if (!documentType) {
      return res.status(400).json({ success: false, message: "document_type_id does not exist or is inactive." });
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

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const insertResult = await transaction
      .request()
      .input("case_id", sql.Int, caseId)
      .input("case_step_id", sql.Int, caseStepId)
      .input("document_type_id", sql.Int, documentTypeId)
      .input("document_name", sql.NVarChar(255), document_name || documentType.document_name)
      .input("is_required", sql.Bit, is_required === false ? 0 : 1)
      .input("due_date", sql.DateTime, due_date ? new Date(due_date) : null)
      .input("remarks", sql.NVarChar(sql.MAX), remarks || null)
      .query(`
        INSERT INTO CaseDocumentRequirements
          (case_id, case_step_id, document_type_id, document_name, is_required,
           requirement_status, due_date, remarks, created_at, updated_at)
        OUTPUT INSERTED.*
        VALUES
          (@case_id, @case_step_id, @document_type_id, @document_name, @is_required,
           'Pending', @due_date, @remarks, GETDATE(), GETDATE())
      `);
    const createdRequirement = insertResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: createdBy,
      activityType: "DOCUMENT_REQUIREMENT_CREATED",
      entityType: "CASE",
      entityId: caseId,
      oldValue: null,
      newValue: createdRequirement.requirement_status,
      description: `Document requirement "${createdRequirement.document_name}" added.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(201).json({ success: true, message: "Document requirement created successfully.", data: createdRequirement });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[createCaseDocumentRequirement] Rollback failed:", rollbackErr);
      }
    }
    console.error("[createCaseDocumentRequirement] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to create document requirement." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /:caseId/document-requirements/:requirementId
// ---------------------------------------------------------------------------
export const updateCaseDocumentRequirement = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  const requirementId = parsePositiveInt(req.params.requirementId);
  if (!caseId || !requirementId) {
    return res.status(400).json({ success: false, message: "A valid caseId and requirementId are required." });
  }

  const { document_name, is_required, requirement_status, due_date, remarks } = req.body || {};
  const changedBy = req.user?.id;

  if (requirement_status !== undefined && requirement_status !== null && !REQUIREMENT_STATUSES.includes(requirement_status)) {
    return res.status(400).json({ success: false, message: `requirement_status must be one of: ${REQUIREMENT_STATUSES.join(", ")}.` });
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

    const existingResult = await pool
      .request()
      .input("requirement_id", sql.Int, requirementId)
      .input("case_id", sql.Int, caseId)
      .query("SELECT * FROM CaseDocumentRequirements WHERE requirement_id = @requirement_id AND case_id = @case_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Document requirement not found for this case." });
    }
    const existingRequirement = existingResult.recordset[0];

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const updateResult = await transaction
      .request()
      .input("requirement_id", sql.Int, requirementId)
      .input("document_name", sql.NVarChar(255), document_name !== undefined ? document_name : existingRequirement.document_name)
      .input("is_required", sql.Bit, is_required !== undefined ? (is_required ? 1 : 0) : existingRequirement.is_required)
      .input("requirement_status", sql.VarChar(20), requirement_status !== undefined ? requirement_status : existingRequirement.requirement_status)
      .input("due_date", sql.DateTime, due_date !== undefined ? (due_date ? new Date(due_date) : null) : existingRequirement.due_date)
      .input("remarks", sql.NVarChar(sql.MAX), remarks !== undefined ? remarks : existingRequirement.remarks)
      .query(`
        UPDATE CaseDocumentRequirements
        SET
          document_name = @document_name,
          is_required = @is_required,
          requirement_status = @requirement_status,
          due_date = @due_date,
          remarks = @remarks,
          updated_at = GETDATE()
        OUTPUT INSERTED.*
        WHERE requirement_id = @requirement_id
      `);
    const updatedRequirement = updateResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: changedBy,
      activityType: "DOCUMENT_REQUIREMENT_UPDATED",
      entityType: "CASE",
      entityId: caseId,
      oldValue: existingRequirement.requirement_status,
      newValue: updatedRequirement.requirement_status,
      description: `Document requirement "${updatedRequirement.document_name}" updated.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Document requirement updated successfully.", data: updatedRequirement });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[updateCaseDocumentRequirement] Rollback failed:", rollbackErr);
      }
    }
    console.error("[updateCaseDocumentRequirement] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update document requirement." });
  }
};

// ---------------------------------------------------------------------------
// DELETE /:caseId/document-requirements/:requirementId
// ---------------------------------------------------------------------------
export const deleteCaseDocumentRequirement = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  const requirementId = parsePositiveInt(req.params.requirementId);
  if (!caseId || !requirementId) {
    return res.status(400).json({ success: false, message: "A valid caseId and requirementId are required." });
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
      .input("requirement_id", sql.Int, requirementId)
      .input("case_id", sql.Int, caseId)
      .query("SELECT requirement_id, document_name FROM CaseDocumentRequirements WHERE requirement_id = @requirement_id AND case_id = @case_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Document requirement not found for this case." });
    }
    const existingRequirement = existingResult.recordset[0];

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    await transaction
      .request()
      .input("requirement_id", sql.Int, requirementId)
      .query("DELETE FROM CaseDocumentRequirements WHERE requirement_id = @requirement_id");

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: changedBy,
      activityType: "DOCUMENT_REQUIREMENT_DELETED",
      entityType: "CASE",
      entityId: caseId,
      oldValue: existingRequirement.document_name,
      newValue: null,
      description: `Document requirement "${existingRequirement.document_name}" deleted.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Document requirement deleted successfully." });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[deleteCaseDocumentRequirement] Rollback failed:", rollbackErr);
      }
    }
    console.error("[deleteCaseDocumentRequirement] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete document requirement." });
  }
};
