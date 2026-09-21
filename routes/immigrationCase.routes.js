import express from "express"
import { verifyToken, authorize } from "../middleware/auth.middleware.js"
import { getMyImmigrationCases, getImmigrationCaseById } from "../controllers/immigrationCase.controller.js"


const router = express.Router()


router.get("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getMyImmigrationCases)
router.get("/:caseId", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getImmigrationCaseById)



export default router;