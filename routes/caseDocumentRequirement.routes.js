import express from "express";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import {
  getCaseDocumentRequirements,
  createCaseDocumentRequirement,
  updateCaseDocumentRequirement,
  deleteCaseDocumentRequirement,
} from "../controllers/caseDocumentRequirement.controller.js";

const router = express.Router();

const ROLES = ["Manager", "Agent", "SuperAdmin"];

router.get("/:caseId", verifyToken, authorize(ROLES), getCaseDocumentRequirements);
router.post("/:caseId", verifyToken, authorize(ROLES), createCaseDocumentRequirement);
router.patch("/:caseId/:requirementId", verifyToken, authorize(ROLES), updateCaseDocumentRequirement);
router.delete("/:caseId/:requirementId", verifyToken, authorize(ROLES), deleteCaseDocumentRequirement);

export default router;
