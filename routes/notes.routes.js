import express from "express";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import { getNotesForLead, getNotesForCase, createNote, updateNote, deleteNote } from "../controllers/notes.controller.js";

const router = express.Router();

const ROLES = ["Manager", "Agent", "SuperAdmin"];

router.get("/lead/:leadId", verifyToken, authorize(ROLES), getNotesForLead);
router.post("/lead/:leadId", verifyToken, authorize(ROLES), createNote);
router.get("/case/:caseId", verifyToken, authorize(ROLES), getNotesForCase);
router.patch("/:noteId", verifyToken, authorize(ROLES), updateNote);
router.delete("/:noteId", verifyToken, authorize(ROLES), deleteNote);

export default router;
