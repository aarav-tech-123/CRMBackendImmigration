import cron from "node-cron";
import { sql, poolPromise } from "../../config/db.js";
import { sendPushToUser } from "../push/push.service.js";

const BATCH_SIZE = 50;
// If pushing fails transiently, keep retrying for this long after remind_at, then give up.
const RETRY_WINDOW_MINUTES = 15;

let running = false;

const processDueReminders = async () => {
  // Guard against overlapping runs in this process.
  if (running) return;
  running = true;

  try {
    const pool = await poolPromise;

    // Atomically claim due reminders so a second instance/overlap can't send them twice.
    // remind_at is stored as UTC (mssql useUTC), so compare against SYSUTCDATETIME(), not GETDATE().
    const claimed = await pool.request().input("batch", sql.Int, BATCH_SIZE).query(`
      UPDATE TOP (@batch) Reminders
      SET is_sent = 1, sent_at = GETDATE(), updated_at = GETDATE()
      OUTPUT INSERTED.reminder_id, INSERTED.user_id, INSERTED.lead_id, INSERTED.case_id,
             INSERTED.title, INSERTED.description, INSERTED.priority, INSERTED.remind_at
      WHERE is_sent = 0 AND status = 'Pending' AND remind_at <= SYSUTCDATETIME()
    `);

    for (const r of claimed.recordset) {
      try {
        const title = `Reminder: ${r.title}`;
        const body = r.description || `Priority: ${r.priority}`;

        // In-app notification (so it shows in the bell even without push).
        await pool
          .request()
          .input("user_id", sql.Int, r.user_id)
          .input("lead_id", sql.Int, r.lead_id)
          .input("case_id", sql.Int, r.case_id)
          .input("title", sql.NVarChar(255), title.slice(0, 255))
          .input("message", sql.NVarChar(sql.MAX), body)
          .query(`
            INSERT INTO Notifications (user_id, lead_id, case_id, notification_type, title, message, is_read, created_at)
            VALUES (@user_id, @lead_id, @case_id, 'REMINDER', @title, @message, 0, GETDATE())
          `);

        const link = r.case_id ? `/cases/${r.case_id}` : r.lead_id ? `/leads/${r.lead_id}` : "/";
        const push = await sendPushToUser(r.user_id, {
          title,
          body,
          data: { type: "REMINDER", reminder_id: r.reminder_id, lead_id: r.lead_id, case_id: r.case_id, link },
        });

        // Push couldn't be delivered because of a temporary problem: release for retry while still fresh.
        const ageMin = (Date.now() - new Date(r.remind_at).getTime()) / 60000;
        if (push.transientFailure && push.sent === 0 && ageMin < RETRY_WINDOW_MINUTES) {
          await pool.request().input("id", sql.Int, r.reminder_id)
            .query("UPDATE Reminders SET is_sent = 0, sent_at = NULL WHERE reminder_id = @id");
        }
      } catch (err) {
        console.error(`[reminders] failed to process reminder ${r.reminder_id}:`, err.message);
        // Release the claim so the next tick retries it.
        await pool.request().input("id", sql.Int, r.reminder_id)
          .query("UPDATE Reminders SET is_sent = 0, sent_at = NULL WHERE reminder_id = @id")
          .catch(() => {});
      }
    }
  } catch (err) {
    console.error("[reminders] scheduler tick failed:", err.message);
  } finally {
    running = false;
  }
};

export const startReminderScheduler = () => {
  // Opt-in: reminders are not delivered until REMINDER_SCHEDULER=on is set.
  if (process.env.REMINDER_SCHEDULER !== "on") {
    console.log("[reminders] scheduler disabled (set REMINDER_SCHEDULER=on to enable)");
    return;
  }
  cron.schedule("* * * * *", processDueReminders); // every minute
  console.log("[reminders] scheduler started (every minute)");
};

export { processDueReminders };
