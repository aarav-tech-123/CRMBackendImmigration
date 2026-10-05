import fs from "node:fs";
import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";
import { getRequestInfo } from "../helpers/requestInfo.js";
import { parsePositiveInt, paginationParams } from "../helpers/parsers.js";
import { getCaseOrNull, getLeadOrNull, resolveCaseIdForLead } from "../helpers/caseHelpers.js";
import { encryptSecret } from "../services/email/crypto.js";
import { attachmentPath } from "../services/email/storage.js";
import { syncAccount, verifyImap } from "../services/email/imap.service.js";
import {
  FOLDERS,
  cleanHtml,
  findLeadByEmail,
  getAccountById,
  insertEmail,
  invalidAddresses,
  sendEmail,
  toAddressList,
  verifySmtp,
} from "../services/email/email.service.js";

const ELEVATED_ROLES = ["Manager", "SuperAdmin"];
const isElevated = (req) => ELEVATED_ROLES.includes(req.user?.role);

// Never return password_enc to clients.
const ACCOUNT_COLUMNS = `
  a.account_id, a.owner_user_id, a.is_shared, a.label, a.display_name, a.email_address, a.username,
  a.smtp_host, a.smtp_port, a.smtp_secure, a.imap_host, a.imap_port, a.imap_secure,
  a.signature, a.is_active, a.last_sync_at, a.last_error, a.created_at, a.updated_at
`;

// List columns omit the bodies; GET /:emailId returns the full message.
const EMAIL_LIST_COLUMNS = `
  e.email_id, e.account_id, e.folder, e.direction, e.status, e.thread_id, e.from_address, e.from_name,
  e.to_addresses, e.cc_addresses, e.subject, e.snippet, e.has_attachments, e.is_read, e.is_starred,
  e.lead_id, e.case_id, e.sent_by_user_id, e.email_date
`;

const canUseAccount = (req, account) =>
  !!account && (isElevated(req) || account.is_shared || account.owner_user_id === req.user?.id);

const canManageAccount = (req, account) =>
  !!account && (isElevated(req) || account.owner_user_id === req.user?.id);

// Loads an email only if the requester can use its mailbox.
const getAccessibleEmail = async (req, emailId) => {
  const pool = await poolPromise;
  const r = await pool.request().input("id", sql.Int, emailId).query("SELECT * FROM Emails WHERE email_id = @id");
  const email = r.recordset[0];
  if (!email) return { status: 404, message: "Email not found." };
  const account = await getAccountById(email.account_id);
  if (!canUseAccount(req, account)) return { status: 403, message: "You do not have access to this mailbox." };
  return { email, account };
};

const accessWhere = `(a.owner_user_id = @uid OR a.is_shared = 1 OR @elevated = 1)`;

const fail = (res, tag, err, message) => {
  console.error(`[${tag}] Error:`, err);
  return res.status(500).json({ success: false, message });
};

const bool = (v) => v === true || v === 1 || v === "1" || v === "true";

// ===========================================================================
// Accounts
// ===========================================================================
export const listAccounts = async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("uid", sql.Int, req.user.id)
      .input("elevated", sql.Bit, isElevated(req) ? 1 : 0)
      .query(`
        SELECT ${ACCOUNT_COLUMNS}
        FROM EmailAccounts a
        WHERE ${accessWhere}
        ORDER BY a.is_shared DESC, a.email_address
      `);
    return res.status(200).json({ success: true, accounts: r.recordset });
  } catch (err) {
    return fail(res, "listAccounts", err, "Failed to fetch email accounts.");
  }
};


export const getAccountbyId = async (req, res) => {
  const { id } = req.params;
  const pool = await poolPromise;
  const r = await pool.request().input("id", sql.Int, id).query("SELECT * FROM EmailAccounts WHERE account_id = @id");
  const account = r.recordset[0];
  if (!account) {
    return res.status(404).json({ success: false, message: "Account not found." });
  }
  if (!canManageAccount(req, account)) {
    return res.status(403).json({ success: false, message: "You do not have access to this account." });
  }
  return res.status(200).json({ success: true, account });
};


const readAccountBody = (body) => ({
  label: body.label?.trim() || null,
  display_name: body.display_name?.trim() || null,
  email_address: body.email_address?.trim().toLowerCase(),
  username: (body.username || body.email_address || "").trim(),
  smtp_host: body.smtp_host?.trim(),
  smtp_port: parsePositiveInt(body.smtp_port) || 587,
  smtp_secure: bool(body.smtp_secure),
  imap_host: body.imap_host?.trim(),
  imap_port: parsePositiveInt(body.imap_port) || 993,
  imap_secure: body.imap_secure === undefined ? true : bool(body.imap_secure),
  signature: body.signature ?? null,
});

export const createAccount = async (req, res) => {
  const body = req.body || {};
  const data = readAccountBody(body);

  console.log("Creating account with data:", data);

  if (!data.email_address || invalidAddresses([data.email_address]).length || !body.password || !data.smtp_host || !data.imap_host) {
    return res.status(400).json({
      success: false,
      message: "email_address, password, smtp_host and imap_host are required.",
    });
  }
  const shared = bool(body.is_shared);
  if (shared && !isElevated(req)) {
    return res.status(403).json({ success: false, message: "Only a Manager or SuperAdmin can create a shared mailbox." });
  }

  try {
    const candidate = { ...data, password_enc: encryptSecret(body.password) };
    // Reject bad credentials/hosts up front instead of failing silently on every sync.
    try {
      await Promise.all([verifySmtp(candidate), verifyImap(candidate)]);
    } catch (err) {
      return res.status(400).json({ success: false, message: `Could not connect to the mail server: ${err.message}` });
    }

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("owner_user_id", sql.Int, shared ? null : req.user.id)
      .input("is_shared", sql.Bit, shared ? 1 : 0)
      .input("label", sql.NVarChar(100), data.label)
      .input("display_name", sql.NVarChar(150), data.display_name)
      .input("email_address", sql.NVarChar(255), data.email_address)
      .input("username", sql.NVarChar(255), data.username)
      .input("password_enc", sql.NVarChar(1000), candidate.password_enc)
      .input("smtp_host", sql.NVarChar(255), data.smtp_host)
      .input("smtp_port", sql.Int, data.smtp_port)
      .input("smtp_secure", sql.Bit, data.smtp_secure ? 1 : 0)
      .input("imap_host", sql.NVarChar(255), data.imap_host)
      .input("imap_port", sql.Int, data.imap_port)
      .input("imap_secure", sql.Bit, data.imap_secure ? 1 : 0)
      .input("signature", sql.NVarChar(sql.MAX), data.signature)
      .query(`
        INSERT INTO EmailAccounts (
          owner_user_id, is_shared, label, display_name, email_address, username, password_enc,
          smtp_host, smtp_port, smtp_secure, imap_host, imap_port, imap_secure, signature
        )
        OUTPUT INSERTED.account_id
        VALUES (
          @owner_user_id, @is_shared, @label, @display_name, @email_address, @username, @password_enc,
          @smtp_host, @smtp_port, @smtp_secure, @imap_host, @imap_port, @imap_secure, @signature
        )
      `);
    const accountId = r.recordset[0].account_id;

    // Pull the initial mail in the background; the response doesn't wait for it.
    getAccountById(accountId)
      .then(syncAccount)
      .catch(() => {});

    const created = await pool
      .request()
      .input("id", sql.Int, accountId)
      .query(`SELECT ${ACCOUNT_COLUMNS} FROM EmailAccounts a WHERE a.account_id = @id`);
    return res.status(201).json({ success: true, message: "Email account connected.", data: created.recordset[0] });
  } catch (err) {
    return fail(res, "createAccount", err, "Failed to connect email account.");
  }
};

export const updateAccount = async (req, res) => {
  const accountId = parsePositiveInt(req.params.accountId);
  if (!accountId) return res.status(400).json({ success: false, message: "A valid accountId is required." });

  try {
    const account = await getAccountById(accountId);
    if (!account) return res.status(404).json({ success: false, message: "Email account not found." });
    if (!canManageAccount(req, account)) {
      return res.status(403).json({ success: false, message: "You do not have permission to edit this mailbox." });
    }

    const body = req.body || {};
    const merged = { ...account };
    for (const [key, value] of Object.entries(readAccountBody({ ...account, ...body }))) merged[key] = value;
    if (body.password) merged.password_enc = encryptSecret(body.password);
    if (body.is_active !== undefined) merged.is_active = bool(body.is_active);

    const connectionChanged =
      body.password ||
      ["smtp_host", "smtp_port", "smtp_secure", "imap_host", "imap_port", "imap_secure", "username"].some((k) => body[k] !== undefined);
    if (connectionChanged) {
      try {
        await Promise.all([verifySmtp(merged), verifyImap(merged)]);
      } catch (err) {
        return res.status(400).json({ success: false, message: `Could not connect to the mail server: ${err.message}` });
      }
    }

    const pool = await poolPromise;
    await pool
      .request()
      .input("id", sql.Int, accountId)
      .input("label", sql.NVarChar(100), merged.label)
      .input("display_name", sql.NVarChar(150), merged.display_name)
      .input("username", sql.NVarChar(255), merged.username)
      .input("password_enc", sql.NVarChar(1000), merged.password_enc)
      .input("smtp_host", sql.NVarChar(255), merged.smtp_host)
      .input("smtp_port", sql.Int, merged.smtp_port)
      .input("smtp_secure", sql.Bit, merged.smtp_secure ? 1 : 0)
      .input("imap_host", sql.NVarChar(255), merged.imap_host)
      .input("imap_port", sql.Int, merged.imap_port)
      .input("imap_secure", sql.Bit, merged.imap_secure ? 1 : 0)
      .input("signature", sql.NVarChar(sql.MAX), merged.signature)
      .input("is_active", sql.Bit, merged.is_active ? 1 : 0)
      .query(`
        UPDATE EmailAccounts SET
          label = @label, display_name = @display_name, username = @username, password_enc = @password_enc,
          smtp_host = @smtp_host, smtp_port = @smtp_port, smtp_secure = @smtp_secure,
          imap_host = @imap_host, imap_port = @imap_port, imap_secure = @imap_secure,
          signature = @signature, is_active = @is_active, updated_at = GETDATE()
        WHERE account_id = @id
      `);

    const updated = await pool
      .request()
      .input("id", sql.Int, accountId)
      .query(`SELECT ${ACCOUNT_COLUMNS} FROM EmailAccounts a WHERE a.account_id = @id`);
    return res.status(200).json({ success: true, message: "Email account updated.", data: updated.recordset[0] });
  } catch (err) {
    return fail(res, "updateAccount", err, "Failed to update email account.");
  }
};

// Removes the mailbox and its locally stored mail; nothing is deleted on the mail server.
export const deleteAccount = async (req, res) => {
  const accountId = parsePositiveInt(req.params.accountId);
  if (!accountId) return res.status(400).json({ success: false, message: "A valid accountId is required." });

  try {
    const account = await getAccountById(accountId);
    if (!account) return res.status(404).json({ success: false, message: "Email account not found." });
    if (!canManageAccount(req, account)) {
      return res.status(403).json({ success: false, message: "You do not have permission to delete this mailbox." });
    }

    const pool = await poolPromise;
    const files = await pool
      .request()
      .input("id", sql.Int, accountId)
      .query(`
        SELECT t.storage_name FROM EmailAttachments t
        JOIN Emails e ON e.email_id = t.email_id WHERE e.account_id = @id
      `);

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const run = (q) => tx.request().input("id", sql.Int, accountId).query(q);
      await run("DELETE FROM Emails WHERE account_id = @id"); // attachments cascade
      await run("DELETE FROM EmailSyncState WHERE account_id = @id");
      await run("DELETE FROM EmailAccounts WHERE account_id = @id");
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
    await Promise.all(files.recordset.map((f) => fs.promises.unlink(attachmentPath(f.storage_name)).catch(() => {})));

    return res.status(200).json({ success: true, message: "Email account removed." });
  } catch (err) {
    return fail(res, "deleteAccount", err, "Failed to remove email account.");
  }
};

export const syncAccountNow = async (req, res) => {
  const accountId = parsePositiveInt(req.params.accountId);
  if (!accountId) return res.status(400).json({ success: false, message: "A valid accountId is required." });

  try {
    const account = await getAccountById(accountId);
    if (!account) return res.status(404).json({ success: false, message: "Email account not found." });
    if (!canUseAccount(req, account)) {
      return res.status(403).json({ success: false, message: "You do not have access to this mailbox." });
    }
    const received = await syncAccount(account);
    return res.status(200).json({ success: true, message: `Sync complete. ${received} new message(s).`, received });
  } catch (err) {
    console.error("[syncAccountNow] Error:", err);
    return res.status(502).json({ success: false, message: `Sync failed: ${err.message}` });
  }
};

// ===========================================================================
// Listing
// ===========================================================================
// Shared by the folder list and the lead/case timelines.
const queryEmails = async (req, res, { where, params = [], tag }) => {
  const { page, pageSize, offset } = paginationParams(req);
  try {
    const pool = await poolPromise;
    const build = () => {
      const request = pool
        .request()
        .input("uid", sql.Int, req.user.id)
        .input("elevated", sql.Bit, isElevated(req) ? 1 : 0);
      for (const [name, type, value] of params) request.input(name, type, value);
      return request;
    };
    const from = `FROM Emails e JOIN EmailAccounts a ON a.account_id = e.account_id WHERE ${accessWhere} AND e.deleted_at IS NULL AND ${where}`;

    const [data, count] = await Promise.all([
      build()
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize)
        .query(`
          SELECT ${EMAIL_LIST_COLUMNS}, a.email_address AS account_email
          ${from}
          ORDER BY e.email_date DESC, e.email_id DESC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `),
      build().query(`SELECT COUNT(*) AS total ${from}`),
    ]);

    return res.status(200).json({ success: true, page, pageSize, total: count.recordset[0].total, emails: data.recordset });
  } catch (err) {
    return fail(res, tag, err, "Failed to fetch emails.");
  }
};

// GET /?folder=INBOX&account_id=&search=&unread=1&starred=1&lead_id=&case_id=
export const listEmails = async (req, res) => {
  const folder = String(req.query.folder || "INBOX").toUpperCase();
  const starred = bool(req.query.starred);
  if (!starred && !FOLDERS.includes(folder)) {
    return res.status(400).json({ success: false, message: `folder must be one of ${FOLDERS.join(", ")}.` });
  }

  const params = [];
  const clauses = [];
  if (starred) {
    clauses.push("e.is_starred = 1 AND e.folder <> 'TRASH'");
  } else {
    clauses.push("e.folder = @folder");
    params.push(["folder", sql.VarChar(20), folder]);
  }
  for (const [key, col] of [["account_id", "e.account_id"], ["lead_id", "e.lead_id"], ["case_id", "e.case_id"]]) {
    if (req.query[key] === undefined) continue;
    const id = parsePositiveInt(req.query[key]);
    if (!id) return res.status(400).json({ success: false, message: `Invalid ${key}.` });
    clauses.push(`${col} = @${key}`);
    params.push([key, sql.Int, id]);
  }
  if (bool(req.query.unread)) clauses.push("e.is_read = 0");
  if (req.query.search) {
    clauses.push(`(e.subject LIKE @search OR e.from_address LIKE @search OR e.from_name LIKE @search
      OR e.to_addresses LIKE @search OR e.snippet LIKE @search)`);
    params.push(["search", sql.NVarChar(200), `%${String(req.query.search).slice(0, 100)}%`]);
  }

  return queryEmails(req, res, { where: clauses.join(" AND "), params, tag: "listEmails" });
};

export const getEmailsForLead = async (req, res) => {
  const leadId = parsePositiveInt(req.params.leadId);
  if (!leadId) return res.status(400).json({ success: false, message: "A valid leadId is required." });
  const lead = await getLeadOrNull(await poolPromise, leadId).catch(() => null);
  if (!lead) return res.status(404).json({ success: false, message: "Lead not found." });
  return queryEmails(req, res, {
    where: "e.lead_id = @lead_id AND e.folder NOT IN ('TRASH', 'SPAM', 'DRAFTS')",
    params: [["lead_id", sql.Int, leadId]],
    tag: "getEmailsForLead",
  });
};

export const getEmailsForCase = async (req, res) => {
  const caseId = parsePositiveInt(req.params.caseId);
  if (!caseId) return res.status(400).json({ success: false, message: "A valid caseId is required." });
  const caseRow = await getCaseOrNull(await poolPromise, caseId).catch(() => null);
  if (!caseRow) return res.status(404).json({ success: false, message: "Immigration case not found." });
  return queryEmails(req, res, {
    where: "e.case_id = @case_id AND e.folder NOT IN ('TRASH', 'SPAM', 'DRAFTS')",
    params: [["case_id", sql.Int, caseId]],
    tag: "getEmailsForCase",
  });
};

// GET /counts?account_id= — badge numbers for the sidebar
export const getFolderCounts = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool
      .request()
      .input("uid", sql.Int, req.user.id)
      .input("elevated", sql.Bit, isElevated(req) ? 1 : 0);
    let accountClause = "";
    if (req.query.account_id !== undefined) {
      const id = parsePositiveInt(req.query.account_id);
      if (!id) return res.status(400).json({ success: false, message: "Invalid account_id." });
      request.input("account_id", sql.Int, id);
      accountClause = "AND e.account_id = @account_id";
    }
    const r = await request.query(`
      SELECT e.folder, COUNT(*) AS total, SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END) AS unread
      FROM Emails e JOIN EmailAccounts a ON a.account_id = e.account_id
      WHERE ${accessWhere} AND e.deleted_at IS NULL ${accountClause}
      GROUP BY e.folder
    `);
    const counts = Object.fromEntries(FOLDERS.map((f) => [f, { total: 0, unread: 0 }]));
    for (const row of r.recordset) counts[row.folder] = { total: row.total, unread: row.unread || 0 };
    return res.status(200).json({ success: true, counts });
  } catch (err) {
    return fail(res, "getFolderCounts", err, "Failed to fetch folder counts.");
  }
};

// ===========================================================================
// Single message
// ===========================================================================
const loadAttachments = async (emailId) => {
  const pool = await poolPromise;
  const r = await pool
    .request()
    .input("id", sql.Int, emailId)
    .query("SELECT attachment_id, file_name, content_type, size_bytes FROM EmailAttachments WHERE email_id = @id");
  return r.recordset;
};

// GET /:emailId — opening a message marks it read
export const getEmail = async (req, res) => {
  const emailId = parsePositiveInt(req.params.emailId);
  if (!emailId) return res.status(400).json({ success: false, message: "A valid emailId is required." });

  try {
    const found = await getAccessibleEmail(req, emailId);
    if (found.status) return res.status(found.status).json({ success: false, message: found.message });
    const { email } = found;

    if (!email.is_read) {
      const pool = await poolPromise;
      await pool.request().input("id", sql.Int, emailId).query("UPDATE Emails SET is_read = 1 WHERE email_id = @id");
      email.is_read = true;
    }
    return res.status(200).json({ success: true, data: { ...email, attachments: await loadAttachments(emailId) } });
  } catch (err) {
    return fail(res, "getEmail", err, "Failed to fetch email.");
  }
};

// GET /:emailId/thread — the whole conversation, oldest first
export const getEmailThread = async (req, res) => {
  const emailId = parsePositiveInt(req.params.emailId);
  if (!emailId) return res.status(400).json({ success: false, message: "A valid emailId is required." });

  try {
    const found = await getAccessibleEmail(req, emailId);
    if (found.status) return res.status(found.status).json({ success: false, message: found.message });
    const { email } = found;

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("account_id", sql.Int, email.account_id)
      .input("thread_id", sql.NVarChar(500), email.thread_id)
      .input("email_id", sql.Int, emailId)
      .query(`
        SELECT ${EMAIL_LIST_COLUMNS}, e.body_text, e.body_html
        FROM Emails e
        WHERE e.account_id = @account_id AND e.deleted_at IS NULL AND e.folder <> 'DRAFTS'
          AND (e.email_id = @email_id OR (@thread_id IS NOT NULL AND e.thread_id = @thread_id))
        ORDER BY e.email_date ASC, e.email_id ASC
      `);
    return res.status(200).json({ success: true, emails: r.recordset });
  } catch (err) {
    return fail(res, "getEmailThread", err, "Failed to fetch thread.");
  }
};

// PATCH /:emailId — is_read, is_starred, lead_id, case_id (re-link to a client)
export const updateEmail = async (req, res) => {
  const emailId = parsePositiveInt(req.params.emailId);
  if (!emailId) return res.status(400).json({ success: false, message: "A valid emailId is required." });
  const body = req.body || {};

  try {
    const found = await getAccessibleEmail(req, emailId);
    if (found.status) return res.status(found.status).json({ success: false, message: found.message });
    const { email } = found;
    const pool = await poolPromise;

    let leadId = email.lead_id;
    let caseId = email.case_id;
    if (body.lead_id !== undefined || body.case_id !== undefined) {
      if (body.case_id) {
        const caseRow = await getCaseOrNull(pool, parsePositiveInt(body.case_id));
        if (!caseRow) return res.status(400).json({ success: false, message: "case_id not found." });
        caseId = caseRow.case_id;
        leadId = caseRow.lead_id;
      } else if (body.lead_id) {
        const lead = await getLeadOrNull(pool, parsePositiveInt(body.lead_id));
        if (!lead) return res.status(400).json({ success: false, message: "lead_id not found." });
        leadId = lead.lead_id;
        caseId = await resolveCaseIdForLead(pool, leadId);
      } else {
        leadId = null;
        caseId = null;
      }
    }

    const r = await pool
      .request()
      .input("id", sql.Int, emailId)
      .input("is_read", sql.Bit, body.is_read !== undefined ? (bool(body.is_read) ? 1 : 0) : email.is_read)
      .input("is_starred", sql.Bit, body.is_starred !== undefined ? (bool(body.is_starred) ? 1 : 0) : email.is_starred)
      .input("lead_id", sql.Int, leadId)
      .input("case_id", sql.Int, caseId)
      .query(`
        UPDATE Emails SET is_read = @is_read, is_starred = @is_starred, lead_id = @lead_id, case_id = @case_id
        OUTPUT INSERTED.email_id, INSERTED.is_read, INSERTED.is_starred, INSERTED.lead_id, INSERTED.case_id
        WHERE email_id = @id
      `);
    return res.status(200).json({ success: true, data: r.recordset[0] });
  } catch (err) {
    return fail(res, "updateEmail", err, "Failed to update email.");
  }
};

// POST /:emailId/move { folder } — mark spam / not spam / restore from trash.
// Drafts and sent mail can only go to TRASH.
export const moveEmail = async (req, res) => {
  const emailId = parsePositiveInt(req.params.emailId);
  const folder = String(req.body?.folder || "").toUpperCase();
  if (!emailId) return res.status(400).json({ success: false, message: "A valid emailId is required." });
  if (!["INBOX", "SPAM", "TRASH"].includes(folder)) {
    return res.status(400).json({ success: false, message: "folder must be INBOX, SPAM or TRASH." });
  }

  try {
    const found = await getAccessibleEmail(req, emailId);
    if (found.status) return res.status(found.status).json({ success: false, message: found.message });
    const { email } = found;

    let target = folder;
    if (email.direction === "OUTBOUND" && folder !== "TRASH") target = email.status === "DRAFT" ? "DRAFTS" : "SENT";
    // Restoring from trash puts the message back where it belongs.
    if (email.folder === "TRASH" && folder === "INBOX" && email.direction === "OUTBOUND") {
      target = email.status === "DRAFT" ? "DRAFTS" : "SENT";
    }

    const pool = await poolPromise;
    await pool
      .request()
      .input("id", sql.Int, emailId)
      .input("folder", sql.VarChar(20), target)
      .query("UPDATE Emails SET folder = @folder WHERE email_id = @id");
    return res.status(200).json({ success: true, message: `Moved to ${target}.`, folder: target });
  } catch (err) {
    return fail(res, "moveEmail", err, "Failed to move email.");
  }
};

// DELETE /:emailId — first delete moves to TRASH, deleting from TRASH is permanent.
export const deleteEmail = async (req, res) => {
  const emailId = parsePositiveInt(req.params.emailId);
  if (!emailId) return res.status(400).json({ success: false, message: "A valid emailId is required." });

  try {
    const found = await getAccessibleEmail(req, emailId);
    if (found.status) return res.status(found.status).json({ success: false, message: found.message });
    const { email } = found;
    const pool = await poolPromise;

    if (email.folder !== "TRASH") {
      await pool.request().input("id", sql.Int, emailId).query("UPDATE Emails SET folder = 'TRASH' WHERE email_id = @id");
      return res.status(200).json({ success: true, message: "Moved to trash.", folder: "TRASH" });
    }

    const files = await loadStorageNames(emailId);
    // Soft-delete rather than DELETE: if the message still exists on the mail server, the sync
    // dedupes on message_id and would otherwise re-import it.
    await pool.request().input("id", sql.Int, emailId).query("UPDATE Emails SET deleted_at = GETDATE() WHERE email_id = @id");
    await pool.request().input("id", sql.Int, emailId).query("DELETE FROM EmailAttachments WHERE email_id = @id");
    await Promise.all(files.map((f) => fs.promises.unlink(attachmentPath(f)).catch(() => {})));
    return res.status(200).json({ success: true, message: "Email permanently deleted." });
  } catch (err) {
    return fail(res, "deleteEmail", err, "Failed to delete email.");
  }
};

const loadStorageNames = async (emailId) => {
  const pool = await poolPromise;
  const r = await pool.request().input("id", sql.Int, emailId).query("SELECT storage_name FROM EmailAttachments WHERE email_id = @id");
  return r.recordset.map((x) => x.storage_name);
};

// GET /attachments/:attachmentId
export const downloadAttachment = async (req, res) => {
  const attachmentId = parsePositiveInt(req.params.attachmentId);
  if (!attachmentId) return res.status(400).json({ success: false, message: "A valid attachmentId is required." });

  try {
    const pool = await poolPromise;
    const r = await pool
      .request()
      .input("id", sql.Int, attachmentId)
      .query("SELECT * FROM EmailAttachments WHERE attachment_id = @id");
    const att = r.recordset[0];
    if (!att) return res.status(404).json({ success: false, message: "Attachment not found." });

    const found = await getAccessibleEmail(req, att.email_id);
    if (found.status) return res.status(found.status).json({ success: false, message: found.message });

    const filePath = attachmentPath(att.storage_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: "Attachment file is missing." });

    // Always a download, never rendered inline: attachments are untrusted content.
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.download(filePath, att.file_name);
  } catch (err) {
    return fail(res, "downloadAttachment", err, "Failed to download attachment.");
  }
};

// ===========================================================================
// Compose: send / drafts
// ===========================================================================
// Resolves lead_id / case_id from the request, falling back to the first recipient's lead.
const resolveClientLink = async (pool, body, to) => {
  let leadId = null;
  let caseId = null;

  if (body.case_id) {
    const id = parsePositiveInt(body.case_id);
    const caseRow = id && (await getCaseOrNull(pool, id));
    if (!caseRow) return { error: "case_id not found." };
    caseId = caseRow.case_id;
    leadId = caseRow.lead_id;
  } else if (body.lead_id) {
    const id = parsePositiveInt(body.lead_id);
    const lead = id && (await getLeadOrNull(pool, id));
    if (!lead) return { error: "lead_id not found." };
    leadId = lead.lead_id;
    caseId = await resolveCaseIdForLead(pool, leadId);
  } else if (to.length) {
    leadId = await findLeadByEmail(pool, to[0]);
    caseId = leadId ? await resolveCaseIdForLead(pool, leadId) : null;
  }
  return { leadId, caseId };
};

const fileAttachments = (req) =>
  (req.files || []).map((f) => ({ filename: f.originalname, contentType: f.mimetype, content: f.buffer }));

// Parses and validates the compose form shared by /send and /drafts.
const readCompose = (req, { requireRecipients }) => {
  const body = req.body || {};
  const to = toAddressList(body.to);
  const cc = toAddressList(body.cc);
  const bcc = toAddressList(body.bcc);

  if (requireRecipients && !to.length) return { error: "At least one recipient in 'to' is required." };
  const bad = invalidAddresses([...to, ...cc, ...bcc]);
  if (bad.length) return { error: `Invalid email address: ${bad.join(", ")}` };

  const subject = String(body.subject || "").trim();
  const html = body.body_html || null;
  const text = body.body_text || null;
  if (requireRecipients && !html && !text) return { error: "Email body is required." };
  if (requireRecipients && !subject) return { error: "subject is required." };

  return { to, cc, bcc, subject, html, text };
};

const getUsableAccount = async (req, res, accountIdRaw) => {
  const accountId = parsePositiveInt(accountIdRaw);
  if (!accountId) {
    res.status(400).json({ success: false, message: "account_id (the mailbox to send from) is required." });
    return null;
  }
  const account = await getAccountById(accountId);
  if (!account) {
    res.status(404).json({ success: false, message: "Email account not found." });
    return null;
  }
  if (!canUseAccount(req, account) || !account.is_active) {
    res.status(403).json({ success: false, message: "You cannot send from this mailbox." });
    return null;
  }
  return account;
};

// POST /send (multipart/form-data or JSON)
//   account_id, to, cc, bcc, subject, body_html | body_text,
//   lead_id | case_id, reply_to_email_id, draft_id, attachments[]
export const sendEmailHandler = async (req, res) => {
  const form = readCompose(req, { requireRecipients: true });
  if (form.error) return res.status(400).json({ success: false, message: form.error });
  const body = req.body || {};

  try {
    const account = await getUsableAccount(req, res, body.account_id);
    if (!account) return;
    const pool = await poolPromise;

    const link = await resolveClientLink(pool, body, form.to);
    if (link.error) return res.status(400).json({ success: false, message: link.error });

    let replyTo = null;
    if (body.reply_to_email_id) {
      const found = await getAccessibleEmail(req, parsePositiveInt(body.reply_to_email_id));
      if (found.status) return res.status(400).json({ success: false, message: "reply_to_email_id is not valid." });
      replyTo = found.email;
    }

    let draft = null;
    if (body.draft_id) {
      const found = await getAccessibleEmail(req, parsePositiveInt(body.draft_id));
      if (found.status || found.email.status !== "DRAFT") {
        return res.status(400).json({ success: false, message: "draft_id is not a valid draft." });
      }
      draft = found.email;
    }

    let sent;
    try {
      sent = await sendEmail({
        account,
        userId: req.user.id,
        ...form,
        leadId: link.leadId,
        caseId: link.caseId,
        attachments: fileAttachments(req),
        replyTo,
      });
    } catch (err) {
      console.error("[sendEmail] SMTP error:", err);
      return res.status(502).json({ success: false, message: `Email could not be sent: ${err.message}` });
    }

    // The message is already out; draft cleanup and the timeline entry must not turn that into an error.
    if (draft) {
      await pool.request().input("id", sql.Int, draft.email_id).query("DELETE FROM Emails WHERE email_id = @id").catch(() => {});
    }
    if (link.leadId) {
      const tx = new sql.Transaction(pool);
      try {
        await tx.begin();
        const { ipAddress, userAgent } = getRequestInfo(req);
        await createActivityLog({
          transaction: tx,
          leadId: link.leadId,
          caseId: link.caseId,
          userId: req.user.id,
          activityType: "EMAIL_SENT",
          entityType: link.caseId ? "CASE" : "LEAD",
          entityId: link.caseId || link.leadId,
          newValue: form.subject,
          description: `Email sent to ${form.to.join(", ")}: ${form.subject}`,
          ipAddress,
          userAgent,
        });
        await tx.commit();
      } catch (err) {
        await tx.rollback().catch(() => {});
        console.error("[sendEmail] Activity log failed:", err);
      }
    }

    return res.status(201).json({ success: true, message: "Email sent.", data: sent });
  } catch (err) {
    return fail(res, "sendEmail", err, "Failed to send email.");
  }
};

// POST /drafts — create, or overwrite when draft_id is given. Recipients/body are all optional.
export const saveDraft = async (req, res) => {
  const form = readCompose(req, { requireRecipients: false });
  if (form.error) return res.status(400).json({ success: false, message: form.error });
  const body = req.body || {};

  try {
    const account = await getUsableAccount(req, res, body.account_id);
    if (!account) return;
    const pool = await poolPromise;

    const link = await resolveClientLink(pool, body, form.to);
    if (link.error) return res.status(400).json({ success: false, message: link.error });

    if (body.draft_id) {
      const found = await getAccessibleEmail(req, parsePositiveInt(body.draft_id));
      if (found.status || found.email.status !== "DRAFT") {
        return res.status(400).json({ success: false, message: "draft_id is not a valid draft." });
      }
      await pool.request().input("id", sql.Int, found.email.email_id).query("DELETE FROM Emails WHERE email_id = @id");
    }

    const row = await insertEmail(
      pool,
      {
        accountId: account.account_id,
        folder: "DRAFTS",
        direction: "OUTBOUND",
        status: "DRAFT",
        messageId: null,
        fromAddress: account.email_address,
        fromName: account.display_name,
        ...form,
        html: form.html ? cleanHtml(form.html) : null,
        isRead: true,
        leadId: link.leadId,
        caseId: link.caseId,
        sentByUserId: req.user.id,
      },
      fileAttachments(req)
    );
    return res.status(201).json({ success: true, message: "Draft saved.", data: row });
  } catch (err) {
    return fail(res, "saveDraft", err, "Failed to save draft.");
  }
};
