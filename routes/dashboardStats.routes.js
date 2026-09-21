import express from "express"
import { verifyToken, authorize } from "../middleware/auth.middleware.js"
import { getStageWiseCounts, getDashboardSummary, getLeadStatusCountsByUser } from "../controllers/dashboardStats.controller.js"

const router = express.Router()

router.get("/summary", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getStageWiseCounts)
router.get("/stage-counts", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getDashboardSummary)
router.get("/lead-status-by-user", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getLeadStatusCountsByUser)



export default router



// GET /summary?programId=optional
// GET /stage-counts?programId=optional