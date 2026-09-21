import express from "express"
import { verifyToken, authorize } from "../../middleware/auth.middleware.js"
import {
  getAllPaymentTypes,
  getPaymentTypeByStepId,
  getPaymentTypeById,
  createPaymentType,
  updatePaymentType,
  deletePaymentType,
} from "../../controllers/utils/paymentTypes.controller.js"


const router = express.Router()


router.get("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getAllPaymentTypes)

router.get("/:paymentTypeId", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getPaymentTypeById)

router.post("/", verifyToken, authorize(["Manager", "SuperAdmin"]), createPaymentType)

router.get("/:step_id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getPaymentTypeByStepId)

router.patch("/:paymentTypeId", verifyToken, authorize(["Manager", "SuperAdmin"]), updatePaymentType)

router.delete("/:paymentTypeId", verifyToken, authorize(["Manager", "SuperAdmin"]), deletePaymentType)

export default router;