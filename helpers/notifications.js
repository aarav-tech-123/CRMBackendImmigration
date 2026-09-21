import { sql } from "../config/db.js";

// Transaction-scoped, mirrors helpers/activityLogs.js. Returns the created row
// so callers can use it (e.g. to push a websocket event) without a re-fetch.
export const createNotification = async ({
    transaction,
    userId,
    leadId = null,
    caseId = null,
    notificationType,
    title,
    message
}) => {
    if (!transaction) {
        throw new Error('SQL transaction is required');
    }

    const request = new sql.Request(transaction);

    request.input('user_id', sql.Int, userId);
    request.input('lead_id', sql.Int, leadId);
    request.input('case_id', sql.Int, caseId);
    request.input('notification_type', sql.VarChar(50), notificationType);
    request.input('title', sql.NVarChar(255), title);
    request.input('message', sql.NVarChar(sql.MAX), message);

    const result = await request.query(`
        INSERT INTO Notifications (
            user_id, lead_id, case_id, notification_type, title, message, is_read, created_at
        )
        OUTPUT INSERTED.*
        VALUES (
            @user_id, @lead_id, @case_id, @notification_type, @title, @message, 0, GETDATE()
        )
    `);

    return result.recordset[0];
};
