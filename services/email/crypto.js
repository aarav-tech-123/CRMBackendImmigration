import crypto from "node:crypto";

// Mailbox passwords are stored encrypted (AES-256-GCM). Set EMAIL_ENC_KEY to a
// long random string; changing it makes previously stored passwords unreadable.
const getKey = () => {
  const secret = process.env.EMAIL_ENC_KEY;
  if (!secret) {
    throw new Error("EMAIL_ENC_KEY is not set; cannot store or read mailbox credentials.");
  }
  return crypto.createHash("sha256").update(secret).digest();
};

export const encryptSecret = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
};

export const decryptSecret = (payload) => {
  const [iv, tag, enc] = String(payload).split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
};
