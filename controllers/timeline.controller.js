import { poolPromise } from "../config/db.js";


// Update the status of a lead and insert a new record in the StatusTimeline table

export const updateLeadStatus = async (req, res) => {
  const { lead_id } = req.params;
  const { status } = req.body;

    try {
    const pool = await poolPromise;
    // Check if lead exists
    const leadResult = await pool.request()
      .input("lead_id", lead_id)
      .query("SELECT lead_id FROM Leads WHERE lead_id = @lead_id");

    if (leadResult.recordset.length === 0) {
      return res.status(404).json({ message: "Lead not found." });
    }

    // Update the lead's status Also Insert New Record in StatusTimeline Table and set old status to the previous status of the lead

    const oldStatus = leadResult.recordset[0].status;

    await pool.request()
      .input("lead_id", lead_id)
      .input("status", status)
      .query("UPDATE Leads SET status = @status, updated_at = GETDATE() WHERE lead_id = @lead_id");

    await pool.request()
      .input("lead_id", lead_id)
      .input("new_status", status)
      .input("old_status", oldStatus)
      .input("changed_by", req.user.id)
      .input("note", req.body.note || `Status changed from ${oldStatus} to ${status}`)
      .input("changed_at", new Date())
      .query(`
        INSERT INTO StatusTimeline (lead_id, new_status, old_status, changed_by, note, changed_at)
        VALUES (@lead_id, @new_status, @old_status, @changed_by, @note, @changed_at)
      `);

    res.json({ message: "Lead status updated successfully!" });

  } catch (err) {
    console.error("Update Lead Status Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};



// Get the status timeline for a specific lead

export const getLeadStatusTimeline = async (req, res) => {
  const { lead_id } = req.params;

    try {
    const pool = await poolPromise;

    // Check if lead exists
    const leadResult = await pool.request()
      .input("lead_id", lead_id)
      .query("SELECT lead_id FROM Leads WHERE lead_id = @lead_id");

    if (leadResult.recordset.length === 0) {
      return res.status(404).json({ message: "Lead not found." });
    }

    // Fetch the status timeline for the lead Also Join with lead table
    const timelineResult = await pool.request()
      .input("lead_id", lead_id)
        .query(`
            SELECT
                l.first_name + ' ' + l.last_name AS lead_name,
                l.email,
                l.phone_number,
                st.id,
                st.lead_id,
                st.new_status,
                st.old_status,
                st.changed_by,
                u.name
                AS changed_by_name,
                st.note,
                st.changed_at
            FROM StatusTimeline st
            JOIN Leads l ON st.lead_id = l.lead_id
            JOIN Users u ON st.changed_by = u.id
            WHERE st.lead_id = @lead_id
            ORDER BY st.changed_at DESC
        `);

    res.json(timelineResult.recordset);

  } catch (err) {
    console.error("Get Lead Status Timeline Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};



// Get status timeline by user Id on a particular date

export const getStatusTimelineByDate = async (req, res) => {
  const date = req.params.date; // Expecting date in 'YYYY-MM-DD' format
  const user_id = req.query.user_id; // Optional query parameter for user ID

  const userID = req.user.id; // Get the user ID from the authenticated request

    try {
    const pool = await poolPromise;

    // Fetch the status timeline for the user on the specified date
    const timelineResult = await pool.request()
      .input("user_id", user_id || userID) // Use the provided user_id or the authenticated user's ID
      .input("date", date)
        .query(`
            SELECT
                l.first_name + ' ' + l.last_name AS lead_name,
                l.email,
                l.phone_number,
                st.new_status,
                st.old_status,
                u.name,
                st.note,
                st.changed_at
            FROM StatusTimeline st
            JOIN Leads l ON st.lead_id = l.lead_id
            JOIN Users u ON st.changed_by = u.id
            WHERE st.changed_by = @user_id
              AND CAST(st.changed_at AS DATE) = @date
            ORDER BY st.changed_at DESC
        `);

    res.json(timelineResult.recordset);

  } catch (err) {
    console.error("Get Status Timeline Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};



