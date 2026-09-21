import { sql, poolPromise } from "../../config/db.js";
import { createActivityLog } from "../../helpers/activityLogs.js";
import { getRequestInfo } from "../../helpers/requestInfo.js";
import { parsePositiveInt } from "../../helpers/parsers.js";

export const getAllPaymentTypes = async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .query("SELECT * FROM PaymentTypes ORDER BY payment_type_id DESC");
    res.json(result.recordset);
  } catch (err) {
    console.error("Get All Payment Types Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};


export const getPaymentTypeById = async (req, res) => {
  const paymentTypeId = parsePositiveInt(req.params.paymentTypeId);

  if (!paymentTypeId) {
    return res.status(400).json({ message: "A valid paymentTypeId is required." });
  }

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("payment_type_id", sql.Int, paymentTypeId)
      .query("SELECT * FROM PaymentTypes WHERE payment_type_id = @payment_type_id");
    
    if (result.recordset.length === 0) {
      return res.status(404).json({ message: "Payment type not found." });
    }

    res.json(result.recordset[0]);
  } catch (err) {
    console.error("Get Payment Type By ID Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};



export const getPaymentTypeByStepId = async (req, res) => {
  const { step_id } = req.params;

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("stepId", step_id)
      .query("SELECT * FROM PaymentTypes WHERE step_id = @stepId ORDER BY payment_type_id DESC");
    res.json(result.recordset);
  } catch (err) {
    console.error("Get Payment Type By Step ID Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

// ---------------------------------------------------------------------------
// POST / — { payment_type_name, step_id? }
// step_id isn't cross-validated against any other table here — the existing
// read endpoints don't join it to anything either, so I can't confirm what
// it's meant to reference. Flag it if it should be validated against
// WorkflowSteps or similar.
// ---------------------------------------------------------------------------
export const createPaymentType = async (req, res) => {
  const { payment_type_name, step_id } = req.body || {};
  const createdBy = req.user?.id;

  if (!payment_type_name || !String(payment_type_name).trim()) {
    return res.status(400).json({ success: false, message: "payment_type_name is required." });
  }

  let stepId = parsePositiveInt(step_id);
  if (step_id !== undefined && step_id !== null && step_id !== "" && !stepId) {
    return res.status(400).json({ success: false, message: "Invalid step_id." });
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
      .input("payment_type_name", sql.NVarChar(255), payment_type_name.trim())
      .input("step_id", sql.Int, stepId)
      .query(`
        INSERT INTO PaymentTypes (payment_type_name, step_id)
        OUTPUT INSERTED.*
        VALUES (@payment_type_name, @step_id)
      `);
    const createdType = insertResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: null,
      userId: createdBy,
      activityType: "PAYMENT_TYPE_CREATED",
      entityType: "PAYMENT_TYPE",
      entityId: createdType.payment_type_id,
      oldValue: null,
      newValue: createdType.payment_type_name,
      description: `Payment type "${createdType.payment_type_name}" created.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(201).json({ success: true, message: "Payment type created successfully.", data: createdType });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[createPaymentType] Rollback failed:", rollbackErr);
      }
    }
    console.error("[createPaymentType] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to create payment type." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /:paymentTypeId — { payment_type_name?, step_id? }
// ---------------------------------------------------------------------------
export const updatePaymentType = async (req, res) => {
  const paymentTypeId = parsePositiveInt(req.params.paymentTypeId);
  if (!paymentTypeId) {
    return res.status(400).json({ success: false, message: "A valid paymentTypeId is required." });
  }

  const { payment_type_name, step_id } = req.body || {};
  const changedBy = req.user?.id;

  if (payment_type_name !== undefined && !String(payment_type_name).trim()) {
    return res.status(400).json({ success: false, message: "payment_type_name cannot be empty." });
  }

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const existingResult = await pool
      .request()
      .input("payment_type_id", sql.Int, paymentTypeId)
      .query("SELECT * FROM PaymentTypes WHERE payment_type_id = @payment_type_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Payment type not found." });
    }
    const existingType = existingResult.recordset[0];

    let stepId = existingType.step_id;
    if (step_id !== undefined) {
      stepId = parsePositiveInt(step_id);
      if (step_id !== null && step_id !== "" && !stepId) {
        return res.status(400).json({ success: false, message: "Invalid step_id." });
      }
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const updateResult = await transaction
      .request()
      .input("payment_type_id", sql.Int, paymentTypeId)
      .input("payment_type_name", sql.NVarChar(255), payment_type_name !== undefined ? payment_type_name.trim() : existingType.payment_type_name)
      .input("step_id", sql.Int, stepId)
      .query(`
        UPDATE PaymentTypes
        SET payment_type_name = @payment_type_name, step_id = @step_id
        OUTPUT INSERTED.*
        WHERE payment_type_id = @payment_type_id
      `);
    const updatedType = updateResult.recordset[0];

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: null,
      userId: changedBy,
      activityType: "PAYMENT_TYPE_UPDATED",
      entityType: "PAYMENT_TYPE",
      entityId: paymentTypeId,
      oldValue: existingType.payment_type_name,
      newValue: updatedType.payment_type_name,
      description: `Payment type "${updatedType.payment_type_name}" updated.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Payment type updated successfully.", data: updatedType });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[updatePaymentType] Rollback failed:", rollbackErr);
      }
    }
    console.error("[updatePaymentType] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update payment type." });
  }
};

// ---------------------------------------------------------------------------
// DELETE /:paymentTypeId — hard delete (no is_active column exists here).
// Payments.payment_type_id references this table, so a type still in use
// will fail the FK constraint — caught below and returned as a 409 instead
// of a generic 500.
// ---------------------------------------------------------------------------
export const deletePaymentType = async (req, res) => {
  const paymentTypeId = parsePositiveInt(req.params.paymentTypeId);
  if (!paymentTypeId) {
    return res.status(400).json({ success: false, message: "A valid paymentTypeId is required." });
  }
  const changedBy = req.user?.id;

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const existingResult = await pool
      .request()
      .input("payment_type_id", sql.Int, paymentTypeId)
      .query("SELECT payment_type_id, payment_type_name FROM PaymentTypes WHERE payment_type_id = @payment_type_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Payment type not found." });
    }
    const existingType = existingResult.recordset[0];

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    await transaction
      .request()
      .input("payment_type_id", sql.Int, paymentTypeId)
      .query("DELETE FROM PaymentTypes WHERE payment_type_id = @payment_type_id");

    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: null,
      userId: changedBy,
      activityType: "PAYMENT_TYPE_DELETED",
      entityType: "PAYMENT_TYPE",
      entityId: paymentTypeId,
      oldValue: existingType.payment_type_name,
      newValue: null,
      description: `Payment type "${existingType.payment_type_name}" deleted.`,
      ipAddress,
      userAgent,
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Payment type deleted successfully." });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[deletePaymentType] Rollback failed:", rollbackErr);
      }
    }

    if (err.number === 547) {
      return res.status(409).json({
        success: false,
        message: "This payment type is still referenced by existing payments and cannot be deleted.",
      });
    }

    console.error("[deletePaymentType] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete payment type." });
  }
};
