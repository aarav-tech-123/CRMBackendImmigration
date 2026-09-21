import { poolPromise } from "../../config/db.js";

export const getAllDocumentStatuses = async (req, res) => {
  try {
    const pool = await poolPromise;
    const includeInactive = req.query.includeInactive === "1";

    const result = await pool.request().query(`
      SELECT document_status_id, status_name, sort_order, is_active
      FROM DocumentStatuses
      ${includeInactive ? "" : "WHERE is_active = 1"}
      ORDER BY sort_order
    `);

    res.json({ success: true, statuses: result.recordset });
  } catch (err) {
    console.error("Get All Document Statuses Error:", err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};
