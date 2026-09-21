import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";

/**
 * Create Lead Personal Information
 */
export const createLeadPersonalInformation = async (req, res, next) => {
    try {
        const {
            lead_id,
            date_of_birth,
            marital_status,
            nationality,
            gender,
            passport_number,
            passport_issue_date,
            passport_expiry_date,
            country_of_birth,
            city_of_birth
        } = req.body;

        const userId = req.user?.user_id || req.user?.id || null;

        if (!lead_id) {
            return res.status(400).json({
                success: false,
                message: "lead_id is required"
            });
        }

        const pool = await poolPromise;

        // Check Lead exists
        const leadCheck = await pool
            .request()
            .input("lead_id", sql.Int, lead_id)
            .query(`
                SELECT lead_id
                FROM Leads
                WHERE lead_id = @lead_id
            `);

        if (leadCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Lead not found"
            });
        }

        const transaction = new sql.Transaction(pool);

        try {
            await transaction.begin();

            const result = await new sql.Request(transaction)
                .input("lead_id", sql.Int, lead_id)
                .input(
                    "date_of_birth",
                    sql.Date,
                    date_of_birth || null
                )
                .input(
                    "marital_status",
                    sql.NVarChar(100),
                    marital_status || null
                )
                .input(
                    "nationality",
                    sql.NVarChar(100),
                    nationality || null
                )
                .input(
                    "gender",
                    sql.NVarChar(50),
                    gender || null
                )
                .input(
                    "passport_number",
                    sql.NVarChar(100),
                    passport_number || null
                )
                .input(
                    "passport_issue_date",
                    sql.Date,
                    passport_issue_date || null
                )
                .input(
                    "passport_expiry_date",
                    sql.Date,
                    passport_expiry_date || null
                )
                .input(
                    "country_of_birth",
                    sql.NVarChar(100),
                    country_of_birth || null
                )
                .input(
                    "city_of_birth",
                    sql.NVarChar(100),
                    city_of_birth || null
                )
                .query(`
                    INSERT INTO LeadPersonalInformation (
                        lead_id,
                        date_of_birth,
                        marital_status,
                        nationality,
                        gender,
                        passport_number,
                        passport_issue_date,
                        passport_expiry_date,
                        country_of_birth,
                        city_of_birth,
                        created_at,
                        updated_at
                    )
                    OUTPUT INSERTED.*
                    VALUES (
                        @lead_id,
                        @date_of_birth,
                        @marital_status,
                        @nationality,
                        @gender,
                        @passport_number,
                        @passport_issue_date,
                        @passport_expiry_date,
                        @country_of_birth,
                        @city_of_birth,
                        GETDATE(),
                        GETDATE()
                    )
                `);

            const newPersonalInfo = result.recordset[0];

            await createActivityLog({
                transaction,
                leadId: lead_id,
                caseId: null,
                userId,
                activityType: "CREATE",
                entityType: "LEAD_PERSONAL_INFORMATION",
                entityId: newPersonalInfo.personal_info_id,
                oldValue: null,
                newValue: JSON.stringify(newPersonalInfo),
                description: `Lead personal information created successfully (Personal Info ID: ${newPersonalInfo.personal_info_id})`,
                ipAddress:
                    req.ip ||
                    req.headers["x-forwarded-for"] ||
                    null,
                userAgent: req.get("user-agent") || null
            });

            await transaction.commit();

            return res.status(201).json({
                success: true,
                message: "Lead personal information created successfully",
                data: newPersonalInfo
            });

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        next(error);
    }
};


/**
 * Get All Lead Personal Information
 */
export const getAllLeadPersonalInformation = async (req, res, next) => {
    try {
        const pool = await poolPromise;

        const result = await pool.request().query(`
            SELECT
                personal_info_id,
                lead_id,
                date_of_birth,
                marital_status,
                nationality,
                gender,
                passport_number,
                passport_issue_date,
                passport_expiry_date,
                country_of_birth,
                city_of_birth,
                created_at,
                updated_at
            FROM LeadPersonalInformation
            ORDER BY personal_info_id DESC
        `);

        return res.status(200).json({
            success: true,
            count: result.recordset.length,
            data: result.recordset
        });

    } catch (error) {
        next(error);
    }
};


/**
 * Get Lead Personal Information By ID
 */
export const getLeadPersonalInformationById = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid personal_info_id is required"
            });
        }

        const pool = await poolPromise;

        const result = await pool
            .request()
            .input(
                "personal_info_id",
                sql.Int,
                Number(id)
            )
            .query(`
                SELECT
                    personal_info_id,
                    lead_id,
                    date_of_birth,
                    marital_status,
                    nationality,
                    gender,
                    passport_number,
                    passport_issue_date,
                    passport_expiry_date,
                    country_of_birth,
                    city_of_birth,
                    created_at,
                    updated_at
                FROM LeadPersonalInformation
                WHERE personal_info_id = @personal_info_id
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Lead personal information not found"
            });
        }

        return res.status(200).json({
            success: true,
            data: result.recordset[0]
        });

    } catch (error) {
        next(error);
    }
};


/**
 * Get Personal Information By Lead ID
 */
export const getLeadPersonalInformationByLeadId = async (
    req,
    res,
    next
) => {
    try {
        const { lead_id } = req.params;

        if (!lead_id || isNaN(lead_id)) {
            return res.status(400).json({
                success: false,
                message: "Valid lead_id is required"
            });
        }

        const pool = await poolPromise;

        const result = await pool
            .request()
            .input(
                "lead_id",
                sql.Int,
                Number(lead_id)
            )
            .query(`
                SELECT
                    personal_info_id,
                    lead_id,
                    date_of_birth,
                    marital_status,
                    nationality,
                    gender,
                    passport_number,
                    passport_issue_date,
                    passport_expiry_date,
                    country_of_birth,
                    city_of_birth,
                    created_at,
                    updated_at
                FROM LeadPersonalInformation
                WHERE lead_id = @lead_id
                ORDER BY personal_info_id DESC
            `);

        return res.status(200).json({
            success: true,
            count: result.recordset.length,
            data: result.recordset
        });

    } catch (error) {
        next(error);
    }
};


/**
 * Update Lead Personal Information
 */
export const updateLeadPersonalInformation = async (
    req,
    res,
    next
) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid personal_info_id is required"
            });
        }

        const {
            lead_id,
            date_of_birth,
            marital_status,
            nationality,
            gender,
            passport_number,
            passport_issue_date,
            passport_expiry_date,
            country_of_birth,
            city_of_birth
        } = req.body;

        const userId = req.user?.user_id || req.user?.id || null;

        const pool = await poolPromise;

        // Get existing personal information
        const existingResult = await pool
            .request()
            .input(
                "personal_info_id",
                sql.Int,
                Number(id)
            )
            .query(`
                SELECT *
                FROM LeadPersonalInformation
                WHERE personal_info_id = @personal_info_id
            `);

        if (existingResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Lead personal information not found"
            });
        }

        const oldPersonalInfo = existingResult.recordset[0];

        const finalLeadId =
            lead_id ?? oldPersonalInfo.lead_id;

        // Check Lead exists
        const leadCheck = await pool
            .request()
            .input(
                "lead_id",
                sql.Int,
                finalLeadId
            )
            .query(`
                SELECT lead_id
                FROM Leads
                WHERE lead_id = @lead_id
            `);

        if (leadCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Lead not found"
            });
        }

        const transaction = new sql.Transaction(pool);

        try {
            await transaction.begin();

            const result = await new sql.Request(transaction)
                .input(
                    "personal_info_id",
                    sql.Int,
                    Number(id)
                )
                .input(
                    "lead_id",
                    sql.Int,
                    finalLeadId
                )
                .input(
                    "date_of_birth",
                    sql.Date,
                    date_of_birth ??
                        oldPersonalInfo.date_of_birth
                )
                .input(
                    "marital_status",
                    sql.NVarChar(100),
                    marital_status ??
                        oldPersonalInfo.marital_status
                )
                .input(
                    "nationality",
                    sql.NVarChar(100),
                    nationality ??
                        oldPersonalInfo.nationality
                )
                .input(
                    "gender",
                    sql.NVarChar(50),
                    gender ?? oldPersonalInfo.gender
                )
                .input(
                    "passport_number",
                    sql.NVarChar(100),
                    passport_number ??
                        oldPersonalInfo.passport_number
                )
                .input(
                    "passport_issue_date",
                    sql.Date,
                    passport_issue_date ??
                        oldPersonalInfo.passport_issue_date
                )
                .input(
                    "passport_expiry_date",
                    sql.Date,
                    passport_expiry_date ??
                        oldPersonalInfo.passport_expiry_date
                )
                .input(
                    "country_of_birth",
                    sql.NVarChar(100),
                    country_of_birth ??
                        oldPersonalInfo.country_of_birth
                )
                .input(
                    "city_of_birth",
                    sql.NVarChar(100),
                    city_of_birth ??
                        oldPersonalInfo.city_of_birth
                )
                .query(`
                    UPDATE LeadPersonalInformation
                    SET
                        lead_id = @lead_id,
                        date_of_birth = @date_of_birth,
                        marital_status = @marital_status,
                        nationality = @nationality,
                        gender = @gender,
                        passport_number = @passport_number,
                        passport_issue_date = @passport_issue_date,
                        passport_expiry_date = @passport_expiry_date,
                        country_of_birth = @country_of_birth,
                        city_of_birth = @city_of_birth,
                        updated_at = GETDATE()
                    OUTPUT INSERTED.*
                    WHERE personal_info_id = @personal_info_id
                `);

            const updatedPersonalInfo =
                result.recordset[0];

            await createActivityLog({
                transaction,
                leadId: finalLeadId,
                caseId: null,
                userId,
                activityType: "UPDATE",
                entityType: "LEAD_PERSONAL_INFORMATION",
                entityId: Number(id),
                oldValue: JSON.stringify(oldPersonalInfo),
                newValue: JSON.stringify(updatedPersonalInfo),
                description: `Lead personal information updated successfully (Personal Info ID: ${id})`,
                ipAddress:
                    req.ip ||
                    req.headers["x-forwarded-for"] ||
                    null,
                userAgent: req.get("user-agent") || null
            });

            await transaction.commit();

            return res.status(200).json({
                success: true,
                message:
                    "Lead personal information updated successfully",
                data: updatedPersonalInfo
            });

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        next(error);
    }
};


/**
 * Delete Lead Personal Information
 */
export const deleteLeadPersonalInformation = async (
    req,
    res,
    next
) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid personal_info_id is required"
            });
        }

        const userId = req.user?.user_id || req.user?.id || null;

        const pool = await poolPromise;

        // Get record before deleting
        const existingResult = await pool
            .request()
            .input(
                "personal_info_id",
                sql.Int,
                Number(id)
            )
            .query(`
                SELECT *
                FROM LeadPersonalInformation
                WHERE personal_info_id = @personal_info_id
            `);

        if (existingResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Lead personal information not found"
            });
        }

        const oldPersonalInfo =
            existingResult.recordset[0];

        const transaction = new sql.Transaction(pool);

        try {
            await transaction.begin();

            const result = await new sql.Request(transaction)
                .input(
                    "personal_info_id",
                    sql.Int,
                    Number(id)
                )
                .query(`
                    DELETE FROM LeadPersonalInformation
                    OUTPUT DELETED.*
                    WHERE personal_info_id = @personal_info_id
                `);

            if (result.recordset.length === 0) {
                throw new Error(
                    "Lead personal information could not be deleted"
                );
            }

            await createActivityLog({
                transaction,
                leadId: oldPersonalInfo.lead_id,
                caseId: null,
                userId,
                activityType: "DELETE",
                entityType: "LEAD_PERSONAL_INFORMATION",
                entityId: Number(id),
                oldValue: JSON.stringify(oldPersonalInfo),
                newValue: null,
                description: `Lead personal information deleted successfully (Personal Info ID: ${id})`,
                ipAddress:
                    req.ip ||
                    req.headers["x-forwarded-for"] ||
                    null,
                userAgent: req.get("user-agent") || null
            });

            await transaction.commit();

            return res.status(200).json({
                success: true,
                message:
                    "Lead personal information deleted successfully",
                data: result.recordset[0]
            });

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        next(error);
    }
};