import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { sql, poolPromise } from "../../config/db.js";
import { decryptSecret } from "./crypto.js";
import { storeInboundMessage } from "./email.service.js";

const FIRST_SYNC_DAYS = 30;
const FIRST_SYNC_MAX_MESSAGES = 200;
const BATCH_SIZE = 25;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

const SPECIAL_USE_TO_FOLDER = {
  "\\Sent": "SENT",
  "\\Junk": "SPAM",
  "\\Trash": "TRASH",
};

const connect = async (account) => {
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: !!account.imap_secure,
    auth: { user: account.username, pass: decryptSecret(account.password_enc) },
    logger: false,
  });
  // imapflow emits 'error' on dropped sockets; without a listener that would crash the process.
  client.on("error", (err) => console.error(`[imap:${account.account_id}] connection error:`, err.message));
  await client.connect();
  return client;
};

export const verifyImap = async (account) => {
  const client = await connect(account);
  await client.logout();
};

// INBOX plus whichever Sent / Junk / Trash mailboxes the server advertises.
const foldersToSync = async (client) => {
  const targets = [{ path: "INBOX", folder: "INBOX" }];
  for (const box of await client.list()) {
    const folder = SPECIAL_USE_TO_FOLDER[box.specialUse];
    if (folder && !targets.some((t) => t.folder === folder)) targets.push({ path: box.path, folder });
  }
  return targets;
};

const getState = async (accountId, remoteFolder) => {
  const pool = await poolPromise;
  const r = await pool
    .request()
    .input("account_id", sql.Int, accountId)
    .input("remote_folder", sql.NVarChar(255), remoteFolder)
    .query("SELECT uid_validity, last_uid FROM EmailSyncState WHERE account_id = @account_id AND remote_folder = @remote_folder");
  return r.recordset[0] || null;
};

const saveState = async (accountId, remoteFolder, uidValidity, lastUid) => {
  const pool = await poolPromise;
  await pool
    .request()
    .input("account_id", sql.Int, accountId)
    .input("remote_folder", sql.NVarChar(255), remoteFolder)
    .input("uid_validity", sql.NVarChar(40), String(uidValidity))
    .input("last_uid", sql.BigInt, lastUid)
    .query(`
      MERGE EmailSyncState AS t
      USING (SELECT @account_id AS account_id, @remote_folder AS remote_folder) AS s
        ON t.account_id = s.account_id AND t.remote_folder = s.remote_folder
      WHEN MATCHED THEN UPDATE SET uid_validity = @uid_validity, last_uid = @last_uid
      WHEN NOT MATCHED THEN INSERT (account_id, remote_folder, uid_validity, last_uid)
        VALUES (@account_id, @remote_folder, @uid_validity, @last_uid);
    `);
};

const syncFolder = async (client, account, { path, folder }) => {
  const lock = await client.getMailboxLock(path);
  let stored = 0;
  try {
    const uidValidity = String(client.mailbox.uidValidity);
    let state = await getState(account.account_id, path);
    // A changed UIDVALIDITY means the server renumbered the mailbox; start over (dedupe by Message-ID).
    let lastUid = state && state.uid_validity === uidValidity ? Number(state.last_uid) : 0;

    let uids;
    if (lastUid === 0) {
      const since = new Date(Date.now() - FIRST_SYNC_DAYS * 24 * 3600 * 1000);
      uids = (await client.search({ since }, { uid: true })) || [];
      uids = uids.slice(-FIRST_SYNC_MAX_MESSAGES);
    } else {
      // "n:*" always returns the newest message even when n is beyond it, so filter.
      uids = ((await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > lastUid);
    }
    uids.sort((a, b) => a - b);

    for (let i = 0; i < uids.length; i += BATCH_SIZE) {
      const batch = uids.slice(i, i + BATCH_SIZE);
      // Collect first: issuing other IMAP commands while iterating fetch() deadlocks.
      const messages = [];
      for await (const msg of client.fetch(batch.join(","), { uid: true, flags: true, size: true, source: true }, { uid: true })) {
        messages.push(msg);
      }

      for (const msg of messages) {
        if (msg.size > MAX_MESSAGE_BYTES || !msg.source) continue;
        try {
          const parsed = await simpleParser(msg.source);
          const row = await storeInboundMessage(account, parsed, {
            folder,
            remoteFolder: path,
            uid: msg.uid,
            seen: msg.flags?.has("\\Seen"),
          });
          if (row) stored++;
        } catch (err) {
          console.error(`[imap:${account.account_id}] failed to store ${path} uid ${msg.uid}:`, err.message);
        }
      }
      lastUid = Math.max(lastUid, ...batch);
      await saveState(account.account_id, path, uidValidity, lastUid);
    }
    if (uids.length === 0) await saveState(account.account_id, path, uidValidity, lastUid);
  } finally {
    lock.release();
  }
  return stored;
};

/** Pulls new mail for one account. Returns the number of new messages stored. */
export const syncAccount = async (account) => {
  const pool = await poolPromise;
  let client;
  let total = 0;
  try {
    client = await connect(account);
    for (const target of await foldersToSync(client)) {
      total += await syncFolder(client, account, target);
    }
    await pool
      .request()
      .input("id", sql.Int, account.account_id)
      .query("UPDATE EmailAccounts SET last_sync_at = GETDATE(), last_error = NULL WHERE account_id = @id");
  } catch (err) {
    console.error(`[imap:${account.account_id}] sync failed:`, err.message);
    await pool
      .request()
      .input("id", sql.Int, account.account_id)
      .input("err", sql.NVarChar(1000), String(err.message).slice(0, 1000))
      .query("UPDATE EmailAccounts SET last_error = @err WHERE account_id = @id");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
  return total;
};

// ---------------------------------------------------------------------------
// Background poller
// ---------------------------------------------------------------------------
let running = false;

export const syncAllAccounts = async () => {
  if (running) return; // previous pass still going
  running = true;
  try {
    const pool = await poolPromise;
    const { recordset } = await pool.request().query("SELECT * FROM EmailAccounts WHERE is_active = 1");
    for (const account of recordset) {
      try {
        await syncAccount(account);
      } catch {
        // already logged and recorded in last_error; keep going with the other accounts
      }
    }
  } finally {
    running = false;
  }
};

export const startEmailSync = () => {
  if (!process.env.EMAIL_ENC_KEY) {
    console.warn("[email] EMAIL_ENC_KEY not set; inbox sync disabled.");
    return;
  }
  const seconds = Math.max(Number(process.env.EMAIL_SYNC_INTERVAL_SEC) || 120, 30);
  setInterval(() => syncAllAccounts().catch((e) => console.error("[email] sync pass failed:", e)), seconds * 1000);
  setTimeout(() => syncAllAccounts().catch((e) => console.error("[email] sync pass failed:", e)), 5000);
  console.log(`[email] inbox sync every ${seconds}s`);
};
