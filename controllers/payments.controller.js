import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";
import { getRequestInfo } from "../helpers/requestInfo.js";
import { parsePositiveInt } from "../helpers/parsers.js";
import { getCaseOrNull } from "../helpers/caseHelpers.js";

// "Paid" / "Pending" are what leads.controller.js writes during lead -> case
// conversion; the rest cover the remaining lifecycle of a payment.
const PAYMENT_STATUSES = ["Pending", "Paid", "Failed", "Refunded", "Cancelled"];
const DEFAULT_CURRENCY = "CAD";

// A step counts as "reached" once the case has started it.
const REACHED_STEP_STATUSES = ["In Progress", "Completed"];

const isProvided = (value) => value !== undefined && value !== null && value !== "";

const PAYMENT_SELECT = `
  SELECT
    p.payment_id, p.lead_id, p.case_id, p.payment_type_id, p.receipt_number,
    p.amount, p.currency_code, p.payment_method, p.payment_status,
    p.transaction_reference, p.payment_date, p.received_by, p.remarks,
    p.created_at, p.updated_at,
    pt.payment_type_name, pt.step_id,
    wst.step_code, wst.step_name,
    ws.stage_id, ws.stage_code, ws.stage_name,
    u.name AS received_by_name
  FROM Payments p
  LEFT JOIN PaymentTypes pt ON pt.payment_type_id = p.payment_type_id
  LEFT JOIN WorkflowSteps wst ON wst.workflow_step_id = pt.step_id
  LEFT JOIN WorkflowStages ws ON ws.stage_id = wst.stage_id
  LEFT JOIN Users u ON u.id = p.received_by
`;

const getPaymentOrNull = async (executor, paymentId) => {
  const result = await executor
    .request()
    .input("payment_id", sql.BigInt, paymentId)
    .query(`${PAYMENT_SELECT} WHERE p.payment_id = @payment_id`);
  return result.recordset[0] || null;
};

// Sums amounts per currency, since a case can mix currencies.
const sumByCurrency = (payments) =>
  payments.reduce((acc, p) => {
    acc[p.currency_code] = Number(((acc[p.currency_code] || 0) + Number(p.amount)).toFixed(2));
    return acc;
  }, {});

// Validates the shared payment fields. `existing` is the current row on update
// (fields left out of the body keep their value), or null on create.
const validatePaymentBody = async (pool, body, existing) => {
  const errors = [];
  const out = {};

  if (!existing || body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!isProvided(body.amount) || !Number.isFinite(amount) || amount <= 0) {
      errors.push("amount must be a number greater than 0.");
    } else {
      out.amount = amount;
    }
  }

  if (body.currency_code !== undefined || !existing) {
    const currency = String(body.currency_code || DEFAULT_CURRENCY).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      errors.push("currency_code must be a 3-letter ISO code (e.g. CAD, USD).");
    } else {
      out.currency_code = currency;
    }
  }

  if (body.payment_status !== undefined || !existing) {
    const status = body.payment_status || "Pending";
    if (!PAYMENT_STATUSES.includes(status)) {
      errors.push(`payment_status must be one of: ${PAYMENT_STATUSES.join(", ")}.`);
    } else {
      out.payment_status = status;
    }
  }

  if (isProvided(body.payment_date)) {
    const date = new Date(body.payment_date);
    if (Number.isNaN(date.getTime())) {
      errors.push("Invalid payment_date.");
    } else {
      out.payment_date = date;
    }
  }

  if (isProvided(body.received_by)) {
    const receivedBy = parsePositiveInt(body.received_by);
    if (!receivedBy) {
      errors.push("Invalid received_by.");
    } else {
      const userCheck = await pool.request().input("id", sql.Int, receivedBy).query("SELECT id FROM Users WHERE id = @id");
      if (userCheck.recordset.length === 0) {
        errors.push("received_by user does not exist.");
      } else {
        out.received_by = receivedBy;
      }
    }
  }

  if (isProvided(body.transaction_reference)) {
    const reference = String(body.transaction_reference).trim();
    const duplicate = await pool
      .request()
      .input("transaction_reference", sql.NVarChar(200), reference)
      .input("payment_id", sql.BigInt, existing ? existing.payment_id : null)
      .query(`
        SELECT TOP 1 payment_id FROM Payments
        WHERE transaction_reference = @transaction_reference
          AND (@payment_id IS NULL OR payment_id <> @payment_id)
      `);
    if (duplicate.recordset.length > 0) {
      errors.push(`transaction_reference '${reference}' already exists on another payment.`);
    } else {
      out.transaction_reference = reference;
    }
  }

  for (const field of ["receipt_number", "payment_method", "remarks"]) {
    if (body[field] !== undefined) {
      out[field] = isProvided(body[field]) ? String(body[field]).trim() : null;
    }
  }

  return { errors, values: out };
};

// ---------------------------------------------------------------------------
// GET /case/:caseId/flow — step-by-step payment flow for a case
//
// One entry per PaymentType linked to a WorkflowStep in the case's program,
// ordered by stage and step, with the case's progress on that step and the
// payments recorded against it. payment_state is one of:
//   Paid     - at least one payment is Paid
//   Pending  - payments exist but none is Paid yet
//   Due      - the step has been reached and nothing has been recorded
//   Upcoming - the step hasn't been reached yet
// Payments whose type has no step (e.g. "Other") are listed under other_payments.
// ---------------------------------------------------------------------------
export const getCasePaymentFlow = async (req, res) => {
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

    const [flowResult, paymentsResult] = await Promise.all([
      pool
        .request()
        .input("case_id", sql.Int, caseId)
        .input("program_id", sql.Int, caseRow.program_id)
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
            WHERE cst.case_id = @case_id
          )
          SELECT
            pt.payment_type_id, pt.payment_type_name, pt.step_id,
            wst.step_code, wst.step_name, wst.sort_order,
            ws.stage_id, ws.stage_code, ws.stage_name, ws.stage_no,
            ccs.case_step_id, ccs.step_status,
            ccs.started_at AS step_started_at, ccs.completed_at AS step_completed_at
          FROM PaymentTypes pt
          INNER JOIN WorkflowSteps wst ON wst.workflow_step_id = pt.step_id
          INNER JOIN WorkflowStages ws ON ws.stage_id = wst.stage_id
          LEFT JOIN CurrentCaseStep ccs
                 ON ccs.workflow_step_id = pt.step_id
                AND ccs.rn = 1
          WHERE ws.program_id = @program_id
          ORDER BY ws.stage_no, wst.sort_order, pt.payment_type_id;
        `),
      pool
        .request()
        .input("case_id", sql.Int, caseId)
        .query(`${PAYMENT_SELECT} WHERE p.case_id = @case_id ORDER BY p.payment_date ASC, p.payment_id ASC`),
    ]);

    const payments = paymentsResult.recordset;
    const flowTypeIds = new Set(flowResult.recordset.map((row) => row.payment_type_id));

    const flow = flowResult.recordset.map((row) => {
      const typePayments = payments.filter((p) => p.payment_type_id === row.payment_type_id);
      const paid = typePayments.filter((p) => p.payment_status === "Paid");
      const pending = typePayments.filter((p) => p.payment_status === "Pending");

      let paymentState;
      if (paid.length > 0) paymentState = "Paid";
      else if (pending.length > 0) paymentState = "Pending";
      else if (REACHED_STEP_STATUSES.includes(row.step_status)) paymentState = "Due";
      else paymentState = "Upcoming";

      return {
        ...row,
        payment_state: paymentState,
        total_paid: sumByCurrency(paid),
        total_pending: sumByCurrency(pending),
        payments: typePayments,
      };
    });

    const otherPayments = payments.filter((p) => !flowTypeIds.has(p.payment_type_id));

    const count = (state) => flow.filter((f) => f.payment_state === state).length;

    return res.status(200).json({
      success: true,
      caseId,
      programId: caseRow.program_id,
      summary: {
        steps_with_payments: flow.length,
        paid: count("Paid"),
        pending: count("Pending"),
        due: count("Due"),
        upcoming: count("Upcoming"),
        total_paid: sumByCurrency(payments.filter((p) => p.payment_status === "Paid")),
        total_pending: sumByCurrency(payments.filter((p) => p.payment_status === "Pending")),
      },
      flow,
      other_payments: otherPayments,
    });
  } catch (err) {
    console.error("[getCasePaymentFlow] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch case payment flow." });
  }
};

// ---------------------------------------------------------------------------
// GET /case/:caseId?status=&stepId= — all payments on a case
// ---------------------------------------------------------------------------
export const getCasePayments = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }

  const status = req.query.status || null;
  if (status && !PAYMENT_STATUSES.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `status must be one of: ${PAYMENT_STATUSES.join(", ")}.`,
    });
  }

  let stepId = null;
  if (isProvided(req.query.stepId)) {
    stepId = parsePositiveInt(req.query.stepId);
    if (!stepId) {
      return res.status(400).json({ success: false, message: "Invalid stepId." });
    }
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
      .input("status", sql.NVarChar(100), status)
      .input("step_id", sql.Int, stepId)
      .query(`
        ${PAYMENT_SELECT}
        WHERE p.case_id = @case_id
          AND (@status IS NULL OR p.payment_status = @status)
          AND (@step_id IS NULL OR pt.step_id = @step_id)
        ORDER BY p.payment_date DESC, p.payment_id DESC;
      `);

    return res.status(200).json({ success: true, caseId, payments: result.recordset });
  } catch (err) {
    console.error("[getCasePayments] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch case payments." });
  }
};

// ---------------------------------------------------------------------------
// GET /:paymentId
// ---------------------------------------------------------------------------
export const getPaymentById = async (req, res) => {
  const paymentId = parsePositiveInt(req.params.paymentId);
  if (!paymentId) {
    return res.status(400).json({ success: false, message: "A valid paymentId is required." });
  }

  try {
    const pool = await poolPromise;
    const payment = await getPaymentOrNull(pool, paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment not found." });
    }
    return res.status(200).json({ success: true, data: payment });
  } catch (err) {
    console.error("[getPaymentById] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch payment." });
  }
};

// ---------------------------------------------------------------------------
// POST /case/:caseId — record a payment against a case step
//
// Body: { payment_type_id, amount, currency_code?, payment_method?,
//         payment_status?, transaction_reference?, receipt_number?,
//         payment_date?, received_by?, remarks? }
// The payment type must be tied to a step in the case's program, or be a
// step-less type such as "Other".
// ---------------------------------------------------------------------------
export const createCasePayment = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) {
    return res.status(400).json({ success: false, message: "A valid caseId is required." });
  }

  const body = req.body || {};
  const createdBy = req.user?.id;

  const paymentTypeId = parsePositiveInt(body.payment_type_id);
  if (!paymentTypeId) {
    return res.status(400).json({ success: false, message: "A valid payment_type_id is required." });
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
      return res.status(400).json({ success: false, message: "Cannot record a payment on a closed case." });
    }

    const typeResult = await pool
      .request()
      .input("payment_type_id", sql.Int, paymentTypeId)
      .query(`
        SELECT pt.payment_type_id, pt.payment_type_name, pt.step_id,
               wst.step_name, ws.stage_name, ws.program_id
        FROM PaymentTypes pt
        LEFT JOIN WorkflowSteps wst ON wst.workflow_step_id = pt.step_id
        LEFT JOIN WorkflowStages ws ON ws.stage_id = wst.stage_id
        WHERE pt.payment_type_id = @payment_type_id
      `);
    if (typeResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Payment type not found." });
    }
    const paymentType = typeResult.recordset[0];

    if (paymentType.step_id && paymentType.program_id !== caseRow.program_id) {
      return res.status(400).json({
        success: false,
        message: "This payment type belongs to a step outside this case's immigration program.",
      });
    }

    const { errors, values } = await validatePaymentBody(pool, body, null);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: errors[0], errors });
    }

    const receivedBy = values.received_by ?? createdBy ?? null;

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const insertResult = await transaction
      .request()
      .input("lead_id", sql.Int, caseRow.lead_id)
      .input("case_id", sql.Int, caseId)
      .input("payment_type_id", sql.Int, paymentTypeId)
      .input("receipt_number", sql.NVarChar(100), values.receipt_number ?? null)
      .input("amount", sql.Decimal(18, 2), values.amount)
      .input("currency_code", sql.Char(3), values.currency_code)
      .input("payment_method", sql.NVarChar(50), values.payment_method ?? null)
      .input("payment_status", sql.NVarChar(50), values.payment_status)
      .input("transaction_reference", sql.NVarChar(200), values.transaction_reference ?? null)
      .input("payment_date", sql.DateTime2, values.payment_date ?? new Date())
      .input("received_by", sql.Int, receivedBy)
      .input("remarks", sql.NVarChar(sql.MAX), values.remarks ?? null)
      .query(`
        INSERT INTO Payments (
          lead_id, case_id, payment_type_id, receipt_number, amount, currency_code,
          payment_method, payment_status, transaction_reference, payment_date,
          received_by, remarks, created_at, updated_at
        )
        OUTPUT INSERTED.payment_id
        VALUES (
          @lead_id, @case_id, @payment_type_id, @receipt_number, @amount, @currency_code,
          @payment_method, @payment_status, @transaction_reference, @payment_date,
          @received_by, @remarks, GETDATE(), GETDATE()
        )
      `);
    const paymentId = insertResult.recordset[0].payment_id;

    const stepLabel = paymentType.step_id ? ` for "${paymentType.stage_name} - ${paymentType.step_name}"` : "";
    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: caseRow.lead_id,
      caseId,
      userId: createdBy,
      activityType: "PAYMENT_RECORDED",
      entityType: "PAYMENT",
      entityId: Number(paymentId),
      oldValue: null,
      newValue: values.payment_status,
      description: `${paymentType.payment_type_name} of ${values.amount} ${values.currency_code} recorded as ${values.payment_status}${stepLabel}.`,
      ipAddress,
      userAgent,
    });

    const payment = await getPaymentOrNull(transaction, paymentId);

    await transaction.commit();
    transactionStarted = false;

    return res.status(201).json({ success: true, message: "Payment recorded successfully.", data: payment });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[createCasePayment] Rollback failed:", rollbackErr);
      }
    }
    console.error("[createCasePayment] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to record payment." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /:paymentId — update a payment (e.g. Pending -> Paid, add a receipt no.)
//
// Body: any of { amount, currency_code, payment_method, payment_status,
//                transaction_reference, receipt_number, payment_date,
//                received_by, remarks }
// payment_type_id is intentionally not editable: record a new payment instead.
// ---------------------------------------------------------------------------
export const updatePayment = async (req, res) => {
  const paymentId = parsePositiveInt(req.params.paymentId);
  if (!paymentId) {
    return res.status(400).json({ success: false, message: "A valid paymentId is required." });
  }

  const body = req.body || {};
  const changedBy = req.user?.id;

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const existing = await getPaymentOrNull(pool, paymentId);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Payment not found." });
    }

    if (existing.case_id) {
      const caseRow = await getCaseOrNull(pool, existing.case_id);
      if (caseRow?.closed_at) {
        return res.status(400).json({ success: false, message: "Cannot change a payment on a closed case." });
      }
    }

    const { errors, values } = await validatePaymentBody(pool, body, existing);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: errors[0], errors });
    }
    if (Object.keys(values).length === 0) {
      return res.status(400).json({ success: false, message: "No updatable fields were provided." });
    }

    const merged = { ...existing, ...values };

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    await transaction
      .request()
      .input("payment_id", sql.BigInt, paymentId)
      .input("receipt_number", sql.NVarChar(100), merged.receipt_number)
      .input("amount", sql.Decimal(18, 2), merged.amount)
      .input("currency_code", sql.Char(3), merged.currency_code)
      .input("payment_method", sql.NVarChar(50), merged.payment_method)
      .input("payment_status", sql.NVarChar(50), merged.payment_status)
      .input("transaction_reference", sql.NVarChar(200), merged.transaction_reference)
      .input("payment_date", sql.DateTime2, merged.payment_date)
      .input("received_by", sql.Int, merged.received_by)
      .input("remarks", sql.NVarChar(sql.MAX), merged.remarks)
      .query(`
        UPDATE Payments
        SET
          receipt_number = @receipt_number,
          amount = @amount,
          currency_code = @currency_code,
          payment_method = @payment_method,
          payment_status = @payment_status,
          transaction_reference = @transaction_reference,
          payment_date = @payment_date,
          received_by = @received_by,
          remarks = @remarks,
          updated_at = GETDATE()
        WHERE payment_id = @payment_id
      `);

    const statusChanged = existing.payment_status !== merged.payment_status;
    const { ipAddress, userAgent } = getRequestInfo(req);
    await createActivityLog({
      transaction,
      leadId: existing.lead_id,
      caseId: existing.case_id,
      userId: changedBy,
      activityType: statusChanged ? "PAYMENT_STATUS_CHANGED" : "PAYMENT_UPDATED",
      entityType: "PAYMENT",
      entityId: paymentId,
      oldValue: statusChanged ? existing.payment_status : null,
      newValue: statusChanged ? merged.payment_status : null,
      description: statusChanged
        ? `${existing.payment_type_name || "Payment"} ${paymentId} changed from "${existing.payment_status}" to "${merged.payment_status}".`
        : `${existing.payment_type_name || "Payment"} ${paymentId} updated (${Object.keys(values).join(", ")}).`,
      ipAddress,
      userAgent,
    });

    const payment = await getPaymentOrNull(transaction, paymentId);

    await transaction.commit();
    transactionStarted = false;

    return res.status(200).json({ success: true, message: "Payment updated successfully.", data: payment });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[updatePayment] Rollback failed:", rollbackErr);
      }
    }
    console.error("[updatePayment] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update payment." });
  }
};
