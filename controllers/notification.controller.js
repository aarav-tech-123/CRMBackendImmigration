import { sql, poolPromise } from "../config/db.js";
import { createNotification } from "../helpers/notifications.js";
import { parsePositiveInt, paginationParams } from "../helpers/parsers.js";

const NOTIFICATION_SELECT = `
  n.notification_id, n.user_id, n.lead_id, n.case_id, n.notification_type,
  n.title, n.message, n.is_read, n.read_at, n.created_at
`;

// ---------------------------------------------------------------------------
// GET /?is_read=0|1&notification_type= — the requesting user's own notifications
// ---------------------------------------------------------------------------
export const getMyNotifications = async (req, res) => {
  const { page, pageSize, offset } = paginationParams(req);
  const isRead = req.query.is_read === "1" ? 1 : req.query.is_read === "0" ? 0 : null;
  const notificationType = req.query.notification_type || null;

  try {
    const pool = await poolPromise;

    const buildRequest = () =>
      pool
        .request()
        .input("user_id", sql.Int, req.user.id)
        .input("is_read", sql.Bit, isRead)
        .input("notification_type", sql.VarChar(50), notificationType);

    const [dataResult, countResult] = await Promise.all([
      buildRequest()
        .input("offset", sql.Int, offset)
        .input("pageSize", sql.Int, pageSize)
        .query(`
          SELECT ${NOTIFICATION_SELECT}
          FROM Notifications n
          WHERE n.user_id = @user_id
            AND (@is_read IS NULL OR n.is_read = @is_read)
            AND (@notification_type IS NULL OR n.notification_type = @notification_type)
          ORDER BY n.created_at DESC
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `),
      buildRequest().query(`
        SELECT COUNT(*) AS total
        FROM Notifications n
        WHERE n.user_id = @user_id
          AND (@is_read IS NULL OR n.is_read = @is_read)
          AND (@notification_type IS NULL OR n.notification_type = @notification_type);
      `),
    ]);

    return res.status(200).json({
      success: true,
      page,
      pageSize,
      total: countResult.recordset[0].total,
      notifications: dataResult.recordset,
    });
  } catch (err) {
    console.error("[getMyNotifications] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch notifications." });
  }
};

// ---------------------------------------------------------------------------
// GET /unread-count
// ---------------------------------------------------------------------------
export const getUnreadNotificationCount = async (req, res) => {
  try {
    const pool = await poolPromise;

    const result = await pool
      .request()
      .input("user_id", sql.Int, req.user.id)
      .query("SELECT COUNT(*) AS unread FROM Notifications WHERE user_id = @user_id AND is_read = 0");

    return res.status(200).json({ success: true, unread: result.recordset[0].unread });
  } catch (err) {
    console.error("[getUnreadNotificationCount] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch unread notification count." });
  }
};

// ---------------------------------------------------------------------------
// POST / — send a notification to a user (Manager/SuperAdmin only, route-gated)
// ---------------------------------------------------------------------------
export const createNotificationForUser = async (req, res) => {
  const { user_id, lead_id, case_id, notification_type, title, message } = req.body || {};

  const userId = parsePositiveInt(user_id);
  if (!userId) {
    return res.status(400).json({ success: false, message: "A valid user_id is required." });
  }
  if (!notification_type || !String(notification_type).trim()) {
    return res.status(400).json({ success: false, message: "notification_type is required." });
  }
  if (!title || !String(title).trim()) {
    return res.status(400).json({ success: false, message: "title is required." });
  }
  if (!message || !String(message).trim()) {
    return res.status(400).json({ success: false, message: "message is required." });
  }

  let leadId = parsePositiveInt(lead_id);
  if (lead_id !== undefined && lead_id !== null && lead_id !== "" && !leadId) {
    return res.status(400).json({ success: false, message: "Invalid lead_id." });
  }
  let caseId = parsePositiveInt(case_id);
  if (case_id !== undefined && case_id !== null && case_id !== "" && !caseId) {
    return res.status(400).json({ success: false, message: "Invalid case_id." });
  }

  let transaction = null;
  let transactionStarted = false;

  try {
    const pool = await poolPromise;

    const userCheck = await pool.request().input("id", sql.Int, userId).query("SELECT id FROM Users WHERE id = @id");
    if (userCheck.recordset.length === 0) {
      return res.status(400).json({ success: false, message: "user_id does not exist." });
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    transactionStarted = true;

    const createdNotification = await createNotification({
      transaction,
      userId,
      leadId,
      caseId,
      notificationType: notification_type.trim(),
      title: title.trim(),
      message: message.trim(),
    });

    await transaction.commit();
    transactionStarted = false;

    return res.status(201).json({ success: true, message: "Notification created successfully.", data: createdNotification });
  } catch (err) {
    if (transaction && transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error("[createNotificationForUser] Rollback failed:", rollbackErr);
      }
    }
    console.error("[createNotificationForUser] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to create notification." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /:notificationId/read — owner only
// ---------------------------------------------------------------------------
export const markNotificationRead = async (req, res) => {
  const notificationId = parsePositiveInt(req.params.notificationId);
  if (!notificationId) {
    return res.status(400).json({ success: false, message: "A valid notificationId is required." });
  }

  try {
    const pool = await poolPromise;

    const existingResult = await pool
      .request()
      .input("notification_id", sql.Int, notificationId)
      .query("SELECT notification_id, user_id, is_read FROM Notifications WHERE notification_id = @notification_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Notification not found." });
    }
    const existing = existingResult.recordset[0];

    if (existing.user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "You do not have permission to update this notification." });
    }
    if (existing.is_read) {
      return res.status(200).json({ success: true, message: "Notification is already read." });
    }

    const updateResult = await pool
      .request()
      .input("notification_id", sql.Int, notificationId)
      .query(`
        UPDATE Notifications
        SET is_read = 1, read_at = GETDATE()
        OUTPUT INSERTED.*
        WHERE notification_id = @notification_id
      `);

    return res.status(200).json({ success: true, message: "Notification marked as read.", data: updateResult.recordset[0] });
  } catch (err) {
    console.error("[markNotificationRead] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update notification." });
  }
};

// ---------------------------------------------------------------------------
// PATCH /read-all — mark every unread notification for the requester as read
// ---------------------------------------------------------------------------
export const markAllNotificationsRead = async (req, res) => {
  try {
    const pool = await poolPromise;

    const result = await pool
      .request()
      .input("user_id", sql.Int, req.user.id)
      .query(`
        UPDATE Notifications
        SET is_read = 1, read_at = GETDATE()
        OUTPUT INSERTED.notification_id
        WHERE user_id = @user_id AND is_read = 0
      `);

    return res.status(200).json({ success: true, message: "All notifications marked as read.", updated: result.recordset.length });
  } catch (err) {
    console.error("[markAllNotificationsRead] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update notifications." });
  }
};

// ---------------------------------------------------------------------------
// DELETE /:notificationId — owner only
// ---------------------------------------------------------------------------
export const deleteNotification = async (req, res) => {
  const notificationId = parsePositiveInt(req.params.notificationId);
  if (!notificationId) {
    return res.status(400).json({ success: false, message: "A valid notificationId is required." });
  }

  try {
    const pool = await poolPromise;

    const existingResult = await pool
      .request()
      .input("notification_id", sql.Int, notificationId)
      .query("SELECT notification_id, user_id FROM Notifications WHERE notification_id = @notification_id");
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Notification not found." });
    }
    const existing = existingResult.recordset[0];

    if (existing.user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "You do not have permission to delete this notification." });
    }

    await pool
      .request()
      .input("notification_id", sql.Int, notificationId)
      .query("DELETE FROM Notifications WHERE notification_id = @notification_id");

    return res.status(200).json({ success: true, message: "Notification deleted successfully." });
  } catch (err) {
    console.error("[deleteNotification] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete notification." });
  }
};
