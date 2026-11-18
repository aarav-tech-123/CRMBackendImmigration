import { sql, poolPromise } from "../../config/db.js";
import { getMessaging } from "./firebase.js";

// Tokens FCM tells us are dead — safe to delete.
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);
// Failures worth retrying later.
const TRANSIENT_CODES = new Set([
  "messaging/server-unavailable",
  "messaging/internal-error",
  "messaging/message-rate-exceeded",
  "messaging/quota-exceeded",
]);

const FCM_BATCH_LIMIT = 500;

// data values must all be strings for FCM.
const stringifyData = (data = {}) =>
  Object.fromEntries(Object.entries(data).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));

/**
 * Send a push to every registered device of a user.
 * Never throws. Returns { sent, failed, removed, transientFailure, skipped }.
 */
export const sendPushToUser = async (userId, { title, body, data } = {}) => {
  const result = { sent: 0, failed: 0, removed: 0, transientFailure: false, skipped: null };

  const messaging = getMessaging();
  if (!messaging) {
    result.skipped = "firebase-not-configured";
    return result;
  }

  try {
    const pool = await poolPromise;
    const { recordset } = await pool
      .request()
      .input("user_id", sql.Int, userId)
      .query("SELECT fcm_token FROM UserDeviceTokens WHERE user_id = @user_id");

    const tokens = recordset.map((r) => r.fcm_token);
    if (tokens.length === 0) {
      result.skipped = "no-device-tokens";
      return result;
    }

    const dead = [];
    for (let i = 0; i < tokens.length; i += FCM_BATCH_LIMIT) {
      const batch = tokens.slice(i, i + FCM_BATCH_LIMIT);
      const response = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        data: stringifyData(data),
        webpush: { fcmOptions: data?.link ? { link: String(data.link) } : undefined },
      });

      result.sent += response.successCount;
      result.failed += response.failureCount;
      response.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = r.error?.code;
        if (DEAD_TOKEN_CODES.has(code)) dead.push(batch[idx]);
        else if (TRANSIENT_CODES.has(code)) result.transientFailure = true;
        else console.error("[push] send failed:", code, r.error?.message);
      });
    }

    for (const token of dead) {
      await pool.request().input("t", sql.NVarChar(512), token).query("DELETE FROM UserDeviceTokens WHERE fcm_token = @t");
    }
    result.removed = dead.length;
  } catch (err) {
    console.error("[push] sendPushToUser error:", err.message);
    result.transientFailure = true;
  }

  return result;
};
