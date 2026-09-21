import express from "express";

import { assignLead, updateLeadAssignment } from "../controllers/assignments.controller.js";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";

const router = express.Router();

// All routes require SuperAdmin authorization


router.post("/assign", verifyToken, authorize(["Manager", "SuperAdmin", "Agent"]), assignLead);

router.put("/:id", verifyToken, authorize(["Manager", "SuperAdmin", "Agent"]), updateLeadAssignment);


export default router;