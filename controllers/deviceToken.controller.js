import { sql, poolPromise } from "../config/db.js";

// POST / { token, platform? } — register (or re-assign) this browser/device for the logged-in user.
export const registerDeviceToken = async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  const platform = ["web", "android", "ios"].includes(req.body?.platform) ? req.body.platform : "web";

  if (!token || token.length > 512) {
    return res.status(400).json({ success: false, message: "A valid FCM token is required." });
  }

  try {
    const pool = await poolPromise;
    // A token identifies one browser profile; if someone else logs in on it, it moves to them.
    await pool
      .request()
      .input("user_id", sql.Int, req.user.id)
      .input("token", sql.NVarChar(512), token)
      .input("platform", sql.VarChar(20), platform)
      .input("ua", sql.NVarChar(500), (req.get("user-agent") || "").slice(0, 500))
      .query(`
        MERGE UserDeviceTokens AS t
        USING (SELECT @token AS fcm_token) AS s ON t.fcm_token = s.fcm_token
        WHEN MATCHED THEN
          UPDATE SET user_id = @user_id, platform = @platform, user_agent = @ua, last_seen_at = GETDATE()
        WHEN NOT MATCHED THEN
          INSERT (user_id, fcm_token, platform, user_agent) VALUES (@user_id, @token, @platform, @ua);
      `);

    return res.status(200).json({ success: true, message: "Device registered." });
  } catch (err) {
    console.error("registerDeviceToken error:", err);
    return res.status(500).json({ success: false, message: "Failed to register device." });
  }
};

// DELETE / { token } — call on logout so the device stops receiving this user's pushes.
export const removeDeviceToken = async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!token) {
    return res.status(400).json({ success: false, message: "token is required." });
  }

  try {
    const pool = await poolPromise;
    await pool
      .request()
      .input("user_id", sql.Int, req.user.id)
      .input("token", sql.NVarChar(512), token)
      .query("DELETE FROM UserDeviceTokens WHERE fcm_token = @token AND user_id = @user_id");

    return res.status(200).json({ success: true, message: "Device removed." });
  } catch (err) {
    console.error("removeDeviceToken error:", err);
    return res.status(500).json({ success: false, message: "Failed to remove device." });
  }
};
