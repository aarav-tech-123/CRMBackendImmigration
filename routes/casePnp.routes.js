import express from "express";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import {
  getCasePnpPrograms,
  addCasePnpPrograms,
  updateCasePnpProgram,
  removeCasePnpProgram,
} from "../controllers/casePnp.controller.js";

const router = express.Router();

const ROLES = ["Manager", "Agent", "SuperAdmin"];

router.get("/:caseId", verifyToken, authorize(ROLES), getCasePnpPrograms);
router.post("/:caseId", verifyToken, authorize(ROLES), addCasePnpPrograms);
router.patch("/:caseId/:casePnpId", verifyToken, authorize(ROLES), updateCasePnpProgram);
router.delete("/:caseId/:casePnpId", verifyToken, authorize(ROLES), removeCasePnpProgram);

export default router;
