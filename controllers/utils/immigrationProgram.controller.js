import { poolPromise } from "../../config/db.js";



export const getAllPrograms = async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .query("SELECT * FROM ImmigrationPrograms ORDER BY program_id DESC");
    res.json(result.recordset);
  } catch (err) {
    console.error("Get All Immigration Programs Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};