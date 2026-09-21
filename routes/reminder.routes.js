import express from "express";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import {
  getRemindersForLead,
  getRemindersForCase,
  getMyReminders,
  createReminder,
  updateReminder,
  deleteReminder,
} from "../controllers/reminder.controller.js";

const router = express.Router();

const ROLES = ["Manager", "Agent", "SuperAdmin"];

router.get("/mine", verifyToken, authorize(ROLES), getMyReminders);
router.get("/lead/:leadId", verifyToken, authorize(ROLES), getRemindersForLead);
router.post("/lead/:leadId", verifyToken, authorize(ROLES), createReminder);
router.get("/case/:caseId", verifyToken, authorize(ROLES), getRemindersForCase);
router.patch("/:reminderId", verifyToken, authorize(ROLES), updateReminder);
router.delete("/:reminderId", verifyToken, authorize(ROLES), deleteReminder);

export default router;
