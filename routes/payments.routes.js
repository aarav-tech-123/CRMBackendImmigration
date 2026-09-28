import express from "express";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import {
  getCasePaymentFlow,
  getCasePayments,
  getPaymentById,
  createCasePayment,
  updatePayment,
} from "../controllers/payments.controller.js";

const router = express.Router();

const ROLES = ["Manager", "Agent", "SuperAdmin"];

router.get("/case/:caseId/flow", verifyToken, authorize(ROLES), getCasePaymentFlow);
router.get("/case/:caseId", verifyToken, authorize(ROLES), getCasePayments);
router.post("/case/:caseId", verifyToken, authorize(ROLES), createCasePayment);

router.get("/:paymentId", verifyToken, authorize(ROLES), getPaymentById);
router.patch("/:paymentId", verifyToken, authorize(ROLES), updatePayment);

export default router;
