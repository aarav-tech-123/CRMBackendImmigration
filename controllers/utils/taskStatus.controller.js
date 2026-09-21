import { poolPromise } from "../../config/db.js";

export const getAllTaskStatuses = async (req, res) => {
  try {
    const pool = await poolPromise;
    const includeInactive = req.query.includeInactive === "1";

    const result = await pool.request().query(`
      SELECT task_status_id, status_name, sort_order, is_active
      FROM TaskStatuses
      ${includeInactive ? "" : "WHERE is_active = 1"}
      ORDER BY sort_order
    `);

    res.json({ success: true, statuses: result.recordset });
  } catch (err) {
    console.error("Get All Task Statuses Error:", err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};
