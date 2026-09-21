import { sql, poolPromise } from "../config/db.js";


// Assign lead to a user (admin/super admin) (New Assign Lead Functionality)

export const assignLead = async (req, res) => {
  const { lead_id, assigned_to } = req.body;
  const assigned_from = req.user.id; // The admin/super admin assigning

  try {
    // Validate required fields
    if (!lead_id || !assigned_to) {
      return res.status(400).json({ message: "lead_id and assigned_to are required." });
    }

    const pool = await poolPromise;

    // Check if lead exists
    const leadResult = await pool.request()
      .input("lead_id", lead_id)
      .query("SELECT lead_id FROM Leads WHERE lead_id = @lead_id");

    if (leadResult.recordset.length === 0) {
      return res.status(404).json({ message: "Lead not found." });
    }

    // Check if user exists
    const userResult = await pool.request()
      .input("assigned_to", assigned_to)
      .query("SELECT id FROM Users WHERE id = @assigned_to");

    if (userResult.recordset.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    // Insert into LeadAssignments
    await pool.request()
      .input("lead_id", lead_id)
      .input("assigned_from", assigned_from)
      .input("assigned_to", assigned_to)
      .query(`
        INSERT INTO LeadAssignments (lead_id, assigned_from, assigned_to, assigned_at)
        VALUES (@lead_id, @assigned_from, @assigned_to, GETDATE())
      `);


    // Update the lead's assigned_to
    await pool.request()
      .input("lead_id", lead_id)
      .input("assigned_to", assigned_to)
      .query("UPDATE Leads SET assigned_to = @assigned_to, updated_at = GETDATE() WHERE lead_id = @lead_id");




    res.json({ message: "Lead assigned successfully!" });
  } catch (err) {
    console.error("Assign Lead Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};



// Update lead assignment (admin/super admin) (Reassign Lead)

export const updateLeadAssignment = async (req, res) => {
  const { id: lead_id } = req.params; // treat param as lead_id
  const { assigned_to } = req.body;
  const assigned_from = req.user.id; // The admin/super admin updating the assignment
  try {
    if (!assigned_to) {
      return res.status(400).json({ message: "assigned_to is required." });
    }

    const pool = await poolPromise;

    // Check if user exists
    const userResult = await pool.request()
      .input("assigned_to", assigned_to)
      .query("SELECT id FROM Users WHERE id = @assigned_to");

    if (userResult.recordset.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    // Check if assignment already exists for this lead
    const assignmentResult = await pool.request()
      .input("lead_id", lead_id)
      .query("SELECT id FROM LeadAssignments WHERE lead_id = @lead_id");

    let assignmentId;

    if (assignmentResult.recordset.length > 0) {
      // UPDATE
      assignmentId = assignmentResult.recordset[0].id;

      await pool.request()
        .input("id", assignmentId)
        .input("assigned_to", assigned_to)
        .input("assigned_from", assigned_from)
        .query(`
          UPDATE LeadAssignments
          SET assigned_to = @assigned_to,
              assigned_from = @assigned_from,
              assigned_at = GETDATE()
          WHERE id = @id
        `);

    } else {
      // INSERT
      const insertResult = await pool.request()
        .input("lead_id", lead_id)
        .input("assigned_to", assigned_to)
        .input("assigned_from", assigned_from)
        .query(`
          INSERT INTO LeadAssignments (lead_id, assigned_to, assigned_from, assigned_at)
          OUTPUT INSERTED.id
          VALUES (@lead_id, @assigned_to, @assigned_from, GETDATE())
        `);

      assignmentId = insertResult.recordset[0].id;
    }

    // Update Leads table
    await pool.request()
      .input("lead_id", lead_id)
      .input("assigned_to", assigned_to)
      .query(`
        UPDATE Leads
        SET assigned_to = @assigned_to,
            updated_at = GETDATE()
        WHERE lead_id = @lead_id
      `);

  } catch (err) {
    console.error("Update Lead Assignment Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};
