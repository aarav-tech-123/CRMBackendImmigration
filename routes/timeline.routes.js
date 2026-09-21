import express from "express";

const router = express.Router();

import { updateLeadStatus, getLeadStatusTimeline, getStatusTimelineByDate } from "../controllers/timeline.controller.js";

import { verifyToken, authorize } from "../middleware/auth.middleware.js";


router.put("/update/:lead_id", verifyToken, authorize(["Manager", "SuperAdmin", "Agent"]), updateLeadStatus);
router.get("/:lead_id", verifyToken, authorize(["Manager", "SuperAdmin", "Agent"]), getLeadStatusTimeline);
router.get("/timeline/:date", verifyToken, authorize(["Manager", "SuperAdmin", "Agent"]), getStatusTimelineByDate);


export default router;

