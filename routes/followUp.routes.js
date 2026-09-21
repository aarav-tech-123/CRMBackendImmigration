import express from "express";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import {
  getFollowUpsForLead,
  getFollowUpsForCase,
  getMyFollowUps,
  createFollowUp,
  updateFollowUp,
  deleteFollowUp,
} from "../controllers/followUp.controller.js";

const router = express.Router();

const ROLES = ["Manager", "Agent", "SuperAdmin"];

router.get("/mine", verifyToken, authorize(ROLES), getMyFollowUps);
router.get("/lead/:leadId", verifyToken, authorize(ROLES), getFollowUpsForLead);
router.post("/lead/:leadId", verifyToken, authorize(ROLES), createFollowUp);
router.get("/case/:caseId", verifyToken, authorize(ROLES), getFollowUpsForCase);
router.patch("/:followupId", verifyToken, authorize(ROLES), updateFollowUp);
router.delete("/:followupId", verifyToken, authorize(ROLES), deleteFollowUp);

export default router;
