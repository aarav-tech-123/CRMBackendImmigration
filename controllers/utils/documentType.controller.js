import { sql, poolPromise } from "../../config/db.js";
import { createActivityLog } from "../../helpers/activityLogs.js";
import { getRequestInfo } from "../../helpers/requestInfo.js";
import { parsePositiveInt } from "../../helpers/parsers.js";

export const getAllDocumentTypes = async (req, res) => {
  try {
    const pool = await poolPromise;
    const includeInactive = req.query.includeInactive === "1";

    const result = await pool.request().query(`
      SELECT document_type_id, document_code, document_name, description, is_active, created_at
      FROM DocumentTypes
      ${includeInactive ? "" : "WHERE is_active = 1"}
      ORDER BY document_name
    `);

    res.json({ success: true, documentTypes: result.recordset });
  } catch (err) {
    console.error("Get All Document Types Error:", err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};


export const getDocumentTypeById = async (req, res) => {
  const documentTypeId = parsePositiveInt(req.params.documentTypeId);
  if (!documentTypeId) {
    return res.status(400).json({ success: false, message: "A valid documentTypeId is required." });
  }

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("document_type_id", sql.Int, documentTypeId)
      .query(`
        SELECT document_type_id, document_code, document_name, description, is_active, created_at
        FROM DocumentTypes
        WHERE document_type_id = @document_type_id
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Document type not found." });
    }

    res.json({ success: true, documentType: result.recordset[0] });
  } catch (err) {
    console.error("Get Document Type By ID Error:", err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};
// ---------------------------------------------------------------------------
// POST / — { document_code, document_name, description? }
// ---------------------------------------------------------------------------
export const createDocumentType = async (req, res) => {
  const { document_code, document_name, description } = req.body || {};
  const createdBy = req.user?.id;

  if (!document_code || !String(document_code).trim()) {
    return res.status(400).json({ success: false, message: "document_code is required." });
  }
  if (!document_name || !String(document_name).trim()) {
    return res.status(400).json({ success: false, message: "document_name is required." });
  }

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const insertResult = await transaction
      .request()
      .input("document_code", sql.VarChar(50), document_code.trim())
      .input("document_name", sql.NVarChar(255), document_name.trim())
      .input("description", sql.NVarChar(sql.MAX), description || null)
      .query(`
        INSERT INTO DocumentTypes (document_code, document_name, description, is_active, created_at)
        OUTPUT INSERTED.*
        VALUES (@document_code, @document_name, @description, 1, GETDATE())
      `);
    const createdType = insertResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: null,
      userId: createdBy,
      activityType: "DOCUMENT_TYPE_CREATED",
      entityType: "DOCUMENT_TYPE",
      entityId: createdType.document_type_id,
      oldValue: null,
      newValue: createdType.document_name,
      description: `Document type "${createdType.document_name}" created.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(201).json({ success: true, message: "Document type created successfully.", data: createdType });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[createDocumentType] Rollback failed:", rollbackErr);
      }
    }
    console.error("[createDocumentType] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to create document type." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /:documentTypeId — { document_code?, document_name?, description?, is_active? }
// ---------------------------------------------------------------------------
export const updateDocumentType = async (req, res) => {
  const documentTypeId = parsePositiveInt(req.params.documentTypeId);
  if (!documentTypeId) {
    return res.status(400).json({ success: false, message: "A valid documentTypeId is required." });
  }

  const { document_code, document_name, description, is_active } = req.body || {};
  const changedBy = req.user?.id;

  if (document_code !== undefined && !String(document_code).trim()) {
    return res.status(400).json({ success: false, message: "document_code cannot be empty." });
  }
  if (document_name !== undefined && !String(document_name).trim()) {
    return res.status(400).json({ success: false, message: "document_name cannot be empty." });
  }

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const existingResult = await pool
      .request()
      .input("document_type_id", sql.Int, documentTypeId)
      .query("SELECT * FROM DocumentTypes WHERE document_type_id = @document_type_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Document type not found." });
    }
    const existingType = existingResult.recordset[0];

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const updateResult = await transaction
      .request()
      .input("document_type_id", sql.Int, documentTypeId)
      .input("document_code", sql.VarChar(50), document_code !== undefined ? document_code.trim() : existingType.document_code)
      .input("document_name", sql.NVarChar(255), document_name !== undefined ? document_name.trim() : existingType.document_name)
      .input("description", sql.NVarChar(sql.MAX), description !== undefined ? description : existingType.description)
      .input("is_active", sql.Bit, is_active !== undefined ? (is_active ? 1 : 0) : existingType.is_active)
      .query(`
        UPDATE DocumentTypes
        SET document_code = @document_code, document_name = @document_name,
            description = @description, is_active = @is_active
        OUTPUT INSERTED.*
        WHERE document_type_id = @document_type_id
      `);
    const updatedType = updateResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: null,
      userId: changedBy,
      activityType: "DOCUMENT_TYPE_UPDATED",
      entityType: "DOCUMENT_TYPE",
      entityId: documentTypeId,
      oldValue: existingType.document_name,
      newValue: updatedType.document_name,
      description: `Document type "${updatedType.document_name}" updated.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Document type updated successfully.", data: updatedType });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[updateDocumentType] Rollback failed:", rollbackErr);
      }
    }
    console.error("[updateDocumentType] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update document type." });
  }
};

// ---------------------------------------------------------------------------
// DELETE /:documentTypeId — soft-delete (is_active = 0); DocumentTypes is
// referenced by CaseDocumentRequirements/CaseDocuments, so a hard delete
// would either fail on the FK or silently orphan history.
// ---------------------------------------------------------------------------
export const deleteDocumentType = async (req, res) => {
  const documentTypeId = parsePositiveInt(req.params.documentTypeId);
  if (!documentTypeId) {
    return res.status(400).json({ success: false, message: "A valid documentTypeId is required." });
  }
  const changedBy = req.user?.id;

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const existingResult = await pool
      .request()
      .input("document_type_id", sql.Int, documentTypeId)
      .query("SELECT document_type_id, document_name, is_active FROM DocumentTypes WHERE document_type_id = @document_type_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Document type not found." });
    }
    const existingType = existingResult.recordset[0];

    if (!existingType.is_active) {
      return res.status(400).json({ success: false, message: "Document type is already inactive." });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    await transaction
      .request()
      .input("document_type_id", sql.Int, documentTypeId)
      .query("UPDATE DocumentTypes SET is_active = 0 WHERE document_type_id = @document_type_id");

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: null,
      userId: changedBy,
      activityType: "DOCUMENT_TYPE_DEACTIVATED",
      entityType: "DOCUMENT_TYPE",
      entityId: documentTypeId,
      oldValue: "active",
      newValue: "inactive",
      description: `Document type "${existingType.document_name}" deactivated.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Document type deactivated successfully." });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[deleteDocumentType] Rollback failed:", rollbackErr);
      }
    }
    console.error("[deleteDocumentType] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to deactivate document type." });
  }
};
