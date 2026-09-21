import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";

/**
 * Create Lead Work Experience
 */
export const createLeadWorkExperience = async (req, res, next) => {
    const transaction = new sql.Transaction(await poolPromise);

    try {
        const data = req.body;

        const userId = req.user?.user_id || req.user?.id || null;
        const ipAddress =
            req.ip ||
            req.headers["x-forwarded-for"] ||
            null;
        const userAgent = req.get("user-agent") || null;

        if (!data.lead_id) {
            return res.status(400).json({
                success: false,
                message: "lead_id is required"
            });
        }

        const pool = await poolPromise;

        // Verify lead exists
        const leadCheck = await pool
            .request()
            .input("lead_id", sql.Int, data.lead_id)
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

        await transaction.begin();

        const request = new sql.Request(transaction);

        request.input("lead_id", sql.Int, data.lead_id);
        request.input("company_name", sql.NVarChar(255), data.company_name || null);
        request.input(
            "current_designation",
            sql.NVarChar(255),
            data.current_designation || null
        );
        request.input(
            "industry_area",
            sql.NVarChar(255),
            data.industry_area || null
        );
        request.input(
            "country_of_work",
            sql.NVarChar(100),
            data.country_of_work || null
        );
        request.input("start_date", sql.Date, data.start_date || null);
        request.input("end_date", sql.Date, data.end_date || null);
        request.input(
            "is_current_job",
            sql.Bit,
            data.is_current_job ?? false
        );
        request.input(
            "years_of_experience",
            sql.Decimal(10, 2),
            data.years_of_experience ?? null
        );
        request.input(
            "job_description",
            sql.NVarChar(sql.MAX),
            data.job_description || null
        );
        request.input(
            "noc_code",
            sql.NVarChar(50),
            data.noc_code || null
        );
        request.input(
            "noc_title",
            sql.NVarChar(255),
            data.noc_title || null
        );
        request.input(
            "teer_category",
            sql.NVarChar(50),
            data.teer_category || null
        );
        request.input(
            "noc_description",
            sql.NVarChar(sql.MAX),
            data.noc_description || null
        );
        request.input(
            "arranged_employment",
            sql.Bit,
            data.arranged_employment ?? false
        );
        request.input(
            "job_offer_canada",
            sql.Bit,
            data.job_offer_canada ?? false
        );
        request.input(
            "past_experience_canada",
            sql.Bit,
            data.past_experience_canada ?? false
        );

        const result = await request.query(`
            INSERT INTO LeadWorkExperience (
                lead_id,
                company_name,
                current_designation,
                industry_area,
                country_of_work,
                start_date,
                end_date,
                is_current_job,
                years_of_experience,
                job_description,
                noc_code,
                noc_title,
                teer_category,
                noc_description,
                arranged_employment,
                job_offer_canada,
                past_experience_canada,
                created_at,
                updated_at
            )
            OUTPUT INSERTED.*
            VALUES (
                @lead_id,
                @company_name,
                @current_designation,
                @industry_area,
                @country_of_work,
                @start_date,
                @end_date,
                @is_current_job,
                @years_of_experience,
                @job_description,
                @noc_code,
                @noc_title,
                @teer_category,
                @noc_description,
                @arranged_employment,
                @job_offer_canada,
                @past_experience_canada,
                GETDATE(),
                GETDATE()
            )
        `);

        const createdExperience = result.recordset[0];

        await createActivityLog({
            transaction,
            leadId: data.lead_id,
            caseId: null,
            userId,
            activityType: "CREATE",
            entityType: "LEAD_WORK_EXPERIENCE",
            entityId: createdExperience.work_experience_id,
            oldValue: null,
            newValue: JSON.stringify(createdExperience),
            description: `Lead work experience created successfully (Work Experience ID: ${createdExperience.work_experience_id})`,
            ipAddress,
            userAgent
        });

        await transaction.commit();

        return res.status(201).json({
            success: true,
            message: "Lead work experience created successfully",
            data: createdExperience
        });

    } catch (error) {
        if (transaction._aborted !== true) {
            try {
                await transaction.rollback();
            } catch (rollbackError) {
                console.error("Rollback error:", rollbackError);
            }
        }

        console.error(
            "createLeadWorkExperience Error:",
            error
        );

        next(error);
    }
};


/**
 * Get All Lead Work Experiences
 */
export const getAllLeadWorkExperience = async (req, res, next) => {
    try {
        const pool = await poolPromise;

        const result = await pool.request().query(`
            SELECT *
            FROM LeadWorkExperience
            ORDER BY work_experience_id DESC
        `);

        return res.status(200).json({
            success: true,
            count: result.recordset.length,
            data: result.recordset
        });

    } catch (error) {
        console.error(
            "getAllLeadWorkExperience Error:",
            error
        );

        next(error);
    }
};


/**
 * Get Work Experience By ID
 */
export const getLeadWorkExperienceById = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid work experience ID is required"
            });
        }

        const pool = await poolPromise;

        const result = await pool
            .request()
            .input(
                "work_experience_id",
                sql.Int,
                Number(id)
            )
            .query(`
                SELECT *
                FROM LeadWorkExperience
                WHERE work_experience_id = @work_experience_id
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Work experience not found"
            });
        }

        return res.status(200).json({
            success: true,
            data: result.recordset[0]
        });

    } catch (error) {
        console.error(
            "getLeadWorkExperienceById Error:",
            error
        );

        next(error);
    }
};


/**
 * Get Work Experiences By Lead ID
 */
export const getLeadWorkExperiencesByLeadId = async (req, res, next) => {
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
                SELECT *
                FROM LeadWorkExperience
                WHERE lead_id = @lead_id
                ORDER BY start_date DESC, work_experience_id DESC
            `);

        return res.status(200).json({
            success: true,
            count: result.recordset.length,
            data: result.recordset
        });

    } catch (error) {
        console.error(
            "getLeadWorkExperiencesByLeadId Error:",
            error
        );

        next(error);
    }
};


/**
 * Update Lead Work Experience
 */
export const updateLeadWorkExperience = async (req, res, next) => {
    const transaction = new sql.Transaction(await poolPromise);

    try {
        const { id } = req.params;
        const data = req.body;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid work experience ID is required"
            });
        }

        const pool = await poolPromise;

        // Get existing record
        const existingResult = await pool
            .request()
            .input(
                "work_experience_id",
                sql.Int,
                Number(id)
            )
            .query(`
                SELECT *
                FROM LeadWorkExperience
                WHERE work_experience_id = @work_experience_id
            `);

        if (existingResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Work experience not found"
            });
        }

        const existingExperience = existingResult.recordset[0];

        const leadId = data.lead_id ?? existingExperience.lead_id;

        if (!leadId) {
            return res.status(400).json({
                success: false,
                message: "lead_id is required"
            });
        }

        // Verify lead exists
        const leadCheck = await pool
            .request()
            .input("lead_id", sql.Int, leadId)
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

        const userId = req.user?.user_id || req.user?.id || null;
        const ipAddress =
            req.ip ||
            req.headers["x-forwarded-for"] ||
            null;
        const userAgent = req.get("user-agent") || null;

        await transaction.begin();

        const request = new sql.Request(transaction);

        request.input(
            "work_experience_id",
            sql.Int,
            Number(id)
        );
        request.input("lead_id", sql.Int, leadId);
        request.input(
            "company_name",
            sql.NVarChar(255),
            data.company_name ?? existingExperience.company_name
        );
        request.input(
            "current_designation",
            sql.NVarChar(255),
            data.current_designation ??
                existingExperience.current_designation
        );
        request.input(
            "industry_area",
            sql.NVarChar(255),
            data.industry_area ??
                existingExperience.industry_area
        );
        request.input(
            "country_of_work",
            sql.NVarChar(100),
            data.country_of_work ??
                existingExperience.country_of_work
        );
        request.input(
            "start_date",
            sql.Date,
            data.start_date ??
                existingExperience.start_date
        );
        request.input(
            "end_date",
            sql.Date,
            data.end_date ??
                existingExperience.end_date
        );
        request.input(
            "is_current_job",
            sql.Bit,
            data.is_current_job ??
                existingExperience.is_current_job
        );
        request.input(
            "years_of_experience",
            sql.Decimal(10, 2),
            data.years_of_experience ??
                existingExperience.years_of_experience
        );
        request.input(
            "job_description",
            sql.NVarChar(sql.MAX),
            data.job_description ??
                existingExperience.job_description
        );
        request.input(
            "noc_code",
            sql.NVarChar(50),
            data.noc_code ??
                existingExperience.noc_code
        );
        request.input(
            "noc_title",
            sql.NVarChar(255),
            data.noc_title ??
                existingExperience.noc_title
        );
        request.input(
            "teer_category",
            sql.NVarChar(50),
            data.teer_category ??
                existingExperience.teer_category
        );
        request.input(
            "noc_description",
            sql.NVarChar(sql.MAX),
            data.noc_description ??
                existingExperience.noc_description
        );
        request.input(
            "arranged_employment",
            sql.Bit,
            data.arranged_employment ??
                existingExperience.arranged_employment
        );
        request.input(
            "job_offer_canada",
            sql.Bit,
            data.job_offer_canada ??
                existingExperience.job_offer_canada
        );
        request.input(
            "past_experience_canada",
            sql.Bit,
            data.past_experience_canada ??
                existingExperience.past_experience_canada
        );

        const result = await request.query(`
            UPDATE LeadWorkExperience
            SET
                lead_id = @lead_id,
                company_name = @company_name,
                current_designation = @current_designation,
                industry_area = @industry_area,
                country_of_work = @country_of_work,
                start_date = @start_date,
                end_date = @end_date,
                is_current_job = @is_current_job,
                years_of_experience = @years_of_experience,
                job_description = @job_description,
                noc_code = @noc_code,
                noc_title = @noc_title,
                teer_category = @teer_category,
                noc_description = @noc_description,
                arranged_employment = @arranged_employment,
                job_offer_canada = @job_offer_canada,
                past_experience_canada = @past_experience_canada,
                updated_at = GETDATE()
            OUTPUT INSERTED.*
            WHERE work_experience_id = @work_experience_id
        `);

        const updatedExperience = result.recordset[0];

        await createActivityLog({
            transaction,
            leadId: updatedExperience.lead_id,
            caseId: null,
            userId,
            activityType: "UPDATE",
            entityType: "LEAD_WORK_EXPERIENCE",
            entityId: updatedExperience.work_experience_id,
            oldValue: JSON.stringify(existingExperience),
            newValue: JSON.stringify(updatedExperience),
            description: `Lead work experience updated successfully (Work Experience ID: ${updatedExperience.work_experience_id})`,
            ipAddress,
            userAgent
        });

        await transaction.commit();

        return res.status(200).json({
            success: true,
            message: "Lead work experience updated successfully",
            data: updatedExperience
        });

    } catch (error) {
        if (transaction._aborted !== true) {
            try {
                await transaction.rollback();
            } catch (rollbackError) {
                console.error("Rollback error:", rollbackError);
            }
        }

        console.error(
            "updateLeadWorkExperience Error:",
            error
        );

        next(error);
    }
};


/**
 * Delete Lead Work Experience
 */
export const deleteLeadWorkExperience = async (req, res, next) => {
    const transaction = new sql.Transaction(await poolPromise);

    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid work experience ID is required"
            });
        }

        const pool = await poolPromise;

        // Get existing record before delete
        const existingResult = await pool
            .request()
            .input(
                "work_experience_id",
                sql.Int,
                Number(id)
            )
            .query(`
                SELECT *
                FROM LeadWorkExperience
                WHERE work_experience_id = @work_experience_id
            `);

        if (existingResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Work experience not found"
            });
        }

        const existingExperience = existingResult.recordset[0];

        const userId = req.user?.user_id || req.user?.id || null;
        const ipAddress =
            req.ip ||
            req.headers["x-forwarded-for"] ||
            null;
        const userAgent = req.get("user-agent") || null;

        await transaction.begin();

        const request = new sql.Request(transaction);

        request.input(
            "work_experience_id",
            sql.Int,
            Number(id)
        );

        const result = await request.query(`
            DELETE FROM LeadWorkExperience
            OUTPUT DELETED.*
            WHERE work_experience_id = @work_experience_id
        `);

        const deletedExperience = result.recordset[0];

        await createActivityLog({
            transaction,
            leadId: deletedExperience.lead_id,
            caseId: null,
            userId,
            activityType: "DELETE",
            entityType: "LEAD_WORK_EXPERIENCE",
            entityId: deletedExperience.work_experience_id,
            oldValue: JSON.stringify(deletedExperience),
            newValue: null,
            description: `Lead work experience deleted successfully (Work Experience ID: ${deletedExperience.work_experience_id})`,
            ipAddress,
            userAgent
        });

        await transaction.commit();

        return res.status(200).json({
            success: true,
            message: "Lead work experience deleted successfully",
            data: deletedExperience
        });

    } catch (error) {
        if (transaction._aborted !== true) {
            try {
                await transaction.rollback();
            } catch (rollbackError) {
                console.error("Rollback error:", rollbackError);
            }
        }

        console.error(
            "deleteLeadWorkExperience Error:",
            error
        );

        next(error);
    }
};