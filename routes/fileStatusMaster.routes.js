import express from "express";
const router = express.Router();

import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import { getAllFileStatuses, getFileStatusById, createFileStatus, updateFileStatus, deleteFileStatus } from "../controllers/fileStatusMaster.controller.js";


router.post("/", verifyToken, authorize(["SuperAdmin"]), createFileStatus);
router.get("/", verifyToken, authorize(["SuperAdmin", "Manager", "Agent"]), getAllFileStatuses);
router.get("/:status_id", verifyToken, authorize(["SuperAdmin", "Manager", "Agent"]), getFileStatusById);
router.put("/:status_id", verifyToken, authorize(["SuperAdmin"]), updateFileStatus);
router.delete("/:status_id", verifyToken, authorize(["SuperAdmin"]), deleteFileStatus);



export default router;



