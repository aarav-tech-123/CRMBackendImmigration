import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Deliberately outside uploads/ (which index.js serves statically): email
// attachments are only reachable through the authenticated download endpoint.
export const ATTACHMENT_DIR = path.join(process.cwd(), "private", "email-attachments");
fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });

export const saveAttachmentBuffer = async (buffer, originalName) => {
  const ext = path.extname(originalName || "").toLowerCase().slice(0, 10);
  const storageName = `${Date.now()}-${crypto.randomUUID()}${ext}`;
  await fs.promises.writeFile(path.join(ATTACHMENT_DIR, storageName), buffer);
  return storageName;
};

export const attachmentPath = (storageName) => path.join(ATTACHMENT_DIR, path.basename(storageName));
