import express from "express";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import { uploadCaseDocument } from "../middleware/upload.middleware.js";
import {
  getCaseDocuments,
  getCaseDocumentById,
  uploadCaseDocumentRecord,
  verifyCaseDocument,
  deleteCaseDocument,
} from "../controllers/caseDocument.controller.js";

const router = express.Router();

const ROLES = ["Manager", "Agent", "SuperAdmin"];

// multer surfaces its own errors (bad file type, too large) via a callback
// rather than throwing into Express's normal middleware chain — wrap it so
// those come back as the same JSON error shape as everything else here.
const handleUpload = (req, res, next) => {
  uploadCaseDocument.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message || "File upload failed." });
    }
    next();
  });
};

router.get("/:caseId", verifyToken, authorize(ROLES), getCaseDocuments);
router.get("/:caseId/:documentId", verifyToken, authorize(ROLES), getCaseDocumentById);
router.post("/:caseId", verifyToken, authorize(ROLES), handleUpload, uploadCaseDocumentRecord);
router.patch("/:caseId/:documentId/verify", verifyToken, authorize(ROLES), verifyCaseDocument);
router.delete("/:caseId/:documentId", verifyToken, authorize(ROLES), deleteCaseDocument);

export default router;
