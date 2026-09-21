import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";

/**
 * Create Canadian Relation
 */
export const createLeadCanadianRelation = async (req, res, next) => {
    try {
        const {
            lead_id,
            close_relative,
            relation,
            status_in_canada,
            province,
            city
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
                    "close_relative",
                    sql.NVarChar(255),
                    close_relative || null
                )
                .input(
                    "relation",
                    sql.NVarChar(100),
                    relation || null
                )
                .input(
                    "status_in_canada",
                    sql.NVarChar(100),
                    status_in_canada || null
                )
                .input(
                    "province",
                    sql.NVarChar(100),
                    province || null
                )
                .input(
                    "city",
                    sql.NVarChar(100),
                    city || null
                )
                .query(`
                    INSERT INTO LeadCanadianRelations (
                        lead_id,
                        close_relative,
                        relation,
                        status_in_canada,
                        province,
                        city,
                        created_at,
                        updated_at
                    )
                    OUTPUT INSERTED.*
                    VALUES (
                        @lead_id,
                        @close_relative,
                        @relation,
                        @status_in_canada,
                        @province,
                        @city,
                        GETDATE(),
                        GETDATE()
                    )
                `);

            const newRelation = result.recordset[0];

            // Activity Log
            await createActivityLog({
                transaction,
                leadId: lead_id,
                caseId: null,
                userId,
                activityType: "CREATE",
                entityType: "LEAD_CANADIAN_RELATION",
                entityId: newRelation.relation_id,
                oldValue: null,
                newValue: JSON.stringify(newRelation),
                description: `Canadian relation created successfully (Relation ID: ${newRelation.relation_id})`,
                ipAddress:
                    req.ip ||
                    req.headers["x-forwarded-for"] ||
                    null,
                userAgent: req.get("user-agent") || null
            });

            await transaction.commit();

            return res.status(201).json({
                success: true,
                message: "Canadian relation created successfully",
                data: newRelation
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
 * Get All Canadian Relations
 */
export const getAllLeadCanadianRelations = async (req, res, next) => {
    try {
        const pool = await poolPromise;

        const result = await pool.request().query(`
            SELECT 
                L.* ,
                LCR.relation_id,
                LCR.lead_id,
                LCR.close_relative,
                LCR.relation,
                LCR.status_in_canada,
                LCR.province,
                LCR.city,
                LCR.created_at,
                LCR.updated_at
            FROM LeadCanadianRelations LCR
            LEFT JOIN Leads L ON L.lead_id = LCR.lead_id
            ORDER BY relation_id DESC
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
 * Get Canadian Relation By ID
 */
export const getLeadCanadianRelationById = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid relation_id is required"
            });
        }

        const pool = await poolPromise;

        const result = await pool
            .request()
            .input("relation_id", sql.Int, Number(id))
            .query(`
                SELECT
                    relation_id,
                    lead_id,
                    close_relative,
                    relation,
                    status_in_canada,
                    province,
                    city,
                    created_at,
                    updated_at
                FROM LeadCanadianRelations
                WHERE relation_id = @relation_id
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Canadian relation not found"
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
 * Get All Canadian Relations For Lead
 */
export const getLeadCanadianRelationsByLeadId = async (req, res, next) => {
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
                    relation_id,
                    lead_id,
                    close_relative,
                    relation,
                    status_in_canada,
                    province,
                    city,
                    created_at,
                    updated_at
                FROM LeadCanadianRelations
                WHERE lead_id = @lead_id
                ORDER BY relation_id DESC
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
 * Update Canadian Relation
 */
export const updateLeadCanadianRelation = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid relation_id is required"
            });
        }

        const {
            lead_id,
            close_relative,
            relation,
            status_in_canada,
            province,
            city
        } = req.body;

        const userId = req.user?.user_id || req.user?.id || null;

        const pool = await poolPromise;

        // Get existing relation
        const existingResult = await pool
            .request()
            .input("relation_id", sql.Int, Number(id))
            .query(`
                SELECT *
                FROM LeadCanadianRelations
                WHERE relation_id = @relation_id
            `);

        if (existingResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Canadian relation not found"
            });
        }

        const oldRelation = existingResult.recordset[0];

        const finalLeadId = lead_id ?? oldRelation.lead_id;

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

        const transaction = new sql.Transaction(pool);

        try {
            await transaction.begin();

            const result = await new sql.Request(transaction)
                .input("relation_id", sql.Int, Number(id))
                .input("lead_id", sql.Int, finalLeadId)
                .input(
                    "close_relative",
                    sql.NVarChar(255),
                    close_relative ?? oldRelation.close_relative
                )
                .input(
                    "relation",
                    sql.NVarChar(100),
                    relation ?? oldRelation.relation
                )
                .input(
                    "status_in_canada",
                    sql.NVarChar(100),
                    status_in_canada ?? oldRelation.status_in_canada
                )
                .input(
                    "province",
                    sql.NVarChar(100),
                    province ?? oldRelation.province
                )
                .input(
                    "city",
                    sql.NVarChar(100),
                    city ?? oldRelation.city
                )
                .query(`
                    UPDATE LeadCanadianRelations
                    SET
                        lead_id = @lead_id,
                        close_relative = @close_relative,
                        relation = @relation,
                        status_in_canada = @status_in_canada,
                        province = @province,
                        city = @city,
                        updated_at = GETDATE()
                    OUTPUT INSERTED.*
                    WHERE relation_id = @relation_id
                `);

            const updatedRelation = result.recordset[0];

            // Activity Log
            await createActivityLog({
                transaction,
                leadId: finalLeadId,
                caseId: null,
                userId,
                activityType: "UPDATE",
                entityType: "LEAD_CANADIAN_RELATION",
                entityId: Number(id),
                oldValue: JSON.stringify(oldRelation),
                newValue: JSON.stringify(updatedRelation),
                description: `Canadian relation updated successfully (Relation ID: ${id})`,
                ipAddress:
                    req.ip ||
                    req.headers["x-forwarded-for"] ||
                    null,
                userAgent: req.get("user-agent") || null
            });

            await transaction.commit();

            return res.status(200).json({
                success: true,
                message: "Canadian relation updated successfully",
                data: updatedRelation
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
 * Delete Canadian Relation
 */
export const deleteLeadCanadianRelation = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid relation_id is required"
            });
        }

        const userId = req.user?.user_id || req.user?.id || null;

        const pool = await poolPromise;

        // Get relation before deleting
        const existingResult = await pool
            .request()
            .input("relation_id", sql.Int, Number(id))
            .query(`
                SELECT *
                FROM LeadCanadianRelations
                WHERE relation_id = @relation_id
            `);

        if (existingResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Canadian relation not found"
            });
        }

        const oldRelation = existingResult.recordset[0];

        const transaction = new sql.Transaction(pool);

        try {
            await transaction.begin();

            const result = await new sql.Request(transaction)
                .input("relation_id", sql.Int, Number(id))
                .query(`
                    DELETE FROM LeadCanadianRelations
                    OUTPUT DELETED.*
                    WHERE relation_id = @relation_id
                `);

            if (result.recordset.length === 0) {
                throw new Error(
                    "Canadian relation could not be deleted"
                );
            }

            // Activity Log
            await createActivityLog({
                transaction,
                leadId: oldRelation.lead_id,
                caseId: null,
                userId,
                activityType: "DELETE",
                entityType: "LEAD_CANADIAN_RELATION",
                entityId: Number(id),
                oldValue: JSON.stringify(oldRelation),
                newValue: null,
                description: `Canadian relation deleted successfully (Relation ID: ${id})`,
                ipAddress:
                    req.ip ||
                    req.headers["x-forwarded-for"] ||
                    null,
                userAgent: req.get("user-agent") || null
            });

            await transaction.commit();

            return res.status(200).json({
                success: true,
                message: "Canadian relation deleted successfully",
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

