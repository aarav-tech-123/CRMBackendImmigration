import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";

// Served statically by index.js at /uploads and /api/v1/uploads.
const CASE_DOCUMENTS_DIR = path.join(process.cwd(), "uploads", "case-documents");
fs.mkdirSync(CASE_DOCUMENTS_DIR, { recursive: true });

// Immigration case paperwork: scans/photos of forms and IDs, plus office docs.
const ALLOWED_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx"]);
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CASE_DOCUMENTS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Never trust the client's filename for the stored name — regenerate it
    // entirely to avoid path traversal / overwrite collisions.
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error(`Unsupported file type "${ext}". Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`));
  }
  cb(null, true);
};

export const uploadCaseDocument = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

// Path stored in the DB / served over HTTP, relative to the uploads static root.
export const relativeUploadPath = (filename) => `case-documents/${filename}`;
export const absoluteUploadPath = (filename) => path.join(CASE_DOCUMENTS_DIR, filename);

// Lead bulk-import spreadsheets: parsed in memory, never written to disk.
const LEAD_IMPORT_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);
const MAX_LEAD_IMPORT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export const uploadLeadImportFile = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!LEAD_IMPORT_EXTENSIONS.has(ext)) {
      return cb(new Error(`Unsupported file type "${ext}". Allowed: ${[...LEAD_IMPORT_EXTENSIONS].join(", ")}`));
    }
    cb(null, true);
  },
  limits: { fileSize: MAX_LEAD_IMPORT_SIZE_BYTES },
});

// Outgoing email attachments: held in memory, handed to SMTP, then stored privately by the email service.
const BLOCKED_EMAIL_EXTENSIONS = new Set([".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".vbs", ".js", ".jar", ".ps1", ".sh"]);
const MAX_EMAIL_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15MB each
const MAX_EMAIL_ATTACHMENTS = 10;

const emailAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EMAIL_EXTENSIONS.has(ext)) {
      return cb(new Error(`Attachments of type "${ext}" are not allowed.`));
    }
    cb(null, true);
  },
  limits: { fileSize: MAX_EMAIL_ATTACHMENT_BYTES, files: MAX_EMAIL_ATTACHMENTS },
}).array("attachments", MAX_EMAIL_ATTACHMENTS);

// Turns multer failures into a 400 JSON response instead of Express's default 500 page.
export const uploadEmailAttachments = (req, res, next) =>
  emailAttachmentUpload(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
