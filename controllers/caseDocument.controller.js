import fs from "node:fs/promises";
import path from "node:path";
import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";
import { getRequestInfo } from "../helpers/requestInfo.js";
import { parsePositiveInt, paginationParams } from "../helpers/parsers.js";
import { getCaseOrNull } from "../helpers/caseHelpers.js";
import { relativeUploadPath, absoluteUploadPath } from "../middleware/upload.middleware.js";

const getDocumentTypeOrNull = async (executor, documentTypeId) => {
  const result = await executor
    .request()
    .input("document_type_id", sql.Int, documentTypeId)
    .query("SELECT document_type_id, document_name FROM DocumentTypes WHERE document_type_id = @document_type_id AND is_active = 1");
  return result.recordset[0] || null;
};

const getDefaultDocumentStatus = async (executor) => {
  const result = await executor
    .request()
    .query("SELECT TOP 1 document_status_id, status_name FROM DocumentStatuses WHERE is_active = 1 ORDER BY sort_order");
  return result.recordset[0] || null;
};

const getDocumentStatusOrNull = async (executor, documentStatusId) => {
  const result = await executor
    .request()
    .input("document_status_id", sql.Int, documentStatusId)
    .query("SELECT document_status_id, status_name FROM DocumentStatuses WHERE document_status_id = @document_status_id AND is_active = 1");
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

const getCaseTaskOrNull = async (executor, caseId, caseTaskId) => {
  const result = await executor
    .request()
    .input("case_id", sql.Int, caseId)
    .input("task_id", sql.Int, caseTaskId)
    .query("SELECT task_id FROM CaseTasks WHERE task_id = @task_id AND case_id = @case_id");
  return result.recordset[0] || null;
};

// The matching open requirement (if any) that this document type would fulfill.
const getMatchingRequirement = async (executor, caseId, documentTypeId, caseStepId) => {
  const result = await executor
    .request()
    .input("case_id", sql.Int, caseId)
    .input("document_type_id", sql.Int, documentTypeId)
    .input("case_step_id", sql.Int, caseStepId)
    .query(`
      SELECT TOP 1 requirement_id, requirement_status
      FROM CaseDocumentRequirements
      WHERE case_id = @case_id
        AND document_type_id = @document_type_id
        AND (case_step_id = @case_step_id OR (case_step_id IS NULL AND @case_step_id IS NULL))
        AND requirement_status IN ('Pending', 'Rejected')
    `);
  return result.recordset[0] || null;
};

const unlinkQuietly = async (absPath) => {
  try {
    await fs.unlink(absPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[caseDocument] Failed to remove file:", absPath, err);
    }
  }
};

const DOCUMENT_SELECT = `
  cd.case_document_id, cd.case_id, cd.case_step_id, cd.case_task_id, cd.document_type_id,
  cd.document_status_id, cd.document_name, cd.original_file_name, cd.stored_file_name,
  cd.file_path, cd.file_extension, cd.file_size, cd.version_number,
  cd.uploaded_by, cd.verified_by, cd.uploaded_at, cd.verified_at,
  cd.rejection_reason, cd.remarks, cd.created_at, cd.updated_at,
  dt.document_code, dt.document_name AS document_type_name,
  ds.status_name AS document_status_name,
  uploader.name AS uploaded_by_name,
  verifier.name AS verified_by_name
`;
const DOCUMENT_JOINS = `
  FROM CaseDocuments cd
  INNER JOIN DocumentTypes dt ON dt.document_type_id = cd.document_type_id
  LEFT JOIN DocumentStatuses ds ON ds.document_status_id = cd.document_status_id
  LEFT JOIN Users uploader ON uploader.id = cd.uploaded_by
  LEFT JOIN Users verifier ON verifier.id = cd.verified_by
`;

// ---------------------------------------------------------------------------
// GET /:caseId/documents?case_step_id=&case_task_id=&document_type_id=&document_status_id=
// ---------------------------------------------------------------------------
export const getCaseDocuments = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }
  const { page, pageSize, offset } = paginationParams(req);

  const caseStepId = parsePositiveInt(req.query.case_step_id);
  const caseTaskId = parsePositiveInt(req.query.case_task_id);
  const documentTypeId = parsePositiveInt(req.query.document_type_id);
  const documentStatusId = parsePositiveInt(req.query.document_status_id);

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
        .input("case_task_id", sql.Int, caseTaskId)
        .input("document_type_id", sql.Int, documentTypeId)
        .input("document_status_id", sql.Int, documentStatusId);

    const [dataResult, countResult] = await Promise.all([
      buildRequest()
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize)
        .query(`
          SELECT ${DOCUMENT_SELECT}
          ${DOCUMENT_JOINS}
          WHERE cd.case_id = @case_id
            AND (@case_step_id IS NULL OR cd.case_step_id = @case_step_id)
            AND (@case_task_id IS NULL OR cd.case_task_id = @case_task_id)
            AND (@document_type_id IS NULL OR cd.document_type_id = @document_type_id)
            AND (@document_status_id IS NULL OR cd.document_status_id = @document_status_id)
          ORDER BY cd.uploaded_at DESC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      buildRequest().query(`
        SELECT COUNT(*) AS total
        FROM CaseDocuments cd
        WHERE cd.case_id = @case_id
          AND (@case_step_id IS NULL OR cd.case_step_id = @case_step_id)
          AND (@case_task_id IS NULL OR cd.case_task_id = @case_task_id)
          AND (@document_type_id IS NULL OR cd.document_type_id = @document_type_id)
          AND (@document_status_id IS NULL OR cd.document_status_id = @document_status_id);
      `),
    ]);

    return res.status(200).json({
      success: true,
      caseId,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      documents: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getCaseDocuments] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch case documents." });
  }
};

// ---------------------------------------------------------------------------
// GET /:caseId/documents/:documentId
// ---------------------------------------------------------------------------
export const getCaseDocumentById = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  const documentId = parsePositiveInt(req.params.documentId);
  if (!caseId || !documentId) {
    return res.status(400).json({ success: false, message: "A valid caseId and documentId are required." });
  }

  try {
    const pool = await poolPromise;

    const result = await pool
      .request()
      .input("case_id", sql.Int, caseId)
      .input("case_document_id", sql.Int, documentId)
      .query(`
        SELECT ${DOCUMENT_SELECT}
        ${DOCUMENT_JOINS}
        WHERE cd.case_document_id = @case_document_id AND cd.case_id = @case_id
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Document not found for this case." });
    }

    return res.status(200).json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error("[getCaseDocumentById] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch document." });
  }
};

// ---------------------------------------------------------------------------
// POST /:caseId/documents — multipart/form-data, file field name "file"
//
// Versioned per (case_id, document_type_id): re-uploading the same document
// type creates a new row with an incremented version_number rather than
// overwriting. If an open requirement (Pending/Rejected) exists for this
// document type (and case_step_id, if given), it's auto-advanced to Submitted.
// ---------------------------------------------------------------------------
export const uploadCaseDocumentRecord = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    if (req.file) await unlinkQuietly(absoluteUploadPath(req.file.filename));
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'A file is required (field name "file").' });
  }

  const { document_type_id, case_step_id, case_task_id, document_name, remarks } = req.body || {};
  const uploadedBy = req.user?.id;

  const documentTypeId = parsePositiveInt(document_type_id);
  if (!documentTypeId) {
    await unlinkQuietly(absoluteUploadPath(req.file.filename));
    return res.status(400).json({ success: false, message: "A valid document_type_id is required." });
  }

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const caseRow = await getCaseOrNull(pool, caseId);
    if (!caseRow) {
      await unlinkQuietly(absoluteUploadPath(req.file.filename));
      return res.status(404).json({ success: false, message: "Immigration case not found." });
    }

    const documentType = await getDocumentTypeOrNull(pool, documentTypeId);
    if (!documentType) {
      await unlinkQuietly(absoluteUploadPath(req.file.filename));
      return res.status(400).json({ success: false, message: "document_type_id does not exist or is inactive." });
    }

    let caseStepId = parsePositiveInt(case_step_id);
    if (case_step_id !== undefined && case_step_id !== null && case_step_id !== "" && !caseStepId) {
      await unlinkQuietly(absoluteUploadPath(req.file.filename));
      return res.status(400).json({ success: false, message: "Invalid case_step_id." });
    }
    if (caseStepId) {
      const step = await getCaseStepOrNull(pool, caseId, caseStepId);
      if (!step) {
        await unlinkQuietly(absoluteUploadPath(req.file.filename));
        return res.status(400).json({ success: false, message: "case_step_id does not belong to this case." });
      }
    }

    let caseTaskId = parsePositiveInt(case_task_id);
    if (case_task_id !== undefined && case_task_id !== null && case_task_id !== "" && !caseTaskId) {
      await unlinkQuietly(absoluteUploadPath(req.file.filename));
      return res.status(400).json({ success: false, message: "Invalid case_task_id." });
    }
    if (caseTaskId) {
      const task = await getCaseTaskOrNull(pool, caseId, caseTaskId);
      if (!task) {
        await unlinkQuietly(absoluteUploadPath(req.file.filename));
        return res.status(400).json({ success: false, message: "case_task_id does not belong to this case." });
      }
    }

    const defaultStatus = await getDefaultDocumentStatus(pool);
    if (!defaultStatus) {
      await unlinkQuietly(absoluteUploadPath(req.file.filename));
      return res.status(400).json({ success: false, message: "No active DocumentStatuses are configured." });
    }

    const versionResult = await pool
      .request()
      .input("case_id", sql.Int, caseId)
      .input("document_type_id", sql.Int, documentTypeId)
      .query(`
        SELECT ISNULL(MAX(version_number), 0) AS max_version
        FROM CaseDocuments
        WHERE case_id = @case_id AND document_type_id = @document_type_id
      `);
    const nextVersion = versionResult.recordset[0].max_version + 1;

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const insertResult = await transaction
      .request()
      .input("case_id", sql.Int, caseId)
      .input("case_step_id", sql.Int, caseStepId)
      .input("case_task_id", sql.Int, caseTaskId)
      .input("document_type_id", sql.Int, documentTypeId)
      .input("document_status_id", sql.Int, defaultStatus.document_status_id)
      .input("document_name", sql.NVarChar(255), document_name || documentType.document_name)
      .input("original_file_name", sql.NVarChar(255), req.file.originalname)
      .input("stored_file_name", sql.NVarChar(255), req.file.filename)
      .input("file_path", sql.NVarChar(500), relativeUploadPath(req.file.filename))
      .input("file_extension", sql.VarChar(20), path.extname(req.file.originalname).toLowerCase())
      .input("file_size", sql.Int, req.file.size)
      .input("version_number", sql.Int, nextVersion)
      .input("uploaded_by", sql.Int, uploadedBy)
      .input("remarks", sql.NVarChar(sql.MAX), remarks || null)
      .query(`
        INSERT INTO CaseDocuments
          (case_id, case_step_id, case_task_id, document_type_id, document_status_id,
           document_name, original_file_name, stored_file_name, file_path, file_extension,
           file_size, version_number, uploaded_by, uploaded_at, remarks, created_at, updated_at)
        OUTPUT INSERTED.*
        VALUES
          (@case_id, @case_step_id, @case_task_id, @document_type_id, @document_status_id,
           @document_name, @original_file_name, @stored_file_name, @file_path, @file_extension,
           @file_size, @version_number, @uploaded_by, GETDATE(), @remarks, GETDATE(), GETDATE())
      `);
    const createdDocument = insertResult.recordset[0];

    const matchingRequirement = await getMatchingRequirement(transaction, caseId, documentTypeId, caseStepId);
    if (matchingRequirement) {
      await transaction
        .request()
        .input("requirement_id", sql.Int, matchingRequirement.requirement_id)
        .query("UPDATE CaseDocumentRequirements SET requirement_status = 'Submitted', updated_at = GETDATE() WHERE requirement_id = @requirement_id");
    }

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: uploadedBy,
      activityType: "DOCUMENT_UPLOADED",
      entityType: "CASE_DOCUMENT",
      entityId: createdDocument.case_document_id,
      oldValue: null,
      newValue: `v${nextVersion}`,
      description: `Document "${createdDocument.document_name}" uploaded (version ${nextVersion}).`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(201).json({ success: true, message: "Document uploaded successfully.", data: createdDocument });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[uploadCaseDocumentRecord] Rollback failed:", rollbackErr);
      }
    }
    if (req.file) await unlinkQuietly(absoluteUploadPath(req.file.filename));
    console.error("[uploadCaseDocumentRecord] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to upload document." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /:caseId/documents/:documentId/verify
//
// Body: { document_status_id, rejection_reason?, remarks? }. rejection_reason
// is required when the resolved status name is "Rejected". Also advances any
// matching CaseDocumentRequirements row when the resolved status is
// Verified/Rejected.
// ---------------------------------------------------------------------------
export const verifyCaseDocument = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  const documentId = parsePositiveInt(req.params.documentId);
  if (!caseId || !documentId) {
    return res.status(400).json({ success: false, message: "A valid caseId and documentId are required." });
  }

  const { document_status_id, rejection_reason, remarks } = req.body || {};
  const verifiedBy = req.user?.id;

  const documentStatusId = parsePositiveInt(document_status_id);
  if (!documentStatusId) {
    return res.status(400).json({ success: false, message: "A valid document_status_id is required." });
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
      .input("case_document_id", sql.Int, documentId)
      .input("case_id", sql.Int, caseId)
      .query("SELECT * FROM CaseDocuments WHERE case_document_id = @case_document_id AND case_id = @case_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Document not found for this case." });
    }
    const existingDocument = existingResult.recordset[0];

    const newStatus = await getDocumentStatusOrNull(pool, documentStatusId);
    if (!newStatus) {
      return res.status(400).json({ success: false, message: "document_status_id does not exist or is inactive." });
    }

    const isRejected = newStatus.status_name.toLowerCase() === "rejected";
    if (isRejected && (!rejection_reason || !String(rejection_reason).trim())) {
      return res.status(400).json({ success: false, message: "rejection_reason is required when rejecting a document." });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const updateResult = await transaction
      .request()
      .input("case_document_id", sql.Int, documentId)
      .input("document_status_id", sql.Int, documentStatusId)
      .input("verified_by", sql.Int, verifiedBy)
      .input("rejection_reason", sql.NVarChar(sql.MAX), isRejected ? rejection_reason.trim() : null)
      .input("remarks", sql.NVarChar(sql.MAX), remarks !== undefined ? remarks : existingDocument.remarks)
      .query(`
        UPDATE CaseDocuments
        SET
          document_status_id = @document_status_id,
          verified_by = @verified_by,
          verified_at = GETDATE(),
          rejection_reason = @rejection_reason,
          remarks = @remarks,
          updated_at = GETDATE()
        OUTPUT INSERTED.*
        WHERE case_document_id = @case_document_id
      `);
    const updatedDocument = updateResult.recordset[0];

    if (["verified", "rejected"].includes(newStatus.status_name.toLowerCase())) {
      const matchingRequirement = await getMatchingRequirement(
        transaction,
        caseId,
        existingDocument.document_type_id,
        existingDocument.case_step_id
      );
      // getMatchingRequirement only returns Pending/Rejected rows, which is
      // still correct here: a prior Submitted requirement was already moved
      // out of that set, so re-verifying a resubmission still finds it via
      // its Rejected state; a first-time Verified pass may find nothing if
      // the requirement was never linked, and that's fine — it's optional.
      if (matchingRequirement) {
        await transaction
          .request()
          .input("requirement_id", sql.Int, matchingRequirement.requirement_id)
          .input("requirement_status", sql.VarChar(20), newStatus.status_name.toLowerCase() === "verified" ? "Verified" : "Rejected")
          .query("UPDATE CaseDocumentRequirements SET requirement_status = @requirement_status, updated_at = GETDATE() WHERE requirement_id = @requirement_id");
      }
    }

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: verifiedBy,
      activityType: "DOCUMENT_VERIFIED",
      entityType: "CASE_DOCUMENT",
      entityId: documentId,
      oldValue: String(existingDocument.document_status_id),
      newValue: newStatus.status_name,
      description: `Document "${existingDocument.document_name}" set to "${newStatus.status_name}".`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Document verification updated.", data: updatedDocument });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[verifyCaseDocument] Rollback failed:", rollbackErr);
      }
    }
    console.error("[verifyCaseDocument] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update document verification." });
  }
};

// ---------------------------------------------------------------------------
// DELETE /:caseId/documents/:documentId
// ---------------------------------------------------------------------------
export const deleteCaseDocument = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  const documentId = parsePositiveInt(req.params.documentId);
  if (!caseId || !documentId) {
    return res.status(400).json({ success: false, message: "A valid caseId and documentId are required." });
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
      .input("case_document_id", sql.Int, documentId)
      .input("case_id", sql.Int, caseId)
      .query("SELECT case_document_id, document_name, stored_file_name FROM CaseDocuments WHERE case_document_id = @case_document_id AND case_id = @case_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Document not found for this case." });
    }
    const existingDocument = existingResult.recordset[0];

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    await transaction
      .request()
      .input("case_document_id", sql.Int, documentId)
      .query("DELETE FROM CaseDocuments WHERE case_document_id = @case_document_id");

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: changedBy,
      activityType: "DOCUMENT_DELETED",
      entityType: "CASE_DOCUMENT",
      entityId: documentId,
      oldValue: existingDocument.document_name,
      newValue: null,
      description: `Document "${existingDocument.document_name}" deleted.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    await unlinkQuietly(absoluteUploadPath(existingDocument.stored_file_name));

    return res.status(200).json({ success: true, message: "Document deleted successfully." });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[deleteCaseDocument] Rollback failed:", rollbackErr);
      }
    }
    console.error("[deleteCaseDocument] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete document." });
  }
};
