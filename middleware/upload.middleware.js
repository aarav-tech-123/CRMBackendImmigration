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
