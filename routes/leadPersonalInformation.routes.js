import express from "express"
import { verifyToken, authorize } from "../middleware/auth.middleware.js"
import { createLeadPersonalInformation, getLeadPersonalInformationByLeadId, getLeadPersonalInformationById, updateLeadPersonalInformation, deleteLeadPersonalInformation  } from "../controllers/leadPersonalInformation.controller.js"

const router = express.Router()

router.post("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), createLeadPersonalInformation)
router.get("/:id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getLeadPersonalInformationById)
router.get("/lead/:lead_id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getLeadPersonalInformationByLeadId)
router.put("/:id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), updateLeadPersonalInformation)
router.delete("/:id", verifyToken, authorize(["SuperAdmin"]), deleteLeadPersonalInformation)



export default router