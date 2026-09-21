import express from "express";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import {
  getCaseStageHistory,
  getCurrentCaseStage,
  getAvailableTransitions,
  advanceCaseStage,
  getCaseSteps,
  updateCaseStepStatus,
  assignCase,
  getCaseActivityLog,
  getCaseStatusHistory,
  getCaseAssignmentHistory,
} from "../controllers/caseWorkflow.controller.js";

const router = express.Router();

const ROLES = ["Manager", "Agent", "SuperAdmin"];

router.get("/:caseId/stages", verifyToken, authorize(ROLES), getCaseStageHistory);
router.get("/:caseId/stages/current", verifyToken, authorize(ROLES), getCurrentCaseStage);
router.post("/:caseId/stages/advance", verifyToken, authorize(ROLES), advanceCaseStage);
router.get("/:caseId/transitions", verifyToken, authorize(ROLES), getAvailableTransitions);

router.get("/:caseId/steps", verifyToken, authorize(ROLES), getCaseSteps);
router.patch("/:caseId/steps/:caseStepId", verifyToken, authorize(ROLES), updateCaseStepStatus);

router.post("/:caseId/assign", verifyToken, authorize(ROLES), assignCase);

router.get("/:caseId/activity-log", verifyToken, authorize(ROLES), getCaseActivityLog);
router.get("/:caseId/status-history", verifyToken, authorize(ROLES), getCaseStatusHistory);
router.get("/:caseId/assignment-history", verifyToken, authorize(ROLES), getCaseAssignmentHistory);

export default router;
