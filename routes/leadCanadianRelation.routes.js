import express from "express"
import { verifyToken, authorize } from "../middleware/auth.middleware.js"
import { createLeadCanadianRelation, getLeadCanadianRelationById, getLeadCanadianRelationsByLeadId, updateLeadCanadianRelation, deleteLeadCanadianRelation  } from "../controllers/leadCanadianRelation.controller.js"

const router = express.Router()

router.post("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), createLeadCanadianRelation)
router.get("/:id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getLeadCanadianRelationById)
router.get("/lead/:lead_id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getLeadCanadianRelationsByLeadId)
router.put("/:id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), updateLeadCanadianRelation)
router.delete("/:id", verifyToken, authorize(["SuperAdmin"]), deleteLeadCanadianRelation)



export default router