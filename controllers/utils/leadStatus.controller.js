import { poolPromise } from "../../config/db.js";



export const getAllLeadStatuses = async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .query("SELECT * FROM LeadStatuses ORDER BY sort_order DESC");
    res.json(result.recordset);
  } catch (err) {
    console.error("Get All Lead Status Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};