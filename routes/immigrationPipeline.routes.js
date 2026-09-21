import express from "express"
import { verifyToken, authorize } from "../middleware/auth.middleware.js"
import { getStagesByProgram, getStepsByStage, getCasesByStep } from "../controllers/immigrationPipeline.controller.js"


const router = express.Router()

router.get("/:programId/stages", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getStagesByProgram)
router.get("/:programId/stages/:stageId/steps", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getStepsByStage)
router.get("/:programId/stages/:stageId/steps/:stepId/cases", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getCasesByStep)



export default router