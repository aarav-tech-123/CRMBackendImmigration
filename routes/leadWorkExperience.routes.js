import express from "express"
import { verifyToken, authorize } from "../middleware/auth.middleware.js"
import { createLeadWorkExperience, getLeadWorkExperienceById, getLeadWorkExperiencesByLeadId, updateLeadWorkExperience, deleteLeadWorkExperience  } from "../controllers/leadWorkExperience.controller.js"

const router = express.Router()

router.post("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), createLeadWorkExperience)
router.get("/:id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getLeadWorkExperienceById)
router.get("/lead/:lead_id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getLeadWorkExperiencesByLeadId)
router.put("/:id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), updateLeadWorkExperience)
router.delete("/:id", verifyToken, authorize(["SuperAdmin"]), deleteLeadWorkExperience)



export default router