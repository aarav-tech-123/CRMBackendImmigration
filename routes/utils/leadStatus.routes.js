import express from "express"
import { verifyToken, authorize } from "../../middleware/auth.middleware.js"
import {
  getAllLeadStatuses,
  createLeadStatus,
  updateLeadStatus,
  deleteLeadStatus
} from "../../controllers/utils/leadStatus.controller.js"


const router = express.Router()


router.get("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getAllLeadStatuses)
router.post("/", verifyToken, authorize(["SuperAdmin"]), createLeadStatus)
router.put("/:id", verifyToken, authorize(["SuperAdmin"]), updateLeadStatus)
router.delete("/:id", verifyToken, authorize(["SuperAdmin"]), deleteLeadStatus)



export default router;