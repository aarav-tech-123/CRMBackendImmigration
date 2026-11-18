import express from "express";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import { registerDeviceToken, removeDeviceToken } from "../controllers/deviceToken.controller.js";

const router = express.Router();
const ROLES = ["Manager", "Agent", "SuperAdmin"];

router.post("/", verifyToken, authorize(ROLES), registerDeviceToken);
router.delete("/", verifyToken, authorize(ROLES), removeDeviceToken);

export default router;
