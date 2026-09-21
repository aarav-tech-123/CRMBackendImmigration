import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from "../helpers/activityLogs.js";

/**
 * Create Lead Address
 */
export const createLeadAddress = async (req, res, next) => {
    try {
        const {
            lead_id,
            address_type,
            flat_house_number,
            street_name,
            city,
            state_province,
            postal_code,
            country,
            is_primary
        } = req.body;

        const userId = req.user?.id || req.user?.id || null;

        if (!lead_id) {
            return res.status(400).json({
                success: false,
                message: "lead_id is required"
            });
        }

        if (!address_type) {
            return res.status(400).json({
                success: false,
                message: "address_type is required"
            });
        }

        const pool = await poolPromise;

        // Check lead exists
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

            /*
             * If new address is primary,
             * remove primary flag from existing addresses.
             */
            if (is_primary === true || is_primary === 1) {
                await new sql.Request(transaction)
                    .input("lead_id", sql.Int, lead_id)
                    .query(`
                        UPDATE LeadAddresses
                        SET
                            is_primary = 0,
                            updated_at = GETDATE()
                        WHERE lead_id = @lead_id
                    `);
            }

            // Insert address
            const result = await new sql.Request(transaction)
                .input("lead_id", sql.Int, lead_id)
                .input("address_type", sql.VarChar(50), address_type)
                .input(
                    "flat_house_number",
                    sql.VarChar(255),
                    flat_house_number || null
                )
                .input(
                    "street_name",
                    sql.VarChar(255),
                    street_name || null
                )
                .input(
                    "city",
                    sql.VarChar(100),
                    city || null
                )
                .input(
                    "state_province",
                    sql.VarChar(100),
                    state_province || null
                )
                .input(
                    "postal_code",
                    sql.VarChar(30),
                    postal_code || null
                )
                .input(
                    "country",
                    sql.VarChar(100),
                    country || null
                )
                .input(
                    "is_primary",
                    sql.Bit,
                    is_primary ? 1 : 0
                )
                .query(`
                    INSERT INTO LeadAddresses (
                        lead_id,
                        address_type,
                        flat_house_number,
                        street_name,
                        city,
                        state_province,
                        postal_code,
                        country,
                        is_primary,
                        created_at,
                        updated_at
                    )
                    OUTPUT INSERTED.*
                    VALUES (
                        @lead_id,
                        @address_type,
                        @flat_house_number,
                        @street_name,
                        @city,
                        @state_province,
                        @postal_code,
                        @country,
                        @is_primary,
                        GETDATE(),
                        GETDATE()
                    )
                `);

            const newAddress = result.recordset[0];

            /*
             * Activity Log
             */
            await createActivityLog({
                transaction,
                leadId: lead_id,
                caseId: null,
                userId,
                activityType: "CREATE",
                entityType: "LEAD_ADDRESS",
                entityId: newAddress.address_id,
                oldValue: null,
                newValue: JSON.stringify(newAddress),
                description: `Lead address created successfully (Address ID: ${newAddress.address_id})`,
                ipAddress:
                    req.ip ||
                    req.headers["x-forwarded-for"] ||
                    null,
                userAgent: req.get("user-agent") || null
            });

            await transaction.commit();

            return res.status(201).json({
                success: true,
                message: "Lead address created successfully",
                data: newAddress
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
 * Get All Lead Addresses
 */
export const getAllLeadAddresses = async (req, res, next) => {
    try {
        const pool = await poolPromise;

        const result = await pool.request().query(`
            SELECT 
                L.* , 
                LA.address_id,
                LA.lead_id,
                LA.address_type,
                LA.flat_house_number,
                LA.street_name,
                LA.city,
                LA.state_province,
                LA.postal_code,
                LA.country,
                LA.is_primary,
                LA.created_at,
                LA.updated_at
            FROM LeadAddresses LA
            JOIN Leads L ON LA.lead_id = L.lead_id
            ORDER BY address_id DESC
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
 * Get Lead Address By ID
 */
export const getLeadAddressById = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid address_id is required"
            });
        }

        const pool = await poolPromise;

        const result = await pool
            .request()
            .input("address_id", sql.Int, Number(id))
            .query(`
                SELECT
                    L.* ,
                    LA.address_id,
                    LA.lead_id,
                    LA.address_type,
                    LA.flat_house_number,
                    LA.street_name,
                    LA.city,
                    LA.state_province,
                    LA.postal_code,
                    LA.country,
                    LA.is_primary,
                    LA.created_at,
                    LA.updated_at
                FROM LeadAddresses LA
                JOIN Leads L ON LA.lead_id = L.lead_id
                WHERE address_id = @address_id
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Lead address not found"
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
 * Get All Addresses For A Lead
 */
export const getLeadAddressesByLeadId = async (req, res, next) => {
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
                    L.* ,
                    LA.address_id,
                    LA.lead_id,
                    LA.address_type,
                    LA.flat_house_number,
                    LA.street_name,
                    LA.city,
                    LA.state_province,
                    LA.postal_code,
                    LA.country,
                    LA.is_primary,
                    LA.created_at,
                    LA.updated_at
                FROM LeadAddresses LA
                JOIN Leads L ON LA.lead_id = L.lead_id
                WHERE lead_id = @lead_id
                ORDER BY
                    is_primary DESC,
                    address_id DESC
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
 * Update Lead Address
 */
export const updateLeadAddress = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid address_id is required"
            });
        }

        const {
            lead_id,
            address_type,
            flat_house_number,
            street_name,
            city,
            state_province,
            postal_code,
            country,
            is_primary
        } = req.body;

        const userId = req.user?.user_id || req.user?.id || null;

        const pool = await poolPromise;

        /*
         * Get existing address
         */
        const addressCheck = await pool
            .request()
            .input("address_id", sql.Int, Number(id))
            .query(`
                SELECT *
                FROM LeadAddresses
                WHERE address_id = @address_id
            `);

        if (addressCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Lead address not found"
            });
        }

        const oldAddress = addressCheck.recordset[0];

        const finalLeadId = lead_id ?? oldAddress.lead_id;

        /*
         * Check lead exists
         */
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

        const finalIsPrimary =
            is_primary !== undefined
                ? Boolean(is_primary)
                : Boolean(oldAddress.is_primary);

        const transaction = new sql.Transaction(pool);

        try {
            await transaction.begin();

            /*
             * If address becomes primary,
             * remove primary flag from other addresses.
             */
            if (finalIsPrimary) {
                await new sql.Request(transaction)
                    .input("lead_id", sql.Int, finalLeadId)
                    .input("address_id", sql.Int, Number(id))
                    .query(`
                        UPDATE LeadAddresses
                        SET
                            is_primary = 0,
                            updated_at = GETDATE()
                        WHERE
                            lead_id = @lead_id
                            AND address_id <> @address_id
                    `);
            }

            /*
             * Update address
             */
            const result = await new sql.Request(transaction)
                .input("address_id", sql.Int, Number(id))
                .input("lead_id", sql.Int, finalLeadId)
                .input(
                    "address_type",
                    sql.VarChar(50),
                    address_type ?? oldAddress.address_type
                )
                .input(
                    "flat_house_number",
                    sql.VarChar(255),
                    flat_house_number ?? oldAddress.flat_house_number
                )
                .input(
                    "street_name",
                    sql.VarChar(255),
                    street_name ?? oldAddress.street_name
                )
                .input(
                    "city",
                    sql.VarChar(100),
                    city ?? oldAddress.city
                )
                .input(
                    "state_province",
                    sql.VarChar(100),
                    state_province ?? oldAddress.state_province
                )
                .input(
                    "postal_code",
                    sql.VarChar(30),
                    postal_code ?? oldAddress.postal_code
                )
                .input(
                    "country",
                    sql.VarChar(100),
                    country ?? oldAddress.country
                )
                .input(
                    "is_primary",
                    sql.Bit,
                    finalIsPrimary ? 1 : 0
                )
                .query(`
                    UPDATE LeadAddresses
                    SET
                        lead_id = @lead_id,
                        address_type = @address_type,
                        flat_house_number = @flat_house_number,
                        street_name = @street_name,
                        city = @city,
                        state_province = @state_province,
                        postal_code = @postal_code,
                        country = @country,
                        is_primary = @is_primary,
                        updated_at = GETDATE()
                    OUTPUT INSERTED.*
                    WHERE address_id = @address_id
                `);

            const updatedAddress = result.recordset[0];

            /*
             * Activity Log
             */
            await createActivityLog({
                transaction,
                leadId: finalLeadId,
                caseId: null,
                userId,
                activityType: "UPDATE",
                entityType: "LEAD_ADDRESS",
                entityId: Number(id),
                oldValue: JSON.stringify(oldAddress),
                newValue: JSON.stringify(updatedAddress),
                description: `Lead address updated successfully (Address ID: ${id})`,
                ipAddress:
                    req.ip ||
                    req.headers["x-forwarded-for"] ||
                    null,
                userAgent: req.get("user-agent") || null
            });

            await transaction.commit();

            return res.status(200).json({
                success: true,
                message: "Lead address updated successfully",
                data: updatedAddress
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
 * Delete Lead Address
 */
export const deleteLeadAddress = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid address_id is required"
            });
        }

        const userId = req.user?.user_id || req.user?.id || null;

        const pool = await poolPromise;

        /*
         * Get address before deleting
         */
        const addressCheck = await pool
            .request()
            .input("address_id", sql.Int, Number(id))
            .query(`
                SELECT *
                FROM LeadAddresses
                WHERE address_id = @address_id
            `);

        if (addressCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Lead address not found"
            });
        }

        const oldAddress = addressCheck.recordset[0];

        const transaction = new sql.Transaction(pool);

        try {
            await transaction.begin();

            /*
             * Delete address
             */
            const result = await new sql.Request(transaction)
                .input("address_id", sql.Int, Number(id))
                .query(`
                    DELETE FROM LeadAddresses
                    OUTPUT DELETED.*
                    WHERE address_id = @address_id
                `);

            if (result.recordset.length === 0) {
                throw new Error("Lead address could not be deleted");
            }

            /*
             * Activity Log
             */
            await createActivityLog({
                transaction,
                leadId: oldAddress.lead_id,
                caseId: null,
                userId,
                activityType: "DELETE",
                entityType: "LEAD_ADDRESS",
                entityId: Number(id),
                oldValue: JSON.stringify(oldAddress),
                newValue: null,
                description: `Lead address deleted successfully (Address ID: ${id})`,
                ipAddress:
                    req.ip ||
                    req.headers["x-forwarded-for"] ||
                    null,
                userAgent: req.get("user-agent") || null
            });

            await transaction.commit();

            return res.status(200).json({
                success: true,
                message: "Lead address deleted successfully",
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