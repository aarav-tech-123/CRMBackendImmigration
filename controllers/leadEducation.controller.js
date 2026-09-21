import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";

/**
 * Create Lead Education
 */
export const createLeadEducation = async (req, res, next) => {
    try {
        const {
            lead_id,
            highest_level,
            qualification_name,
            area_of_study,
            university_college,
            country,
            start_year,
            completion_year,
            study_in_canada
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
                    "highest_level",
                    sql.NVarChar(100),
                    highest_level || null
                )
                .input(
                    "qualification_name",
                    sql.NVarChar(255),
                    qualification_name || null
                )
                .input(
                    "area_of_study",
                    sql.NVarChar(255),
                    area_of_study || null
                )
                .input(
                    "university_college",
                    sql.NVarChar(255),
                    university_college || null
                )
                .input(
                    "country",
                    sql.NVarChar(100),
                    country || null
                )
                .input(
                    "start_year",
                    sql.Int,
                    start_year || null
                )
                .input(
                    "completion_year",
                    sql.Int,
                    completion_year || null
                )
                .input(
                    "study_in_canada",
                    sql.Bit,
                    study_in_canada ? 1 : 0
                )
                .query(`
                    INSERT INTO LeadEducation (
                        lead_id,
                        highest_level,
                        qualification_name,
                        area_of_study,
                        university_college,
                        country,
                        start_year,
                        completion_year,
                        study_in_canada,
                        created_at,
                        updated_at
                    )
                    OUTPUT INSERTED.*
                    VALUES (
                        @lead_id,
                        @highest_level,
                        @qualification_name,
                        @area_of_study,
                        @university_college,
                        @country,
                        @start_year,
                        @completion_year,
                        @study_in_canada,
                        GETDATE(),
                        GETDATE()
                    )
                `);

            const newEducation = result.recordset[0];

            await createActivityLog({
                transaction,
                leadId: lead_id,
                caseId: null,
                userId,
                activityType: "CREATE",
                entityType: "LEAD_EDUCATION",
                entityId: newEducation.education_id,
                oldValue: null,
                newValue: JSON.stringify(newEducation),
                description: `Lead education created successfully (Education ID: ${newEducation.education_id})`,
                ipAddress:
                    req.ip ||
                    req.headers["x-forwarded-for"] ||
                    null,
                userAgent: req.get("user-agent") || null
            });

            await transaction.commit();

            return res.status(201).json({
                success: true,
                message: "Lead education created successfully",
                data: newEducation
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
 * Get All Lead Education
 */
export const getAllLeadEducation = async (req, res, next) => {
    try {
        const pool = await poolPromise;

        const result = await pool.request().query(`
            SELECT
                education_id,
                lead_id,
                highest_level,
                qualification_name,
                area_of_study,
                university_college,
                country,
                start_year,
                completion_year,
                study_in_canada,
                created_at,
                updated_at
            FROM LeadEducation
            ORDER BY education_id DESC
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
 * Get Lead Education By ID
 */
export const getLeadEducationById = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid education_id is required"
            });
        }

        const pool = await poolPromise;

        const result = await pool
            .request()
            .input("education_id", sql.Int, Number(id))
            .query(`
                SELECT
                    education_id,
                    lead_id,
                    highest_level,
                    qualification_name,
                    area_of_study,
                    university_college,
                    country,
                    start_year,
                    completion_year,
                    study_in_canada,
                    created_at,
                    updated_at
                FROM LeadEducation
                WHERE education_id = @education_id
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Lead education not found"
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
 * Get All Education For Lead
 */
export const getLeadEducationByLeadId = async (req, res, next) => {
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
            .input("lead_id", sql.Int, Number(lead_id))
            .query(`
                SELECT
                    education_id,
                    lead_id,
                    highest_level,
                    qualification_name,
                    area_of_study,
                    university_college,
                    country,
                    start_year,
                    completion_year,
                    study_in_canada,
                    created_at,
                    updated_at
                FROM LeadEducation
                WHERE lead_id = @lead_id
                ORDER BY
                    completion_year DESC,
                    education_id DESC
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
 * Update Lead Education
 */
export const updateLeadEducation = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid education_id is required"
            });
        }

        const {
            lead_id,
            highest_level,
            qualification_name,
            area_of_study,
            university_college,
            country,
            start_year,
            completion_year,
            study_in_canada
        } = req.body;

        const userId = req.user?.user_id || req.user?.id || null;

        const pool = await poolPromise;

        // Get existing education
        const existingResult = await pool
            .request()
            .input("education_id", sql.Int, Number(id))
            .query(`
                SELECT *
                FROM LeadEducation
                WHERE education_id = @education_id
            `);

        if (existingResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Lead education not found"
            });
        }

        const oldEducation = existingResult.recordset[0];

        const finalLeadId = lead_id ?? oldEducation.lead_id;

        // Check Lead exists
        const leadCheck = await pool
            .request()
            .input("lead_id", sql.Int, finalLeadId)
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

        const finalStudyInCanada =
            study_in_canada !== undefined
                ? Boolean(study_in_canada)
                : Boolean(oldEducation.study_in_canada);

        const transaction = new sql.Transaction(pool);

        try {
            await transaction.begin();

            const result = await new sql.Request(transaction)
                .input("education_id", sql.Int, Number(id))
                .input("lead_id", sql.Int, finalLeadId)
                .input(
                    "highest_level",
                    sql.NVarChar(100),
                    highest_level ?? oldEducation.highest_level
                )
                .input(
                    "qualification_name",
                    sql.NVarChar(255),
                    qualification_name ??
                        oldEducation.qualification_name
                )
                .input(
                    "area_of_study",
                    sql.NVarChar(255),
                    area_of_study ?? oldEducation.area_of_study
                )
                .input(
                    "university_college",
                    sql.NVarChar(255),
                    university_college ??
                        oldEducation.university_college
                )
                .input(
                    "country",
                    sql.NVarChar(100),
                    country ?? oldEducation.country
                )
                .input(
                    "start_year",
                    sql.Int,
                    start_year ?? oldEducation.start_year
                )
                .input(
                    "completion_year",
                    sql.Int,
                    completion_year ?? oldEducation.completion_year
                )
                .input(
                    "study_in_canada",
                    sql.Bit,
                    finalStudyInCanada ? 1 : 0
                )
                .query(`
                    UPDATE LeadEducation
                    SET
                        lead_id = @lead_id,
                        highest_level = @highest_level,
                        qualification_name = @qualification_name,
                        area_of_study = @area_of_study,
                        university_college = @university_college,
                        country = @country,
                        start_year = @start_year,
                        completion_year = @completion_year,
                        study_in_canada = @study_in_canada,
                        updated_at = GETDATE()
                    OUTPUT INSERTED.*
                    WHERE education_id = @education_id
                `);

            const updatedEducation = result.recordset[0];

            await createActivityLog({
                transaction,
                leadId: finalLeadId,
                caseId: null,
                userId,
                activityType: "UPDATE",
                entityType: "LEAD_EDUCATION",
                entityId: Number(id),
                oldValue: JSON.stringify(oldEducation),
                newValue: JSON.stringify(updatedEducation),
                description: `Lead education updated successfully (Education ID: ${id})`,
                ipAddress:
                    req.ip ||
                    req.headers["x-forwarded-for"] ||
                    null,
                userAgent: req.get("user-agent") || null
            });

            await transaction.commit();

            return res.status(200).json({
                success: true,
                message: "Lead education updated successfully",
                data: updatedEducation
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
 * Delete Lead Education
 */
export const deleteLeadEducation = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid education_id is required"
            });
        }

        const userId = req.user?.user_id || req.user?.id || null;

        const pool = await poolPromise;

        // Get education before deleting
        const existingResult = await pool
            .request()
            .input("education_id", sql.Int, Number(id))
            .query(`
                SELECT *
                FROM LeadEducation
                WHERE education_id = @education_id
            `);

        if (existingResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Lead education not found"
            });
        }

        const oldEducation = existingResult.recordset[0];

        const transaction = new sql.Transaction(pool);

        try {
            await transaction.begin();

            const result = await new sql.Request(transaction)
                .input("education_id", sql.Int, Number(id))
                .query(`
                    DELETE FROM LeadEducation
                    OUTPUT DELETED.*
                    WHERE education_id = @education_id
                `);

            if (result.recordset.length === 0) {
                throw new Error(
                    "Lead education could not be deleted"
                );
            }

            await createActivityLog({
                transaction,
                leadId: oldEducation.lead_id,
                caseId: null,
                userId,
                activityType: "DELETE",
                entityType: "LEAD_EDUCATION",
                entityId: Number(id),
                oldValue: JSON.stringify(oldEducation),
                newValue: null,
                description: `Lead education deleted successfully (Education ID: ${id})`,
                ipAddress:
                    req.ip ||
                    req.headers["x-forwarded-for"] ||
                    null,
                userAgent: req.get("user-agent") || null
            });

            await transaction.commit();

            return res.status(200).json({
                success: true,
                message: "Lead education deleted successfully",
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