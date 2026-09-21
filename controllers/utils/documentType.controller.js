import { poolPromise } from "../../config/db.js";

export const getAllDocumentTypes = async (req, res) => {
  try {
    const pool = await poolPromise;
    const includeInactive = req.query.includeInactive === "1";

    const result = await pool.request().query(`
      SELECT document_type_id, document_code, document_name, description, is_active, created_at
      FROM DocumentTypes
      ${includeInactive ? "" : "WHERE is_active = 1"}
      ORDER BY document_name
    `);

    res.json({ success: true, documentTypes: result.recordset });
  } catch (err) {
    console.error("Get All Document Types Error:", err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};
