import nodemailer from "nodemailer";
import sanitizeHtml from "sanitize-html";
import { sql, poolPromise } from "../../config/db.js";
import { decryptSecret } from "./crypto.js";
import { saveAttachmentBuffer } from "./storage.js";
import { resolveCaseIdForLead } from "../../helpers/caseHelpers.js";

export const FOLDERS = ["INBOX", "SENT", "DRAFTS", "SPAM", "TRASH"];

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
export const toAddressList = (value) => {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[;,]/);
  return [...new Set(raw.map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
};

export const invalidAddresses = (list) => list.filter((a) => !EMAIL_RE.test(a));

const SAFE_STYLE = [/^[#\w(),.%\s-]+$/];

export const cleanHtml = (html) =>
  sanitizeHtml(html || "", {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2", "u", "span", "font"]),
    allowedAttributes: {
      a: ["href", "name", "target"],
      img: ["src", "alt", "width", "height"],
      "*": ["style"],
    },
    // No javascript:/data: links; images are remote or cid: only.
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "cid"] },
    allowedStyles: {
      "*": {
        color: SAFE_STYLE,
        "background-color": SAFE_STYLE,
        "text-align": [/^(left|right|center|justify)$/],
        "font-weight": [/^\w+$/],
        "font-size": [/^[\d.]+(px|em|rem|pt|%)$/],
      },
    },
  });

const htmlToText = (html) =>
  sanitizeHtml(html || "", { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();

const makeSnippet = (text) => (text || "").replace(/\s+/g, " ").trim().slice(0, 200);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
export const getAccountById = async (accountId) => {
  const pool = await poolPromise;
  const r = await pool
    .request()
    .input("id", sql.Int, accountId)
    .query("SELECT * FROM EmailAccounts WHERE account_id = @id");
  return r.recordset[0] || null;
};

const buildTransport = (account) =>
  nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    // Implicit TLS only works on 465; 587 must start plain and upgrade via STARTTLS.
    secure: Number(account.smtp_port) === 465 ? true : Number(account.smtp_port) === 587 ? false : !!account.smtp_secure,
    requireTLS: Number(account.smtp_port) === 587,
    auth: { user: account.username, pass: decryptSecret(account.password_enc) },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });

export const verifySmtp = (account) => buildTransport(account).verify();

// ---------------------------------------------------------------------------
// Lead / case matching
// ---------------------------------------------------------------------------
export const findLeadByEmail = async (executor, address) => {
  if (!address) return null;
  const r = await executor
    .request()
    .input("email", sql.NVarChar(255), address.toLowerCase())
    .query(`
      SELECT TOP 1 lead_id
      FROM Leads
      WHERE LOWER(email_address) = @email OR LOWER(alt_email) = @email
      ORDER BY lead_id DESC
    `);
  return r.recordset[0]?.lead_id ?? null;
};

// ---------------------------------------------------------------------------
// Storing messages
// ---------------------------------------------------------------------------
const resolveThreadId = async (executor, { accountId, messageId, inReplyTo, references }) => {
  const candidates = [inReplyTo, ...String(references || "").split(/\s+/)].filter(Boolean);
  for (const id of candidates) {
    const r = await executor
      .request()
      .input("account_id", sql.Int, accountId)
      .input("mid", sql.NVarChar(500), id)
      .query("SELECT TOP 1 thread_id FROM Emails WHERE account_id = @account_id AND message_id = @mid");
    if (r.recordset[0]?.thread_id) return r.recordset[0].thread_id;
  }
  return candidates[0] || messageId || null;
};

/**
 * Insert one message (+ attachments). Returns the inserted row, or null when
 * the (account, message_id) pair already exists.
 *
 * attachments: [{ filename, contentType, content: Buffer }]
 */
export const insertEmail = async (executor, data, attachments = []) => {
  const messageId = data.messageId ? String(data.messageId).trim() : null;

  if (messageId) {
    const dup = await executor
      .request()
      .input("account_id", sql.Int, data.accountId)
      .input("mid", sql.NVarChar(500), messageId)
      .query("SELECT email_id FROM Emails WHERE account_id = @account_id AND message_id = @mid");
    if (dup.recordset.length) return null;
  }

  const threadId = await resolveThreadId(executor, { ...data, messageId });

  const stored = [];
  for (const a of attachments) {
    stored.push({
      file_name: (a.filename || "attachment").slice(0, 255),
      content_type: a.contentType || null,
      size_bytes: a.content.length,
      storage_name: await saveAttachmentBuffer(a.content, a.filename),
    });
  }

  const r = await executor
    .request()
    .input("account_id", sql.Int, data.accountId)
    .input("folder", sql.VarChar(20), data.folder)
    .input("direction", sql.VarChar(10), data.direction)
    .input("status", sql.VarChar(10), data.status)
    .input("message_id", sql.NVarChar(500), messageId)
    .input("in_reply_to", sql.NVarChar(500), data.inReplyTo || null)
    .input("references", sql.NVarChar(sql.MAX), data.references || null)
    .input("thread_id", sql.NVarChar(500), threadId)
    .input("from_address", sql.NVarChar(255), data.fromAddress || null)
    .input("from_name", sql.NVarChar(255), data.fromName || null)
    .input("to_addresses", sql.NVarChar(sql.MAX), (data.to || []).join(", "))
    .input("cc_addresses", sql.NVarChar(sql.MAX), (data.cc || []).join(", ") || null)
    .input("bcc_addresses", sql.NVarChar(sql.MAX), (data.bcc || []).join(", ") || null)
    .input("subject", sql.NVarChar(998), (data.subject || "").slice(0, 998))
    .input("body_text", sql.NVarChar(sql.MAX), data.text || null)
    .input("body_html", sql.NVarChar(sql.MAX), data.html || null)
    .input("snippet", sql.NVarChar(300), makeSnippet(data.text || htmlToText(data.html)))
    .input("has_attachments", sql.Bit, stored.length ? 1 : 0)
    .input("is_read", sql.Bit, data.isRead ? 1 : 0)
    .input("lead_id", sql.Int, data.leadId ?? null)
    .input("case_id", sql.Int, data.caseId ?? null)
    .input("sent_by_user_id", sql.Int, data.sentByUserId ?? null)
    .input("remote_folder", sql.NVarChar(255), data.remoteFolder || null)
    .input("remote_uid", sql.BigInt, data.remoteUid ?? null)
    .input("email_date", sql.DateTime, data.date || new Date())
    .query(`
      INSERT INTO Emails (
        account_id, folder, direction, status, message_id, in_reply_to, [references], thread_id,
        from_address, from_name, to_addresses, cc_addresses, bcc_addresses, subject,
        body_text, body_html, snippet, has_attachments, is_read, lead_id, case_id,
        sent_by_user_id, remote_folder, remote_uid, email_date
      )
      OUTPUT INSERTED.*
      VALUES (
        @account_id, @folder, @direction, @status, @message_id, @in_reply_to, @references, @thread_id,
        @from_address, @from_name, @to_addresses, @cc_addresses, @bcc_addresses, @subject,
        @body_text, @body_html, @snippet, @has_attachments, @is_read, @lead_id, @case_id,
        @sent_by_user_id, @remote_folder, @remote_uid, @email_date
      )
    `);
  const row = r.recordset[0];

  for (const a of stored) {
    await executor
      .request()
      .input("email_id", sql.Int, row.email_id)
      .input("file_name", sql.NVarChar(255), a.file_name)
      .input("content_type", sql.NVarChar(150), a.content_type)
      .input("size_bytes", sql.Int, a.size_bytes)
      .input("storage_name", sql.NVarChar(255), a.storage_name)
      .query(`
        INSERT INTO EmailAttachments (email_id, file_name, content_type, size_bytes, storage_name)
        VALUES (@email_id, @file_name, @content_type, @size_bytes, @storage_name)
      `);
  }
  return row;
};

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
/**
 * Sends through the account's SMTP server and records the message in SENT.
 * Throws if SMTP rejects it; nothing is stored in that case.
 *
 * attachments: [{ filename, contentType, content: Buffer }]
 * replyTo: the Emails row being replied to (sets threading headers)
 */
export const sendEmail = async ({
  account,
  userId,
  to,
  cc = [],
  bcc = [],
  subject,
  html,
  text,
  leadId = null,
  caseId = null,
  attachments = [],
  replyTo = null,
}) => {
  const cleanedHtml = html ? cleanHtml(html) : null;
  const bodyText = text || (cleanedHtml ? htmlToText(cleanedHtml) : "");
  const bodyHtml = cleanedHtml || `<div style="white-space:pre-wrap">${escapeHtml(bodyText)}</div>`;

  const headers = {};
  let references = null;
  if (replyTo?.message_id) {
    references = [replyTo.references, replyTo.message_id].filter(Boolean).join(" ");
    headers["In-Reply-To"] = replyTo.message_id;
    headers["References"] = references;
  }

  const info = await buildTransport(account).sendMail({
    from: account.display_name
      ? { name: account.display_name, address: account.email_address }
      : account.email_address,
    to,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    subject,
    text: bodyText,
    html: bodyHtml,
    headers,
    attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
  });

  const pool = await poolPromise;
  return insertEmail(
    pool,
    {
      accountId: account.account_id,
      folder: "SENT",
      direction: "OUTBOUND",
      status: "SENT",
      messageId: info.messageId,
      inReplyTo: replyTo?.message_id || null,
      references,
      fromAddress: account.email_address,
      fromName: account.display_name,
      to,
      cc,
      bcc,
      subject,
      text: bodyText,
      html: bodyHtml,
      isRead: true,
      leadId,
      caseId,
      sentByUserId: userId,
    },
    attachments
  );
};

// ---------------------------------------------------------------------------
// Inbound mapping (used by the IMAP sync)
// ---------------------------------------------------------------------------
const addressesOf = (field) =>
  [].concat(field || [])
    .flatMap((g) => g.value || [])
    .map((v) => v.address?.toLowerCase())
    .filter(Boolean);

export const storeInboundMessage = async (account, parsed, meta) => {
  const pool = await poolPromise;

  const from = parsed.from?.value?.[0] || {};
  const fromAddress = from.address?.toLowerCase() || null;
  const to = addressesOf(parsed.to);

  // Mail we sent (picked up from the Sent folder) is matched on its recipient.
  const outbound = fromAddress === account.email_address.toLowerCase();
  const leadId = await findLeadByEmail(pool, outbound ? to[0] : fromAddress);
  const caseId = leadId ? await resolveCaseIdForLead(pool, leadId) : null;

  const references = Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references || null;

  return insertEmail(
    pool,
    {
      accountId: account.account_id,
      folder: meta.folder,
      direction: outbound ? "OUTBOUND" : "INBOUND",
      status: outbound ? "SENT" : "RECEIVED",
      messageId: parsed.messageId || `<${account.account_id}-${meta.remoteFolder}-${meta.uid}@imap.local>`,
      inReplyTo: parsed.inReplyTo,
      references,
      fromAddress,
      fromName: from.name || null,
      to,
      cc: addressesOf(parsed.cc),
      subject: parsed.subject || "(no subject)",
      text: parsed.text || null,
      html: parsed.html ? cleanHtml(parsed.html) : null,
      isRead: meta.seen || outbound,
      leadId,
      caseId,
      remoteFolder: meta.remoteFolder,
      remoteUid: meta.uid,
      date: parsed.date || new Date(),
    },
    // Inline images only exist to render the original HTML; skip them.
    (parsed.attachments || [])
      .filter((a) => a.content && a.contentDisposition !== "inline")
      .map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content }))
  );
};
