import { poolPromise } from "../config/db.js";


export const createFileStatus = async (req, res) => {
    const { status_name } = req.body;

    try {
        const pool = await poolPromise;
        // Check if the status already exists
        const existingStatus = await pool.request()
            .input("status_name", status_name)
            .query("SELECT * FROM FileStatus WHERE status_name = @status_name");

        if (existingStatus.recordset.length > 0) {
            return res.status(400).json({ message: "Status already exists." });
        }

        const result = await pool.request()
            .input("status_name", status_name)
            .input("created_at", new Date())
            .input("is_active", 1)
            .query("INSERT INTO FileStatus (status_name, created_at, is_active) VALUES (@status_name, @created_at, @is_active)");

        res.status(201).json({ message: "File status created successfully!" });
    }
    catch (err) {
        console.error("Create File Status Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
}



export const getAllFileStatuses = async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .query("SELECT * FROM FileStatus");

        res.json(result.recordset);
    }
    catch (err) {
        console.error("Get All File Statuses Error:", err);
        res.status(500).json({ message: "Server Error" });
    }

}



export const getFileStatusById = async (req, res) => {
    const { status_id } = req.params;

    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input("status_id", status_id)
            .query("SELECT * FROM FileStatus WHERE status_id = @status_id");

        if (result.recordset.length === 0) {
            return res.status(404).json({ message: "Status not found." });
        }

        res.json(result.recordset[0]);
    }
    catch (err) {
        console.error("Get File Status By ID Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
}



export const updateFileStatus = async (req, res) => {
    const { status_id } = req.params;
    const { status_name, is_active } = req.body;

    try {
        const pool = await poolPromise;

        // Check if the status exists
        const existingStatus = await pool.request()
            .input("status_id", status_id)
            .query("SELECT * FROM FileStatus WHERE file_status_id = @status_id");

        if (existingStatus.recordset.length === 0) {
            return res.status(404).json({ message: "Status not found." });
        }

        await pool.request()
            .input("status_id", status_id)
            .input("status_name", status_name)
            .input("is_active", is_active || 1) // Default to active if not provided
            .query("UPDATE FileStatus SET status_name = @status_name, is_active = @is_active WHERE file_status_id = @status_id");

        res.json({ message: "File status updated successfully!" });
    }
    catch (err) {
        console.error("Update File Status Error:", err);
        res.status(500).json({ message: "Server Error" });
    }

}



export const deleteFileStatus = async (req, res) => {
    const { status_id } = req.params;

    try {
        const pool = await poolPromise;
        // Check if the status exists
        const existingStatus = await pool.request()
            .input("status_id", status_id)
            .query("SELECT * FROM FileStatus WHERE file_status_id = @status_id");

        if (existingStatus.recordset.length === 0) {
            return res.status(404).json({ message: "Status not found." });
        }

        await pool.request()
            .input("status_id", status_id)
            .query("DELETE FROM FileStatus WHERE file_status_id = @status_id");

        res.json({ message: "File status deleted successfully!" });
    }
    catch (err) {
        console.error("Delete File Status Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
}



