import express from "express";
import { verifyToken, authorize } from "../../middleware/auth.middleware.js";
import {
  getPnpPrograms,
  getPnpProgramById,
  createPnpProgram,
  updatePnpProgram,
  deletePnpProgram,
} from "../../controllers/utils/pnpProgram.controller.js";

const router = express.Router();

const READ_ROLES = ["Manager", "Agent", "SuperAdmin"];
const WRITE_ROLES = ["Manager", "SuperAdmin"];

router.get("/", verifyToken, authorize(READ_ROLES), getPnpPrograms);
router.get("/:pnpProgramId", verifyToken, authorize(READ_ROLES), getPnpProgramById);
router.post("/", verifyToken, authorize(WRITE_ROLES), createPnpProgram);
router.patch("/:pnpProgramId", verifyToken, authorize(WRITE_ROLES), updatePnpProgram);
router.delete("/:pnpProgramId", verifyToken, authorize(WRITE_ROLES), deletePnpProgram);

export default router;
