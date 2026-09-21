import express from "express"
import { verifyToken, authorize } from "../../middleware/auth.middleware.js"
import { getAllPaymentTypes, getPaymentTypeByStepId } from "../../controllers/utils/paymentTypes.controller.js"


const router = express.Router()


router.get("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getAllPaymentTypes)

router.get("/:step_id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getPaymentTypeByStepId)

export default router;