import express from "express"
import { verifyToken, authorize } from "../middleware/auth.middleware.js"
import { createLeadEducation, getLeadEducationById, getLeadEducationByLeadId, updateLeadEducation, deleteLeadEducation  } from "../controllers/leadEducation.controller.js"

const router = express.Router()

router.post("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), createLeadEducation)
router.get("/:id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getLeadEducationById)
router.get("/lead/:lead_id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getLeadEducationByLeadId)
router.put("/:id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), updateLeadEducation)
router.delete("/:id", verifyToken, authorize(["SuperAdmin"]), deleteLeadEducation)



export default router