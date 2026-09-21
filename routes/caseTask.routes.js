import express from "express";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import {
  getCaseTasks,
  getCaseTaskById,
  createCaseTask,
  updateCaseTask,
  deleteCaseTask,
} from "../controllers/caseTask.controller.js";

const router = express.Router();

const ROLES = ["Manager", "Agent", "SuperAdmin"];

router.get("/:caseId", verifyToken, authorize(ROLES), getCaseTasks);
router.get("/:caseId/:taskId", verifyToken, authorize(ROLES), getCaseTaskById);
router.post("/:caseId", verifyToken, authorize(ROLES), createCaseTask);
router.patch("/:caseId/:taskId", verifyToken, authorize(ROLES), updateCaseTask);
router.delete("/:caseId/:taskId", verifyToken, authorize(ROLES), deleteCaseTask);

export default router;
