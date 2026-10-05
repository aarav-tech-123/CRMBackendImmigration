import express from "express";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import { uploadEmailAttachments } from "../middleware/upload.middleware.js";
import {
  listAccounts,
  getAccountbyId,
  createAccount,
  updateAccount,
  deleteAccount,
  syncAccountNow,
  listEmails,
  getFolderCounts,
  getEmailsForLead,
  getEmailsForCase,
  getEmail,
  getEmailThread,
  updateEmail,
  moveEmail,
  deleteEmail,
  downloadAttachment,
  sendEmailHandler,
  saveDraft,
} from "../controllers/email.controller.js";

const router = express.Router();

const ROLES = ["Manager", "Agent", "SuperAdmin"];
const auth = [verifyToken, authorize(ROLES)];

// Mailboxes
router.get("/accounts", ...auth, listAccounts);
router.get("/accounts/:accountId", ...auth, getAccountbyId);
router.post("/accounts", ...auth, createAccount);
router.patch("/accounts/:accountId", ...auth, updateAccount);
router.delete("/accounts/:accountId", ...auth, deleteAccount);
router.post("/accounts/:accountId/sync", ...auth, syncAccountNow);

// Compose
router.post("/send", ...auth, uploadEmailAttachments, sendEmailHandler);
router.post("/drafts", ...auth, uploadEmailAttachments, saveDraft);

// Lists (declared before /:emailId so they are not read as ids)
router.get("/counts", ...auth, getFolderCounts);
router.get("/lead/:leadId", ...auth, getEmailsForLead);
router.get("/case/:caseId", ...auth, getEmailsForCase);
router.get("/attachments/:attachmentId", ...auth, downloadAttachment);
router.get("/", ...auth, listEmails);

// Single message
router.get("/:emailId", ...auth, getEmail);
router.get("/:emailId/thread", ...auth, getEmailThread);
router.patch("/:emailId", ...auth, updateEmail);
router.post("/:emailId/move", ...auth, moveEmail);
router.delete("/:emailId", ...auth, deleteEmail);

export default router;
