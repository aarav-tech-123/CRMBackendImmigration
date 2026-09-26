import { sql, poolPromise } from "../../config/db.js";

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


export const getLeadbyId = async (req, res) => {
  try {

    const lead_id = req.params.id
    const pool = await poolPromise

     if (!lead_id) {
    return res.status(400).json({ success: false, message: "A valid Status Id is required." });
  }

    const result = pool.request()
    .input('lead_id', sql.Int, lead_id )
    .query(`Select * From LeadStatuses where id = lead_id`)

    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Lead status not found." });
    }

    res.json({ success: true, LeadStatus: result.recordset[0] });

  } catch (err) {
     console.error("Get Document Type By ID Error:", err);
     res.status(500).json({ success: false, message: "Server Error" });
  }
}

/**
 * Create Lead Status
 */
export const createLeadStatus = async (req, res) => {
  try {
    const {
      status_name,
      status_description,
      sort_order,
      is_active,
      action
    } = req.body;

    if (!status_name || String(status_name).trim() === "") {
      return res.status(400).json({
        success: false,
        message: "status_name is required"
      });
    }

    const pool = await poolPromise;

    const duplicateCheck = await pool
      .request()
      .input("status_name", sql.NVarChar(100), String(status_name).trim())
      .query(`
        SELECT id
        FROM LeadStatuses
        WHERE LOWER(status_name) = LOWER(@status_name)
      `);

    if (duplicateCheck.recordset.length > 0) {
      return res.status(409).json({
        success: false,
        message: `A lead status named "${status_name}" already exists`
      });
    }

    const result = await pool
      .request()
      .input("status_name", sql.NVarChar(100), String(status_name).trim())
      .input(
        "status_description",
        sql.NVarChar(500),
        status_description ? String(status_description).trim() : null
      )
      .input(
        "sort_order",
        sql.Int,
        sort_order !== undefined && sort_order !== null
          ? parseInt(sort_order, 10)
          : 0
      )
      .input("is_active", sql.Bit, is_active !== undefined ? Boolean(is_active) : true)
      .input("action", sql.Bit, action !== undefined ? Boolean(action) : false)
      .query(`
        INSERT INTO LeadStatuses (
          status_name,
          status_description,
          sort_order,
          is_active,
          action,
          created_at
        )
        OUTPUT INSERTED.*
        VALUES (
          @status_name,
          @status_description,
          @sort_order,
          @is_active,
          @action,
          GETDATE()
        )
      `);

    return res.status(201).json({
      success: true,
      message: "Lead status created successfully",
      data: result.recordset[0]
    });

  } catch (err) {
    console.error("Create Lead Status Error:", err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};


/**
 * Update Lead Status
 */
export const updateLeadStatus = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: "Valid lead status id is required"
      });
    }

    const {
      status_name,
      status_description,
      sort_order,
      is_active,
      action
    } = req.body;

    const pool = await poolPromise;

    const existingResult = await pool
      .request()
      .input("id", sql.Int, Number(id))
      .query(`
        SELECT *
        FROM LeadStatuses
        WHERE id = @id
      `);

    if (existingResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Lead status not found"
      });
    }

    const existingStatus = existingResult.recordset[0];

    const finalStatusName =
      status_name !== undefined && String(status_name).trim() !== ""
        ? String(status_name).trim()
        : existingStatus.status_name;

    const duplicateCheck = await pool
      .request()
      .input("id", sql.Int, Number(id))
      .input("status_name", sql.NVarChar(100), finalStatusName)
      .query(`
        SELECT id
        FROM LeadStatuses
        WHERE LOWER(status_name) = LOWER(@status_name)
          AND id <> @id
      `);

    if (duplicateCheck.recordset.length > 0) {
      return res.status(409).json({
        success: false,
        message: `A lead status named "${finalStatusName}" already exists`
      });
    }

    const result = await pool
      .request()
      .input("id", sql.Int, Number(id))
      .input("status_name", sql.NVarChar(100), finalStatusName)
      .input(
        "status_description",
        sql.NVarChar(500),
        status_description !== undefined
          ? (status_description ? String(status_description).trim() : null)
          : existingStatus.status_description
      )
      .input(
        "sort_order",
        sql.Int,
        sort_order !== undefined && sort_order !== null
          ? parseInt(sort_order, 10)
          : existingStatus.sort_order
      )
      .input(
        "is_active",
        sql.Bit,
        is_active !== undefined ? Boolean(is_active) : existingStatus.is_active
      )
      .input(
        "action",
        sql.Bit,
        action !== undefined ? Boolean(action) : existingStatus.action
      )
      .query(`
        UPDATE LeadStatuses
        SET
          status_name = @status_name,
          status_description = @status_description,
          sort_order = @sort_order,
          is_active = @is_active,
          action = @action
        OUTPUT INSERTED.*
        WHERE id = @id
      `);

    return res.status(200).json({
      success: true,
      message: "Lead status updated successfully",
      data: result.recordset[0]
    });

  } catch (err) {
    console.error("Update Lead Status Error:", err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};


/**
 * Delete Lead Status
 */
export const deleteLeadStatus = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: "Valid lead status id is required"
      });
    }

    const pool = await poolPromise;

    const existingResult = await pool
      .request()
      .input("id", sql.Int, Number(id))
      .query(`
        SELECT *
        FROM LeadStatuses
        WHERE id = @id
      `);

    if (existingResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Lead status not found"
      });
    }

    // Leads.lead_status is NOT NULL and references this table -
    // block deletion while leads still use this status.
    const usageCheck = await pool
      .request()
      .input("id", sql.Int, Number(id))
      .query(`
        SELECT COUNT(*) AS lead_count
        FROM Leads
        WHERE lead_status = @id
      `);

    const leadCount = usageCheck.recordset[0].lead_count;

    if (leadCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete: ${leadCount} lead(s) currently use this status. Deactivate it instead (is_active = false).`
      });
    }

    const result = await pool
      .request()
      .input("id", sql.Int, Number(id))
      .query(`
        DELETE FROM LeadStatuses
        OUTPUT DELETED.*
        WHERE id = @id
      `);

    return res.status(200).json({
      success: true,
      message: "Lead status deleted successfully",
      data: result.recordset[0]
    });

  } catch (err) {
    console.error("Delete Lead Status Error:", err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};
