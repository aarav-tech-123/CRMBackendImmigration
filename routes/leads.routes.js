import express from "express";
import { createLead, getAllLeads, getLeadById, updateLead, deleteLead, getAgentLeads, searchAgentLeads, filterAgentLeads, filterSuperAdminLeads, searchSuperAdminLeads, updateLeadStatus, convertLeadIntoCase, convertLeadtoCase } from "../controllers/leads.controller.js";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import { assignLead } from "../controllers/assignments.controller.js";
// import { checkModuleRead, checkModuleWrite, checkModuleUpdate, checkModuleDelete } from "../middleware/modulePermission.middleware.js";

const router = express.Router();


// All routes require SuperAdmin authorization
router.post("/create", verifyToken, authorize(["SuperAdmin"]), createLead);
router.get("/", verifyToken, authorize(["SuperAdmin"]), getAllLeads);
router.put("/assign/:id", verifyToken, authorize(["SuperAdmin"]), assignLead)
router.delete("/:id", verifyToken, authorize(["SuperAdmin"]), deleteLead);
router.get("/SuperAdmin/filter", verifyToken, authorize(["Manager", "SuperAdmin", "Agent"]), filterSuperAdminLeads);
router.get("/SuperAdmin/search", verifyToken, authorize(["Manager", "SuperAdmin", "Agent"]), searchSuperAdminLeads);

// Common routes for both agent and super admin 
router.get("/:id", verifyToken, authorize(["Agent", "SuperAdmin"]), getLeadById);
router.patch("/:id", verifyToken, authorize(["SuperAdmin", "Agent"]), updateLead);
router.put("/status/update/:id", verifyToken, authorize(["SuperAdmin", "Agent"]), updateLeadStatus)

router.post("/convert/:leadId", verifyToken, authorize(["Manager", "SuperAdmin", "Agent"]), convertLeadtoCase)

router.get("/agent/filter", verifyToken, authorize(["Manager", "SuperAdmin", "Agent"]), filterAgentLeads);
router.get("/agent/search", verifyToken, authorize(["Manager", "SuperAdmin", "Agent"]), searchAgentLeads);





router.get("/agent/getAll", verifyToken, authorize(["Manager", "SuperAdmin", "Agent"]), getAgentLeads);




export default router;
