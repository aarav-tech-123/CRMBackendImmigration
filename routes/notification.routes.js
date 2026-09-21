import express from "express";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import {
  getMyNotifications,
  getUnreadNotificationCount,
  createNotificationForUser,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
} from "../controllers/notification.controller.js";

const router = express.Router();

const ROLES = ["Manager", "Agent", "SuperAdmin"];

router.get("/", verifyToken, authorize(ROLES), getMyNotifications);
router.get("/unread-count", verifyToken, authorize(ROLES), getUnreadNotificationCount);
router.post("/", verifyToken, authorize(["Manager", "SuperAdmin"]), createNotificationForUser);
router.patch("/read-all", verifyToken, authorize(ROLES), markAllNotificationsRead);
router.patch("/:notificationId/read", verifyToken, authorize(ROLES), markNotificationRead);
router.delete("/:notificationId", verifyToken, authorize(ROLES), deleteNotification);

export default router;
