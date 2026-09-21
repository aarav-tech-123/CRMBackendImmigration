import { poolPromise } from "../../config/db.js";



export const getAllPaymentTypes = async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .query("SELECT * FROM PaymentTypes ORDER BY payment_type_id DESC");
    res.json(result.recordset);
  } catch (err) {
    console.error("Get All Payment Types Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};



export const getPaymentTypeByStepId = async (req, res) => {
  const { step_id } = req.params;

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("stepId", step_id)
      .query("SELECT * FROM PaymentTypes WHERE step_id = @stepId ORDER BY payment_type_id DESC");
    res.json(result.recordset);
  } catch (err) {
    console.error("Get Payment Type By Step ID Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};