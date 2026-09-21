import { sql, poolPromise } from "../config/db.js";
import { createActivityLog } from '../helpers/activityLogs.js';
import { getRequestInfo } from '../helpers/requestInfo.js';
import { generateCaseNumber } from './utils/caseNumberGenerator.js'


// ----------------------------------- CONTROLLERS SPECIFIC TO THE SUPER ADMIN ---------START----------------------------------- //



// CREATE Lead
export const createLead = async (req, res, next) => {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);

    try {
        const data = req.body;

        // ============================================================
        // VALIDATION
        // ============================================================

        if (!data.first_name || String(data.first_name).trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'First name is required'
            });
        }

        if (!data.last_name || String(data.last_name).trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Last name is required'
            });
        }

        // ============================================================
        // NORMALIZE ASSIGNED USER
        // assigned_to is optional
        // Empty / null / missing => NULL
        // ============================================================

        let assignedTo = null;

        if (
            data.assigned_to !== undefined &&
            data.assigned_to !== null &&
            String(data.assigned_to).trim() !== ''
        ) {
            assignedTo = parseInt(data.assigned_to, 10);

            if (!Number.isInteger(assignedTo)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid assigned_to'
                });
            }
        }

        // ============================================================
        // NORMALIZE LEAD STATUS
        // ============================================================

        let leadStatus = null;

        if (
            data.lead_status !== undefined &&
            data.lead_status !== null &&
            String(data.lead_status).trim() !== ''
        ) {
            leadStatus = parseInt(data.lead_status, 10);

            if (!Number.isInteger(leadStatus)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid lead_status'
                });
            }
        }

        // ============================================================
        // FULL NAME
        // ============================================================

        const fullName = [
            data.first_name,
            data.middle_name,
            data.last_name
        ]
            .map(value =>
                value !== undefined &&
                    value !== null
                    ? String(value).trim()
                    : ''
            )
            .filter(Boolean)
            .join(' ');

        // ============================================================
        // START TRANSACTION
        // ============================================================

        await transaction.begin();

        // ============================================================
        // VERIFY ASSIGNED USER
        // Only check if assigned_to was provided
        // ============================================================

        if (assignedTo !== null) {

            const userResult = await new sql.Request(transaction)
                .input(
                    'user_id',
                    sql.Int,
                    assignedTo
                )
                .query(`
                    SELECT id
                    FROM dbo.Users
                    WHERE id = @user_id
                `);

            if (userResult.recordset.length === 0) {

                await transaction.rollback();

                return res.status(400).json({
                    success: false,
                    message: `Assigned user with ID ${assignedTo} does not exist`
                });
            }
        }

        // ============================================================
        // VERIFY LEAD STATUS
        // Only check if lead_status was provided
        // ============================================================

        if (leadStatus !== null) {

            const statusResult = await new sql.Request(transaction)
                .input(
                    'lead_status',
                    sql.Int,
                    leadStatus
                )
                .query(`
                    SELECT id
                    FROM dbo.LeadStatuses
                    WHERE id = @lead_status
                `);

            if (statusResult.recordset.length === 0) {

                await transaction.rollback();

                return res.status(400).json({
                    success: false,
                    message: `Lead status with ID ${leadStatus} does not exist`
                });
            }
        }

        // ============================================================
        // INSERT LEAD
        // ============================================================

        const request = new sql.Request(transaction);

        request.input(
            'first_name',
            sql.NVarChar(100),
            String(data.first_name).trim()
        );

        request.input(
            'middle_name',
            sql.NVarChar(100),
            data.middle_name
                ? String(data.middle_name).trim()
                : null
        );

        request.input(
            'last_name',
            sql.NVarChar(100),
            String(data.last_name).trim()
        );

        request.input(
            'full_name',
            sql.NVarChar(250),
            fullName
        );

        request.input(
            'mobile_number',
            sql.NVarChar(30),
            data.mobile_number
                ? String(data.mobile_number).trim()
                : null
        );

        request.input(
            'alt_phone_number',
            sql.NVarChar(30),
            data.alt_phone_number
                ? String(data.alt_phone_number).trim()
                : null
        );

        request.input(
            'email_address',
            sql.NVarChar(150),
            data.email_address
                ? String(data.email_address).trim()
                : null
        );

        request.input(
            'alt_email',
            sql.NVarChar(150),
            data.alt_email
                ? String(data.alt_email).trim()
                : null
        );

        request.input(
            'source',
            sql.NVarChar(150),
            data.source
                ? String(data.source).trim()
                : null
        );

        request.input(
            'lead_status',
            sql.Int,
            leadStatus
        );

        request.input(
            'center_code',
            sql.NVarChar(50),
            data.center_code
                ? String(data.center_code).trim()
                : null
        );

        request.input(
            'assigned_to',
            sql.Int,
            assignedTo
        );

        request.input(
            'is_converted',
            sql.Bit,
            0
        );

        request.input(
            'remark',
            sql.NVarChar(sql.MAX),
            data.remark
                ? String(data.remark).trim()
                : null
        );

        const insertQuery = `
            INSERT INTO dbo.Leads (
                first_name,
                middle_name,
                last_name,
                full_name,
                mobile_number,
                alt_phone_number,
                email_address,
                alt_email,
                source,
                lead_status,
                center_code,
                assigned_to,
                is_converted,
                remark,
                created_at,
                updated_at
            )

            OUTPUT
                inserted.lead_id

            VALUES (
                @first_name,
                @middle_name,
                @last_name,
                @full_name,
                @mobile_number,
                @alt_phone_number,
                @email_address,
                @alt_email,
                @source,
                @lead_status,
                @center_code,
                @assigned_to,
                @is_converted,
                @remark,
                GETDATE(),
                GETDATE()
            )
        `;

        const result = await request.query(insertQuery);

        const leadId = result.recordset[0].lead_id;

        // ============================================================
        // GENERATE LEAD NUMBER
        //
        // Example:
        // L1-001-270826
        // L2-002-270826
        // L3-003-270826
        //
        // First part  = lead_id
        // Second part = 3 digit lead_id
        // Third part  = DDMMYY
        // ============================================================

        const now = new Date();

        const day = String(
            now.getDate()
        ).padStart(2, '0');

        const month = String(
            now.getMonth() + 1
        ).padStart(2, '0');

        const year = String(
            now.getFullYear()
        ).slice(-2);

        const leadNumber =
            `L${leadId}-` +
            `${day}${month}${year}`;

        // ============================================================
        // UPDATE LEAD NUMBER
        // ============================================================

        await new sql.Request(transaction)
            .input(
                'lead_id',
                sql.Int,
                leadId
            )
            .input(
                'lead_number',
                sql.NVarChar(50),
                leadNumber
            )
            .query(`
                UPDATE dbo.Leads
                SET
                    lead_number = @lead_number,
                    updated_at = GETDATE()
                WHERE lead_id = @lead_id
            `);

        // ============================================================
        // COMMIT TRANSACTION
        // ============================================================

        await transaction.commit();

        // ============================================================
        // RESPONSE
        // ============================================================

        return res.status(201).json({
            success: true,
            message: 'Lead created successfully',

            data: {
                lead_id: leadId,
                lead_number: leadNumber,
                assigned_to: assignedTo,
                lead_status: leadStatus,
                is_converted: false
            }
        });

    } catch (error) {

        // ============================================================
        // ROLLBACK
        // ============================================================

        try {
            await transaction.rollback();
        } catch (rollbackError) {
            console.error(
                'Transaction rollback failed:',
                rollbackError
            );
        }

        next(error);
    }
};



// READ: Get Leads with Pagination, Search, and Filters
export const getAllLeads = async (req, res, next) => {
    try {
        const pool = await poolPromise;
        const request = pool.request();

        // Pagination
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || 10, 1),
            100
        );
        const offset = (page - 1) * limit;

        // Search & Filters
        const {
            search,
            assigned_to,
            lead_status,
            is_converted
        } = req.query;

        let baseQuery = `
            FROM Leads L
            LEFT JOIN LeadStatuses LS
                ON L.lead_status = LS.id
            WHERE ISNULL(L.is_converted, 0) = 0
        `;

        /*
         * Search
         */
        if (search && search.trim() !== '') {
            request.input(
                'search',
                sql.NVarChar(250),
                `%${search.trim()}%`
            );

            baseQuery += `
                AND (
                    L.full_name LIKE @search
                    OR L.email_address LIKE @search
                    OR L.mobile_number LIKE @search
                    OR L.lead_number LIKE @search
                )
            `;
        }

        /*
         * Filter: assigned_to
         */
        if (assigned_to !== undefined && assigned_to !== '') {
            const assignedToId = parseInt(assigned_to, 10);

            if (!Number.isInteger(assignedToId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid assigned_to'
                });
            }

            request.input(
                'assigned_to',
                sql.Int,
                assignedToId
            );

            baseQuery += `
                AND L.assigned_to = @assigned_to
            `;
        }

        /*
         * Filter: lead_status
         */
        if (lead_status !== undefined && lead_status !== '') {
            const leadStatusId = parseInt(lead_status, 10);

            if (!Number.isInteger(leadStatusId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid lead_status'
                });
            }

            request.input(
                'lead_status',
                sql.Int,
                leadStatusId
            );

            baseQuery += `
                AND L.lead_status = @lead_status
            `;
        }

        /*
         * Filter: is_converted
         */
        if (is_converted !== undefined && is_converted !== '') {

            if (
                is_converted !== 'true' &&
                is_converted !== 'false' &&
                is_converted !== '1' &&
                is_converted !== '0'
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid is_converted value'
                });
            }

            const converted =
                is_converted === 'true' ||
                    is_converted === '1'
                    ? 1
                    : 0;

            request.input(
                'is_converted',
                sql.Bit,
                converted
            );

            baseQuery += `
                AND L.is_converted = @is_converted
            `;
        }

        /*
         * Pagination
         */
        request.input(
            'offset',
            sql.Int,
            offset
        );

        request.input(
            'limit',
            sql.Int,
            limit
        );

        /*
         * Data Query
         */
        const dataQuery = `
            SELECT
                L.lead_id,
                L.lead_number,
                L.first_name,
                L.middle_name,
                L.last_name,
                L.full_name,
                L.mobile_number,
                L.alt_phone_number,
                L.email_address,
                L.alt_email,
                L.source,

                L.lead_status,
                LS.status_name AS status_name,

                L.center_code,
                L.assigned_to,
                L.is_converted,
                L.remark,
                L.created_at,
                L.updated_at

            ${baseQuery}

            ORDER BY L.created_at DESC

            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY
        `;

        /*
         * Count Query
         */
        const countQuery = `
            SELECT COUNT(*) AS total
            ${baseQuery}
        `;

        /*
         * IMPORTANT:
         * Do not use the same request object concurrently.
         * Create separate requests so parameters are isolated.
         */
        const dataRequest = pool.request();
        const countRequest = pool.request();

        // Copy parameters
        if (search && search.trim() !== '') {
            dataRequest.input(
                'search',
                sql.NVarChar(250),
                `%${search.trim()}%`
            );

            countRequest.input(
                'search',
                sql.NVarChar(250),
                `%${search.trim()}%`
            );
        }

        if (assigned_to !== undefined && assigned_to !== '') {
            const assignedToId = parseInt(assigned_to, 10);

            dataRequest.input(
                'assigned_to',
                sql.Int,
                assignedToId
            );

            countRequest.input(
                'assigned_to',
                sql.Int,
                assignedToId
            );
        }

        if (lead_status !== undefined && lead_status !== '') {
            const leadStatusId = parseInt(lead_status, 10);

            dataRequest.input(
                'lead_status',
                sql.Int,
                leadStatusId
            );

            countRequest.input(
                'lead_status',
                sql.Int,
                leadStatusId
            );
        }


        if (is_converted !== undefined && is_converted !== '') {
            const converted =
                is_converted === 'true' ||
                    is_converted === '1'
                    ? 1
                    : 0;

            dataRequest.input(
                'is_converted',
                sql.Bit,
                converted
            );

            countRequest.input(
                'is_converted',
                sql.Bit,
                converted
            );
        }

        dataRequest.input(
            'offset',
            sql.Int,
            offset
        );

        dataRequest.input(
            'limit',
            sql.Int,
            limit
        );

        const [dataResult, countResult] = await Promise.all([
            dataRequest.query(dataQuery),
            countRequest.query(countQuery)
        ]);

        const total = countResult.recordset[0].total;

        return res.status(200).json({
            success: true,
            data: dataResult.recordset,
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        next(error);
    }
};



// DELETE Lead
export const deleteLead = async (req, res, next) => {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);

    try {
        const leadId = parseInt(req.params.id, 10);

        if (!Number.isInteger(leadId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid lead ID'
            });
        }

        const userId = req.user?.id || null;

        const ipAddress =
            req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
            req.socket?.remoteAddress ||
            null;

        const userAgent = req.get('user-agent') || null;

        await transaction.begin();

        /*
         * Get lead details BEFORE deleting
         */
        const leadRequest = new sql.Request(transaction);

        leadRequest.input(
            'lead_id',
            sql.Int,
            leadId
        );

        const leadResult = await leadRequest.query(`
            SELECT
                lead_id,
                lead_number,
                first_name,
                middle_name,
                last_name,
                full_name,
                mobile_number,
                alt_phone_number,
                email_address,
                alt_email,
                source,
                lead_status,
                center_code,
                assigned_to,
                is_converted,
                remark
            FROM Leads
            WHERE lead_id = @lead_id
        `);

        if (leadResult.recordset.length === 0) {
            await transaction.rollback();

            return res.status(404).json({
                success: false,
                message: 'Lead not found'
            });
        }

        const lead = leadResult.recordset[0];

        /*
         * Create readable deleted lead information
         */
        const deletedLeadDetails = [
            `Lead ID: ${lead.lead_id}`,
            `Lead Number: ${lead.lead_number || 'NULL'}`,
            `First Name: ${lead.first_name || 'NULL'}`,
            `Middle Name: ${lead.middle_name || 'NULL'}`,
            `Last Name: ${lead.last_name || 'NULL'}`,
            `Full Name: ${lead.full_name || 'NULL'}`,
            `Mobile Number: ${lead.mobile_number || 'NULL'}`,
            `Alternate Phone: ${lead.alt_phone_number || 'NULL'}`,
            `Email: ${lead.email_address || 'NULL'}`,
            `Alternate Email: ${lead.alt_email || 'NULL'}`,
            `Source: ${lead.source || 'NULL'}`,
            `Lead Status: ${lead.lead_status ?? 'NULL'}`,
            `Center Code: ${lead.center_code || 'NULL'}`,
            `Assigned To: ${lead.assigned_to ?? 'NULL'}`,
            `Converted: ${lead.is_converted ?? 'NULL'}`,
            `Remark: ${lead.remark || 'NULL'}`
        ].join(', ');

        /*
         * Delete Lead
         */
        const deleteRequest = new sql.Request(transaction);

        deleteRequest.input(
            'lead_id',
            sql.Int,
            leadId
        );

        const deleteResult = await deleteRequest.query(`
            DELETE FROM Leads
            WHERE lead_id = @lead_id
        `);

        if (deleteResult.rowsAffected[0] === 0) {
            await transaction.rollback();

            return res.status(404).json({
                success: false,
                message: 'Lead not found'
            });
        }

        /*
         * Insert ONE ActivityLogs record
         */
        const activityRequest = new sql.Request(transaction);

        activityRequest.input(
            'lead_id',
            sql.Int,
            leadId
        );

        activityRequest.input(
            'case_id',
            sql.Int,
            null
        );

        activityRequest.input(
            'user_id',
            sql.Int,
            userId
        );

        activityRequest.input(
            'activity_type',
            sql.NVarChar(100),
            'DELETE'
        );

        activityRequest.input(
            'entity_type',
            sql.NVarChar(100),
            'LEAD'
        );

        activityRequest.input(
            'entity_id',
            sql.Int,
            leadId
        );

        activityRequest.input(
            'old_value',
            sql.NVarChar(sql.MAX),
            deletedLeadDetails
        );

        activityRequest.input(
            'new_value',
            sql.NVarChar(sql.MAX),
            null
        );

        activityRequest.input(
            'description',
            sql.NVarChar(sql.MAX),
            `Lead ${lead.lead_number || leadId} deleted`
        );

        activityRequest.input(
            'ip_address',
            sql.NVarChar(100),
            ipAddress
        );

        activityRequest.input(
            'user_agent',
            sql.NVarChar(1000),
            userAgent
        );

        await activityRequest.query(`
            INSERT INTO ActivityLogs (
                lead_id,
                case_id,
                user_id,
                activity_type,
                entity_type,
                entity_id,
                old_value,
                new_value,
                description,
                ip_address,
                user_agent,
                created_at
            )
            VALUES (
                @lead_id,
                @case_id,
                @user_id,
                @activity_type,
                @entity_type,
                @entity_id,
                @old_value,
                @new_value,
                @description,
                @ip_address,
                @user_agent,
                GETDATE()
            )
        `);

        /*
         * Commit delete + activity log together
         */
        await transaction.commit();

        return res.status(200).json({
            success: true,
            message: 'Lead deleted successfully'
        });

    } catch (error) {

        try {
            await transaction.rollback();
        } catch (rollbackError) {
            console.error(
                'Rollback failed:',
                rollbackError
            );
        }

        next(error);
    }
};



// Lead Assignment Controller
export const assignLead = async (req, res, next) => {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);

    try {
        const leadId = parseInt(req.params.id, 10);
        const assignedTo = parseInt(req.body.assigned_to, 10);
        const remarks = req.body.remarks || null;

        const assignedBy = req.user?.id;

        const { ipAddress, userAgent } = getRequestInfo(req);

        if (!Number.isInteger(leadId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid lead ID'
            });
        }

        if (!Number.isInteger(assignedTo)) {
            return res.status(400).json({
                success: false,
                message: 'Valid assigned_to is required'
            });
        }

        if (!assignedBy) {
            return res.status(401).json({
                success: false,
                message: 'Authenticated user not found'
            });
        }

        await transaction.begin();

        // Get current lead
        const leadResult = await new sql.Request(transaction)
            .input('lead_id', sql.Int, leadId)
            .query(`
                SELECT
                    lead_id,
                    lead_number,
                    assigned_to,
                    center_code
                FROM Leads
                WHERE lead_id = @lead_id
            `);

        if (leadResult.recordset.length === 0) {
            await transaction.rollback();

            return res.status(404).json({
                success: false,
                message: 'Lead not found'
            });
        }

        const lead = leadResult.recordset[0];

        const oldUserId = lead.assigned_to;

        const oldUserResult = await new sql.Request(transaction)
            .input('user_id', sql.Int, oldUserId)
            .query(`
                SELECT
                    id,
                    full_name,
                    center_code
                FROM Users
                WHERE id = @user_id
            `);

        const assignedOldUser = oldUserResult.recordset[0];

        if (oldUserId === assignedTo) {
            await transaction.rollback();

            return res.status(400).json({
                success: false,
                message: 'Lead is already assigned to this user'
            });
        }

        // Verify assigned user
        const userResult = await new sql.Request(transaction)
            .input('user_id', sql.Int, assignedTo)
            .query(`
                SELECT
                    id,
                    full_name,
                    center_code
                FROM Users
                WHERE id = @user_id
            `);

        if (userResult.recordset.length === 0) {
            await transaction.rollback();

            return res.status(404).json({
                success: false,
                message: 'Assigned user not found'
            });
        }

        const assignedUser = userResult.recordset[0];

        // Update lead
        await new sql.Request(transaction)
            .input('lead_id', sql.Int, leadId)
            .input('assigned_to', sql.Int, assignedTo)
            .query(`
                UPDATE Leads
                SET
                    assigned_to = @assigned_to,
                    updated_at = GETDATE()
                WHERE lead_id = @lead_id
            `);

        // Lead Assignment History
        await new sql.Request(transaction)
            .input('lead_id', sql.Int, leadId)
            .input('old_user_id', sql.Int, oldUserId || null)
            .input('new_user_id', sql.Int, assignedTo)
            .input('assigned_by', sql.Int, assignedBy)
            .input('remarks', sql.NVarChar(sql.MAX), remarks)
            .query(`
                INSERT INTO LeadAssignmentHistory (
                    lead_id,
                    old_user_id,
                    new_user_id,
                    assigned_by,
                    remarks,
                    assigned_at
                )
                VALUES (
                    @lead_id,
                    @old_user_id,
                    @new_user_id,
                    @assigned_by,
                    @remarks,
                    GETDATE()
                )
            `);

        // Activity Log
        await createActivityLog({
            transaction,
            leadId,
            userId: assignedBy,
            activityType: 'ASSIGNMENT',
            entityType: 'LEAD',
            entityId: leadId,

            oldValue: oldUserId
                ? `User ID: ${oldUserId}`
                : 'Unassigned' + (
                    assignedOldUser.name ? ` (${assignedUser.name})`
                        : ''
                ),

            newValue:
                `User ID: ${assignedUser.id}` +
                (
                    assignedUser.name
                        ? ` (${assignedUser.name})`
                        : ''
                ),

            description:
                `Lead ${lead.lead_number || leadId} assigned to ` +
                `User ID: ${assignedUser.id}` +
                (
                    assignedUser.name
                        ? ` (${assignedUser.name})`
                        : ''
                ),

            ipAddress,
            userAgent
        });

        await transaction.commit();

        return res.status(200).json({
            success: true,
            message: 'Lead assigned successfully',
            data: {
                lead_id: leadId,
                old_user_id: oldUserId,
                new_user_id: assignedTo,
                assigned_by: assignedBy,
                remarks
            }
        });

    } catch (error) {

        try {
            await transaction.rollback();
        } catch (rollbackError) {
            console.error('Rollback failed:', rollbackError);
        }

        next(error);
    }
};



// Search Leads for SuperAdmin
export const searchSuperAdminLeads = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const search = req.query.search?.trim();

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'User authentication or center information missing'
            });
        }

        if (!search) {
            return res.status(400).json({
                success: false,
                message: 'Search value is required'
            });
        }

        const page = Math.max(parseInt(req.query.page) || 1, 1);

        const limit = Math.min(
            Math.max(parseInt(req.query.limit) || 20, 1),
            100
        );

        const offset = (page - 1) * limit;

        const pool = await poolPromise;
        const request = pool.request();

        request.input('user_id', sql.Int, userId);
        request.input('search', sql.NVarChar(150), `%${search}%`);
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limit);

        const result = await request.query(`
            SELECT
                L.lead_id,
                L.lead_number,
                L.first_name,
                L.middle_name,
                L.last_name,
                L.full_name,
                L.mobile_number,
                L.alt_phone_number,
                L.email_address,
                L.alt_email,
                L.source,
                L.lead_status,
                LS.lead_status_name
                L.center_code,
                L.assigned_to,
                L.is_converted,
                L.remark,
                L.created_at,
                L.updated_at
            FROM Leads
            LEFT JOIN LeadStatuses LS
                ON L.lead_status = LS.id
            WHERE
                L.is_converted = 0
                AND (
                    L.lead_number LIKE @search
                    OR L.first_name LIKE @search
                    OR L.middle_name LIKE @search
                    OR L.last_name LIKE @search
                    OR L.full_name LIKE @search
                    OR L.mobile_number LIKE @search
                    OR L.alt_phone_number LIKE @search
                    OR L.email_address LIKE @search
                    OR L.alt_email LIKE @search
                )
            ORDER BY L.created_at DESC
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY;

            SELECT COUNT(*) AS total
            FROM Leads
            WHERE
                is_converted = 0
                AND (
                    lead_number LIKE @search
                    OR first_name LIKE @search
                    OR middle_name LIKE @search
                    OR last_name LIKE @search
                    OR full_name LIKE @search
                    OR mobile_number LIKE @search
                    OR alt_phone_number LIKE @search
                    OR email_address LIKE @search
                    OR alt_email LIKE @search
                );
        `);

        const total = result.recordsets[1][0].total;

        return res.status(200).json({
            success: true,
            data: result.recordsets[0],
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Error in searchSuperAdminLeads:', error);
    }
};


// Filter Leads for SuperAdmin
export const filterSuperAdminLeads = async (req, res, next) => {
    try {
        const userId = req.user?.id;

        const leadStatus =
            req.query.lead_status !== undefined
                ? parseInt(req.query.lead_status)
                : null;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'User authentication missing'
            });
        }

        if (
            leadStatus !== null &&
            !Number.isInteger(leadStatus)
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid lead_status'
            });
        }

        if (
            leadStatus === null
        ) {
            return res.status(400).json({
                success: false,
                message: 'Provide lead_status'
            });
        }

        const page = Math.max(parseInt(req.query.page) || 1, 1);

        const limit = Math.min(
            Math.max(parseInt(req.query.limit) || 20, 1),
            100
        );

        const offset = (page - 1) * limit;

        const pool = await poolPromise;
        const request = pool.request();

        request.input('user_id', sql.Int, userId);
        request.input('lead_status', sql.Int, leadStatus);
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limit);

        const result = await request.query(`
            SELECT
                L.lead_id,
                L.lead_number,
                L.first_name,
                L.middle_name,
                L.last_name,
                L.full_name,
                L.mobile_number,
                L.alt_phone_number,
                L.email_address,
                L.alt_email,
                L.source,
                L.lead_status,
                LS.lead_status_name
                L.center_code,
                L.assigned_to,
                L.is_converted,
                L.remark,
                L.created_at,
                L.updated_at
            FROM Leads
            LEFT JOIN LeadStatuses LS
                ON L.lead_status = LS.id
            WHERE
                L.is_converted = 0

                AND (
                    @lead_status IS NULL
                    OR L.lead_status = @lead_status
                )

            ORDER BY L.created_at DESC
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY;

            SELECT COUNT(*) AS total
            FROM Leads
            WHERE
                is_converted = 0

                AND (
                    @lead_status IS NULL
                    OR lead_status = @lead_status
                )
        `);

        const total = result.recordsets[1][0].total;

        return res.status(200).json({
            success: true,
            data: result.recordsets[0],
            filters: {
                lead_status: leadStatus,
            },
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Error in filterSuperAdminLeads:', error);
    }
};


// Lead Status Count Controller



// ----------------------------------- CONTROLLERS SPECIFIC TO THE SUPER ADMIN ---------END----------------------------------- //










// ---------------------------- COMMON CONTROLLER FOR ADMIN / SUPER ADMIN / AGENT ------START------------------------------------- //

// READ: Get Lead By ID
export const getLeadById = async (req, res, next) => {
    try {
        const leadId = parseInt(req.params.id, 10);

        if (!Number.isInteger(leadId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid lead ID'
            });
        }

        const pool = await poolPromise;

        const result = await pool
            .request()
            .input('lead_id', sql.Int, leadId)
            .query(`
                SELECT
                    L.lead_id,
                    L.lead_number,

                    L.first_name,
                    L.middle_name,
                    L.last_name,
                    L.full_name,

                    L.mobile_number,
                    L.alt_phone_number,

                    L.email_address,
                    L.alt_email,

                    L.source,

                    L.lead_status,
                    LS.status_name AS lead_status_name,

                    L.center_code,
                    L.assigned_to,

                    L.is_converted,

                    L.remark,

                    L.created_at,
                    L.updated_at

                FROM Leads L

                LEFT JOIN LeadStatuses LS
                    ON L.lead_status = LS.id

                WHERE L.lead_id = @lead_id
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Lead not found'
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


// UPDATE Lead (Dynamic fields)
export const updateLead = async (req, res, next) => {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);

    try {
        const data = req.body;
        const leadId = parseInt(req.params.id, 10);

        if (!Number.isInteger(leadId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid lead ID'
            });
        }

        if (!data || Object.keys(data).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No data provided for update'
            });
        }

        const userId = req.user?.id || null;

        const ipAddress =
            req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
            req.socket?.remoteAddress ||
            null;

        const userAgent = req.get('user-agent') || null;

        /*
         * Only these fields can be updated.
         * lead_status and assigned_to are NOT included.
         */
        const typeMapping = {
            first_name: sql.NVarChar(100),
            middle_name: sql.NVarChar(100),
            last_name: sql.NVarChar(100),
            mobile_number: sql.NVarChar(30),
            alt_phone_number: sql.NVarChar(30),
            email_address: sql.NVarChar(150),
            alt_email: sql.NVarChar(150),
            source: sql.NVarChar(150),
            center_code: sql.NVarChar(50),
            remark: sql.NVarChar(sql.MAX),
            is_converted: sql.Bit
        };

        // Readable field names for ActivityLogs
        const fieldLabels = {
            first_name: 'First Name',
            middle_name: 'Middle Name',
            last_name: 'Last Name',
            mobile_number: 'Mobile Number',
            alt_phone_number: 'Alternate Phone',
            email_address: 'Email',
            alt_email: 'Alternate Email',
            source: 'Source',
            center_code: 'Center Code',
            remark: 'Remark',
            is_converted: 'Converted',
            full_name: 'Full Name'
        };

        await transaction.begin();

        /*
         * Get existing lead
         */
        const currentRequest = new sql.Request(transaction);

        currentRequest.input(
            'lead_id',
            sql.Int,
            leadId
        );

        const currentResult = await currentRequest.query(`
            SELECT
                lead_id,
                first_name,
                middle_name,
                last_name,
                mobile_number,
                alt_phone_number,
                email_address,
                alt_email,
                source,
                center_code,
                remark,
                is_converted,
                full_name
            FROM Leads
            WHERE lead_id = @lead_id
        `);

        if (currentResult.recordset.length === 0) {
            await transaction.rollback();

            return res.status(404).json({
                success: false,
                message: 'Lead not found'
            });
        }

        const currentLead = currentResult.recordset[0];

        const request = new sql.Request(transaction);

        request.input(
            'lead_id',
            sql.Int,
            leadId
        );

        const updateFields = [];

        // Plain text values for ActivityLogs
        const oldValueParts = [];
        const newValueParts = [];
        const changedFields = [];

        /*
         * Check changes
         */
        for (const [key, value] of Object.entries(data)) {

            // Ignore fields not allowed
            if (!typeMapping[key]) {
                continue;
            }

            const oldValue = currentLead[key];

            const oldString =
                oldValue === null || oldValue === undefined
                    ? ''
                    : String(oldValue);

            const newString =
                value === null || value === undefined
                    ? ''
                    : String(value);

            // Only update if value changed
            if (oldString !== newString) {

                request.input(
                    key,
                    typeMapping[key],
                    value
                );

                updateFields.push(
                    `${key} = @${key}`
                );

                const label = fieldLabels[key] || key;

                oldValueParts.push(
                    `${label}: ${oldString || 'NULL'}`
                );

                newValueParts.push(
                    `${label}: ${newString || 'NULL'}`
                );

                changedFields.push(label);
            }
        }

        /*
         * Recalculate full_name
         */
        if (
            data.first_name !== undefined ||
            data.middle_name !== undefined ||
            data.last_name !== undefined
        ) {
            const newFullName = [
                data.first_name !== undefined
                    ? data.first_name
                    : currentLead.first_name,

                data.middle_name !== undefined
                    ? data.middle_name
                    : currentLead.middle_name,

                data.last_name !== undefined
                    ? data.last_name
                    : currentLead.last_name
            ]
                .filter(Boolean)
                .join(' ');

            if (newFullName !== currentLead.full_name) {

                request.input(
                    'full_name',
                    sql.NVarChar(250),
                    newFullName
                );

                updateFields.push(
                    'full_name = @full_name'
                );

                oldValueParts.push(
                    `Full Name: ${currentLead.full_name || 'NULL'}`
                );

                newValueParts.push(
                    `Full Name: ${newFullName || 'NULL'}`
                );

                changedFields.push('Full Name');
            }
        }

        /*
         * No actual changes
         */
        if (changedFields.length === 0) {

            await transaction.rollback();

            return res.status(400).json({
                success: false,
                message: 'No changes detected'
            });
        }

        updateFields.push(
            'updated_at = GETDATE()'
        );

        /*
         * Update Leads
         */
        const updateQuery = `
            UPDATE Leads
            SET ${updateFields.join(', ')}
            WHERE lead_id = @lead_id
        `;

        const updateResult = await request.query(updateQuery);

        if (updateResult.rowsAffected[0] === 0) {

            await transaction.rollback();

            return res.status(404).json({
                success: false,
                message: 'Lead not found'
            });
        }

        /*
         * Plain text ActivityLog values
         */
        const oldValueText = oldValueParts.join(', ');
        const newValueText = newValueParts.join(', ');

        const description =
            `Lead ${leadId} updated: ${changedFields.join(', ')}`;

        /*
         * ONE ActivityLogs record
         */
        const activityRequest = new sql.Request(transaction);

        activityRequest.input(
            'lead_id',
            sql.Int,
            leadId
        );

        activityRequest.input(
            'case_id',
            sql.Int,
            null
        );

        activityRequest.input(
            'user_id',
            sql.Int,
            userId
        );

        activityRequest.input(
            'activity_type',
            sql.NVarChar(100),
            'UPDATE'
        );

        activityRequest.input(
            'entity_type',
            sql.NVarChar(100),
            'LEAD'
        );

        activityRequest.input(
            'entity_id',
            sql.Int,
            leadId
        );

        activityRequest.input(
            'old_value',
            sql.NVarChar(sql.MAX),
            oldValueText
        );

        activityRequest.input(
            'new_value',
            sql.NVarChar(sql.MAX),
            newValueText
        );

        activityRequest.input(
            'description',
            sql.NVarChar(sql.MAX),
            description
        );

        activityRequest.input(
            'ip_address',
            sql.NVarChar(100),
            ipAddress
        );

        activityRequest.input(
            'user_agent',
            sql.NVarChar(1000),
            userAgent
        );

        await activityRequest.query(`
            INSERT INTO ActivityLogs (
                lead_id,
                case_id,
                user_id,
                activity_type,
                entity_type,
                entity_id,
                old_value,
                new_value,
                description,
                ip_address,
                user_agent,
                created_at
            )
            VALUES (
                @lead_id,
                @case_id,
                @user_id,
                @activity_type,
                @entity_type,
                @entity_id,
                @old_value,
                @new_value,
                @description,
                @ip_address,
                @user_agent,
                GETDATE()
            )
        `);

        await transaction.commit();

        return res.status(200).json({
            success: true,
            message: 'Lead updated successfully',
            data: {
                lead_id: leadId,
                changed_fields: changedFields
            }
        });

    } catch (error) {

        try {
            await transaction.rollback();
        } catch (rollbackError) {
            console.error(
                'Rollback failed:',
                rollbackError
            );
        }

        next(error);
    }
};


// Lead Status Update Controller
export const updateLeadStatus = async (req, res, next) => {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);

    try {
        const leadId = parseInt(req.params.id, 10);
        const leadStatus = parseInt(req.body.lead_status, 10);

        const userId = req.user?.id || null;

        const ipAddress =
            req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
            req.socket?.remoteAddress ||
            null;

        const userAgent = req.get('user-agent') || null;

        if (!Number.isInteger(leadId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid lead ID'
            });
        }

        if (!Number.isInteger(leadStatus)) {
            return res.status(400).json({
                success: false,
                message: 'Valid lead_status is required'
            });
        }

        await transaction.begin();

        /*
         * Get current lead status
         */
        const leadRequest = new sql.Request(transaction);

        leadRequest.input(
            'lead_id',
            sql.Int,
            leadId
        );

        const leadResult = await leadRequest.query(`
            SELECT
                L.lead_id,
                L.lead_number,
                L.lead_status,
                LS.status_name AS current_status_name
            FROM Leads L
            LEFT JOIN LeadStatuses LS
                ON L.lead_status = LS.id
            WHERE L.lead_id = @lead_id
        `);

        if (leadResult.recordset.length === 0) {
            await transaction.rollback();

            return res.status(404).json({
                success: false,
                message: 'Lead not found'
            });
        }

        const lead = leadResult.recordset[0];

        /*
         * Check if same status
         */
        if (lead.lead_status === leadStatus) {
            await transaction.rollback();

            return res.status(400).json({
                success: false,
                message: 'Lead already has this status'
            });
        }

        /*
         * Verify new status exists
         */
        const statusRequest = new sql.Request(transaction);

        statusRequest.input(
            'lead_status',
            sql.Int,
            leadStatus
        );

        const statusResult = await statusRequest.query(`
            SELECT
                id,
                status_name
            FROM LeadStatuses
            WHERE id = @lead_status
        `);

        if (statusResult.recordset.length === 0) {
            await transaction.rollback();

            return res.status(404).json({
                success: false,
                message: 'Lead status not found'
            });
        }

        const newStatus = statusResult.recordset[0];

        /*
         * Update Lead Status
         */
        const updateRequest = new sql.Request(transaction);

        updateRequest.input(
            'lead_id',
            sql.Int,
            leadId
        );

        updateRequest.input(
            'lead_status',
            sql.Int,
            leadStatus
        );

        await updateRequest.query(`
            UPDATE Leads
            SET
                lead_status = @lead_status,
                updated_at = GETDATE()
            WHERE lead_id = @lead_id
        `);

        /*
         * Activity Log
         */
        const oldValue =
            lead.lead_status === null ||
                lead.lead_status === undefined
                ? 'No Status'
                : `Status ID: ${lead.lead_status}` +
                (lead.current_status_name
                    ? ` (${lead.current_status_name})`
                    : '');

        const newValue =
            `Status ID: ${newStatus.id}` +
            (newStatus.status_name
                ? ` (${newStatus.status_name})`
                : '');

        const activityRequest = new sql.Request(transaction);

        activityRequest.input(
            'lead_id',
            sql.Int,
            leadId
        );

        activityRequest.input(
            'case_id',
            sql.Int,
            null
        );

        activityRequest.input(
            'user_id',
            sql.Int,
            userId
        );

        activityRequest.input(
            'activity_type',
            sql.NVarChar(100),
            'STATUS_CHANGE'
        );

        activityRequest.input(
            'entity_type',
            sql.NVarChar(100),
            'LEAD'
        );

        activityRequest.input(
            'entity_id',
            sql.Int,
            leadId
        );

        activityRequest.input(
            'old_value',
            sql.NVarChar(sql.MAX),
            oldValue
        );

        activityRequest.input(
            'new_value',
            sql.NVarChar(sql.MAX),
            newValue
        );

        activityRequest.input(
            'description',
            sql.NVarChar(sql.MAX),
            `Lead ${lead.lead_number || leadId} status changed from ${lead.current_status_name || 'No Status'} to ${newStatus.status_name}`
        );

        activityRequest.input(
            'ip_address',
            sql.NVarChar(100),
            ipAddress
        );

        activityRequest.input(
            'user_agent',
            sql.NVarChar(1000),
            userAgent
        );

        await activityRequest.query(`
            INSERT INTO ActivityLogs (
                lead_id,
                case_id,
                user_id,
                activity_type,
                entity_type,
                entity_id,
                old_value,
                new_value,
                description,
                ip_address,
                user_agent,
                created_at
            )
            VALUES (
                @lead_id,
                @case_id,
                @user_id,
                @activity_type,
                @entity_type,
                @entity_id,
                @old_value,
                @new_value,
                @description,
                @ip_address,
                @user_agent,
                GETDATE()
            )
        `);

        await transaction.commit();

        return res.status(200).json({
            success: true,
            message: 'Lead status updated successfully',
            data: {
                lead_id: leadId,
                lead_status: newStatus.id,
                lead_status_name: newStatus.status_name
            }
        });

    } catch (error) {
        try {
            await transaction.rollback();
        } catch (rollbackError) {
            console.error('Rollback failed:', rollbackError);
        }

        next(error);
    }
};



// Lead Conversion Controller
/**
 * Controller to convert an existing Lead to an active Immigration Case.
 * 
 * Workflow Steps Executed within a Single Transaction:
 * 1. Validate Lead state and check eligibility for conversion.
 * 2. Generate unique Case Number.
 * 3. Insert into `ImmigrationCases`.
 * 4. Instantiate `CaseSteps` based on active `WorkflowSteps`.
 * 5. Update `Leads` (set is_converted = 1, fileStatus, updated_at).
 * 6. Associate existing records (Contracts, Payments, FollowUps, Communications, Notes) with the new case_id.
 * 7. Assign initial case officer (`CaseAssignmentHistory` and `CaseParticipants`).
 * 8. Write status changes to `StatusHistory`.
 * 9. Write audit logs to `ActivityLogs`.
 */


/**
 * Convert Lead into Immigration Case
 *
 * POST /api/leads/:leadId/convert
 *
 * Body:
 * {
 *   "program_id": 1,
 *   "remark": "Lead converted to Express Entry case"
 * }
 */
export const convertLeadIntoCase = async (req, res, next) => {
    let transaction;

    try {
        const leadId = parseInt(req.params.leadId, 10);
        const userId = req.user?.id;

        const programId = parseInt(req.body?.program_id, 10);
        const remark = req.body?.remark?.trim() || null;

        if (!leadId || Number.isNaN(leadId)) {
            return res.status(400).json({
                success: false,
                message: "Valid lead_id is required."
            });
        }

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized."
            });
        }

        if (!programId || Number.isNaN(programId)) {
            return res.status(400).json({
                success: false,
                message: "Valid program_id is required."
            });
        }

        const pool = await poolPromise;

        /*
         * IMPORTANT:
         * Pass the pool to sql.Transaction().
         * Do NOT use new sql.Transaction() without a pool.
         */
        transaction = new sql.Transaction(pool);

        await transaction.begin();

        /*
         * ---------------------------------------------------------
         * 1. Get Lead
         * ---------------------------------------------------------
         */
        const leadRequest = new sql.Request(transaction);

        const leadResult = await leadRequest
            .input("lead_id", sql.Int, leadId)
            .query(`
                SELECT
                    lead_id,
                    first_name,
                    middle_name,
                    last_name,
                    lead_number,
                    assigned_to,
                    center_code,
                    lead_status,
                    is_converted
                FROM dbo.Leads WITH (UPDLOCK, ROWLOCK)
                WHERE lead_id = @lead_id
            `);

        if (leadResult.recordset.length === 0) {
            await transaction.rollback();

            return res.status(404).json({
                success: false,
                message: "Lead not found."
            });
        }

        const lead = leadResult.recordset[0];

        /*
         * ---------------------------------------------------------
         * 2. Check whether lead is already converted
         * ---------------------------------------------------------
         */
        if (lead.is_converted === true || lead.is_converted === 1) {
            await transaction.rollback();

            return res.status(409).json({
                success: false,
                message: "Lead is already converted into a case."
            });
        }

        /*
         * ---------------------------------------------------------
         * 3. Get Immigration Program
         * ---------------------------------------------------------
         */
        const programRequest = new sql.Request(transaction);

        const programResult = await programRequest
            .input("program_id", sql.Int, programId)
            .query(`
                SELECT
                    program_id,
                    program_name,
                    description,
                    is_active
                FROM dbo.ImmigrationPrograms
                WHERE program_id = @program_id
            `);

        if (programResult.recordset.length === 0) {
            await transaction.rollback();

            return res.status(404).json({
                success: false,
                message: "Immigration program not found."
            });
        }

        const program = programResult.recordset[0];

        if (!program.is_active) {
            await transaction.rollback();

            return res.status(400).json({
                success: false,
                message: "Selected immigration program is inactive."
            });
        }

        /*
         * ---------------------------------------------------------
         * 4. Check whether lead already has a case for this program
         * ---------------------------------------------------------
         */
        const existingCaseRequest = new sql.Request(transaction);

        const existingCaseResult = await existingCaseRequest
            .input("lead_id", sql.Int, leadId)
            .input("program_id", sql.Int, programId)
            .query(`
                SELECT TOP 1
                    case_id,
                    case_number
                FROM dbo.ImmigrationCases
                WHERE lead_id = @lead_id
                  AND program_id = @program_id
                ORDER BY case_id DESC
            `);

        if (existingCaseResult.recordset.length > 0) {
            await transaction.rollback();

            return res.status(409).json({
                success: false,
                message: "This lead already has a case for the selected immigration program.",
                case: existingCaseResult.recordset[0]
            });
        }

        /*
         * ---------------------------------------------------------
         * 5. Generate Case Number
         * ---------------------------------------------------------
         *
         * Example:
         * CASE-20260910-000123
         *
         * You can change this format according to your requirement.
         */
        const caseNumber = `CASE-${Date.now()}-${leadId}`;

        /*
         * ---------------------------------------------------------
         * 6. Create Immigration Case
         * ---------------------------------------------------------
         */
        const caseRequest = new sql.Request(transaction);

        const caseResult = await caseRequest
            .input("case_number", sql.VarChar(100), caseNumber)
            .input("lead_id", sql.Int, leadId)
            .input("program_id", sql.Int, programId)
            .input(
                "assigned_to",
                sql.Int,
                lead.assigned_to || userId
            )
            .input(
                "center_code",
                sql.VarChar(50),
                lead.center_code
            )
            .input("remark", sql.NVarChar(sql.MAX), remark)
            .query(`
                INSERT INTO dbo.ImmigrationCases
                (
                    case_number,
                    lead_id,
                    program_id,
                    assigned_to,
                    center_code,
                    opened_at,
                    remark,
                    created_at,
                    updated_at
                )
                OUTPUT
                    INSERTED.case_id,
                    INSERTED.case_number
                VALUES
                (
                    @case_number,
                    @lead_id,
                    @program_id,
                    @assigned_to,
                    @center_code,
                    SYSUTCDATETIME(),
                    @remark,
                    SYSUTCDATETIME(),
                    SYSUTCDATETIME()
                )
            `);

        const newCase = caseResult.recordset[0];

        const caseId = newCase.case_id;

        /*
         * ---------------------------------------------------------
         * 7. Get Workflow Stages for selected program
         * ---------------------------------------------------------
         *
         * This gets:
         *
         * Stage 1:
         *   PCE
         *   PCE_SUPPORT
         *
         * Stage 2:
         *   EE_PROFILE
         *
         * Stage 3:
         *   EE_POOL
         *
         * Stage 4:
         *   PNP
         *
         * Stage 5:
         *   ITA_NOI
         */
        const stagesRequest = new sql.Request(transaction);

        const stagesResult = await stagesRequest
            .input("program_id", sql.Int, programId)
            .query(`
                SELECT
                    stage_id,
                    program_id,
                    stage_no,
                    stage_code,
                    stage_name,
                    department,
                    sort_order,
                    is_active
                FROM dbo.WorkflowStages
                WHERE program_id = @program_id
                  AND is_active = 1
                ORDER BY
                    stage_no ASC,
                    sort_order ASC,
                    stage_id ASC
            `);

        if (stagesResult.recordset.length === 0) {
            await transaction.rollback();

            return res.status(400).json({
                success: false,
                message: "No active workflow stages found for the selected program."
            });
        }

        /*
         * ---------------------------------------------------------
         * 8. Copy WorkflowStages -> CaseStages
         * ---------------------------------------------------------
         *
         * We do NOT simply store the template.
         *
         * CaseStages represents the actual workflow of this customer.
         */
        const caseStageMap = new Map();

        for (const stage of stagesResult.recordset) {

            /*
             * Stage 1 can contain:
             *
             * PCE
             * PCE_SUPPORT
             *
             * Both have stage_no = 1.
             *
             * We create both template records in CaseStages,
             * but only the initial applicable path should be active.
             */

            let caseStageStatus = "Pending";

            /*
             * PCE is the initial active stage.
             *
             * PCE_SUPPORT is an alternative branch and should
             * remain pending until PCE assessment is NOT_CLEARED.
             */
            if (stage.stage_code === "PCE") {
                caseStageStatus = "In Progress";
            }

            if (stage.stage_code === "PCE_SUPPORT") {
                caseStageStatus = "Pending";
            }

            const caseStageRequest = new sql.Request(transaction);

            const caseStageResult = await caseStageRequest
                .input("case_id", sql.Int, caseId)
                .input("stage_id", sql.Int, stage.stage_id)
                .input("status", sql.VarChar(50), caseStageStatus)
                .input(
                    "assigned_to",
                    sql.Int,
                    lead.assigned_to || userId
                )
                .query(`
                    INSERT INTO dbo.CaseStages
                    (
                        case_id,
                        stage_id,
                        status,
                        assigned_to,
                        started_at,
                        created_at,
                        updated_at
                    )
                    OUTPUT INSERTED.case_stage_id
                    VALUES
                    (
                        @case_id,
                        @stage_id,
                        @status,
                        @assigned_to,

                        CASE
                            WHEN @status = 'In Progress'
                            THEN SYSUTCDATETIME()
                            ELSE NULL
                        END,

                        SYSUTCDATETIME(),
                        SYSUTCDATETIME()
                    )
                `);

            const caseStageId =
                caseStageResult.recordset[0].case_stage_id;

            caseStageMap.set(stage.stage_id, {
                case_stage_id: caseStageId,
                stage_code: stage.stage_code,
                stage_no: stage.stage_no
            });
        }

        /*
         * ---------------------------------------------------------
         * 9. Copy WorkflowSteps -> CaseSteps
         * ---------------------------------------------------------
         */
        const stepsRequest = new sql.Request(transaction);

        const stepsResult = await stepsRequest
            .input("program_id", sql.Int, programId)
            .query(`
                SELECT
                    ws.workflow_step_id,
                    ws.stage_id,
                    ws.step_code,
                    ws.step_name,
                    ws.sort_order,
                    ws.is_active
                FROM dbo.WorkflowSteps ws
                INNER JOIN dbo.WorkflowStages wst
                    ON wst.stage_id = ws.stage_id
                WHERE wst.program_id = @program_id
                  AND wst.is_active = 1
                  AND ws.is_active = 1
                ORDER BY
                    wst.stage_no ASC,
                    wst.sort_order ASC,
                    ws.sort_order ASC,
                    ws.workflow_step_id ASC
            `);

        /*
         * Store CaseStep IDs for possible later use.
         */
        const caseStepMap = new Map();

        for (const step of stepsResult.recordset) {

            const caseStage = caseStageMap.get(step.stage_id);

            if (!caseStage) {
                throw new Error(
                    `Case stage not found for workflow stage ${step.stage_id}`
                );
            }

            /*
             * Only the PCE first step should initially be active.
             *
             * Everything else starts Pending.
             */
            let stepStatus = "Pending";

            if (
                caseStage.stage_code === "PCE" &&
                step.sort_order === 1
            ) {
                stepStatus = "In Progress";
            }

            const caseStepRequest = new sql.Request(transaction);

            const caseStepResult = await caseStepRequest
                .input("case_id", sql.Int, caseId)
                .input(
                    "workflow_step_id",
                    sql.Int,
                    step.workflow_step_id
                )
                .input(
                    "step_status",
                    sql.VarChar(50),
                    stepStatus
                )
                .input(
                    "assigned_to",
                    sql.Int,
                    lead.assigned_to || userId
                )
                .query(`
                    INSERT INTO dbo.CaseSteps
                    (
                        case_id,
                        workflow_step_id,
                        step_status,
                        assigned_to,
                        started_at,
                        created_at,
                        updated_at
                    )
                    OUTPUT INSERTED.case_step_id
                    VALUES
                    (
                        @case_id,
                        @workflow_step_id,
                        @step_status,
                        @assigned_to,

                        CASE
                            WHEN @step_status = 'In Progress'
                            THEN SYSUTCDATETIME()
                            ELSE NULL
                        END,

                        SYSUTCDATETIME(),
                        SYSUTCDATETIME()
                    )
                `);

            caseStepMap.set(
                step.workflow_step_id,
                caseStepResult.recordset[0].case_step_id
            );
        }

        /*
         * ---------------------------------------------------------
         * 10. Mark Lead as Converted
         * ---------------------------------------------------------
         */
        const updateLeadRequest = new sql.Request(transaction);

        await updateLeadRequest
            .input("lead_id", sql.Int, leadId)
            .query(`
                UPDATE dbo.Leads
                SET
                    is_converted = 1,
                    lead_status = ,
                    updated_at = SYSUTCDATETIME()
                WHERE lead_id = @lead_id
            `);

        /*
         * ---------------------------------------------------------
         * 11. Status History
         * ---------------------------------------------------------
         */
        const historyRequest = new sql.Request(transaction);

        await historyRequest
            .input("lead_id", sql.Int, leadId)
            .input("case_id", sql.Int, caseId)
            .input("changed_by", sql.Int, userId)
            .input("remarks", sql.NVarChar(sql.MAX), remark)
            .query(`
                INSERT INTO dbo.StatusHistory
                (
                    lead_id,
                    case_id,
                    entity_type,
                    old_status,
                    new_status,
                    changed_by,
                    remarks
                )
                VALUES
                (
                    @lead_id,
                    @case_id,
                    'LEAD',
                    'Lead',
                    'Converted',
                    @changed_by,
                    @remarks
                )
            `);

        /*
         * ---------------------------------------------------------
         * 12. Case Assignment History
         * ---------------------------------------------------------
         */
        const assignmentRequest = new sql.Request(transaction);

        await assignmentRequest
            .input("case_id", sql.Int, caseId)
            .input(
                "new_user_id",
                sql.Int,
                lead.assigned_to || userId
            )
            .input("assigned_by", sql.Int, userId)
            .input("remarks", sql.NVarChar(sql.MAX), "Case created from lead conversion")
            .query(`
                INSERT INTO dbo.CaseAssignmentHistory
                (
                    case_id,
                    old_user_id,
                    new_user_id,
                    assigned_by,
                    remarks
                )
                VALUES
                (
                    @case_id,
                    NULL,
                    @new_user_id,
                    @assigned_by,
                    @remarks
                )
            `);

        /*
         * ---------------------------------------------------------
         * 13. Activity Log
         * ---------------------------------------------------------
         */
        await createActivityLog({
            transaction,
            leadId,
            caseId,
            userId,
            activityType: "CONVERT",
            entityType: "LEAD",
            entityId: leadId,
            oldValue: "Not Converted",
            newValue: "Converted",
            description:
                `Lead converted into case ${caseNumber} for program ${program.program_name}`,
            ipAddress:
                req.ip ||
                req.headers["x-forwarded-for"] ||
                null,
            userAgent:
                req.headers["user-agent"] || null
        });

        /*
         * ---------------------------------------------------------
         * 14. Commit
         * ---------------------------------------------------------
         */
        await transaction.commit();

        return res.status(201).json({
            success: true,
            message: "Lead converted into immigration case successfully.",

            data: {
                lead_id: leadId,
                case_id: caseId,
                case_number: caseNumber,
                program_id: program.program_id,
                program_name: program.program_name,
                assigned_to: lead.assigned_to || userId
            }
        });

    } catch (error) {

        /*
         * Rollback if transaction was started.
         */
        if (transaction) {
            try {
                await transaction.rollback();
            } catch (rollbackError) {
                console.error(
                    "Transaction rollback error:",
                    rollbackError
                );
            }
        }

        console.error(
            "convertLeadIntoCase Error:",
            error
        );

        next(error);
    }
};




export const convertLeadtoCase = async (req, res, next) => {
    const { leadId } = req.params;

    const {
        program_id,
        assigned_to,
        participantRole = null,
        remark = null,
        center_code,
        payment = null
    } = req.body;

    const convertedBy = req.user?.id || null;

    let transaction = null;
    let transactionStarted = false;

    try {
        // ============================================================
        // 1. VALIDATE LEAD ID
        // ============================================================

        if (!leadId) {
            return res.status(400).json({
                success: false,
                message: "Lead ID is required."
            });
        }

        const parsedLeadId = Number(leadId);

        if (!Number.isInteger(parsedLeadId) || parsedLeadId <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid Lead ID."
            });
        }

        // ============================================================
        // 2. VALIDATE AUTHENTICATED USER
        // ============================================================

        if (
            convertedBy === null ||
            convertedBy === undefined ||
            !Number.isInteger(Number(convertedBy)) ||
            Number(convertedBy) <= 0
        ) {
            return res.status(401).json({
                success: false,
                message: "Authenticated user is required."
            });
        }

        const parsedConvertedBy = Number(convertedBy);

        // ============================================================
        // 3. VALIDATE PROGRAM ID
        // ============================================================

        if (
            program_id === undefined ||
            program_id === null ||
            program_id === ""
        ) {
            return res.status(400).json({
                success: false,
                message: "program_id is required."
            });
        }

        const parsedProgramId = Number(program_id);

        if (
            !Number.isInteger(parsedProgramId) ||
            parsedProgramId <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid program_id."
            });
        }

        // ============================================================
        // 4. VALIDATE ASSIGNED USER INPUT
        // ============================================================

        let requestedAssignedTo = null;

        if (
            assigned_to !== undefined &&
            assigned_to !== null &&
            assigned_to !== ""
        ) {
            requestedAssignedTo = Number(assigned_to);

            if (
                !Number.isInteger(requestedAssignedTo) ||
                requestedAssignedTo <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid assigned_to."
                });
            }
        }

        // ============================================================
        // 5. VALIDATE PAYMENT DATA
        // ============================================================

        if (payment !== null && payment !== undefined) {
            if (
                typeof payment !== "object" ||
                Array.isArray(payment)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Payment must be a valid object."
                });
            }

            if (
                payment.amount === undefined ||
                payment.amount === null ||
                payment.amount === ""
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Payment amount is required when payment details are provided."
                });
            }

            const paymentAmount = Number(payment.amount);

            if (
                !Number.isFinite(paymentAmount) ||
                paymentAmount <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Payment amount must be greater than 0."
                });
            }

            if (
                payment.payment_type_id !== undefined &&
                payment.payment_type_id !== null &&
                payment.payment_type_id !== ""
            ) {
                const paymentTypeId = Number(
                    payment.payment_type_id
                );

                if (
                    !Number.isInteger(paymentTypeId) ||
                    paymentTypeId <= 0
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid payment_type_id."
                    });
                }
            }

            if (
                payment.received_by !== undefined &&
                payment.received_by !== null &&
                payment.received_by !== ""
            ) {
                const receivedBy = Number(payment.received_by);

                if (
                    !Number.isInteger(receivedBy) ||
                    receivedBy <= 0
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid received_by."
                    });
                }
            }

            if (
                payment.payment_date !== undefined &&
                payment.payment_date !== null &&
                payment.payment_date !== ""
            ) {
                const paymentDate = new Date(
                    payment.payment_date
                );

                if (Number.isNaN(paymentDate.getTime())) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid payment_date."
                    });
                }
            }
        }

        // ============================================================
        // 6. GET SQL CONNECTION
        // ============================================================

        const pool = await poolPromise;

        if (!pool) {
            throw new Error(
                "Database connection pool is not available."
            );
        }

        // IMPORTANT:
        // Transaction must be created using the connected pool.
        transaction = new sql.Transaction(pool);

        await transaction.begin();

        transactionStarted = true;

        // ============================================================
        // 7. GET LEAD
        // ============================================================

        const leadResult = await transaction
            .request()
            .input(
                "lead_id",
                sql.Int,
                parsedLeadId
            )
            .query(`
                SELECT
                    L.lead_id,
                    L.first_name,
                    L.last_name,
                    L.center_code,
                    L.assigned_to,
                    L.lead_status,
                    LS.status_name AS lead_status_name,
                    L.is_converted
                FROM Leads AS L
                LEFT JOIN LeadStatuses AS LS
                    ON L.lead_status = LS.id
                WHERE L.lead_id = @lead_id
            `);

        if (leadResult.recordset.length === 0) {
            await transaction.rollback();
            transactionStarted = false;

            return res.status(404).json({
                success: false,
                message: "Lead not found."
            });
        }

        const lead = leadResult.recordset[0];

        // ============================================================
        // 8. PREVENT DUPLICATE CONVERSION
        // ============================================================

        if (
            lead.is_converted === true ||
            lead.is_converted === 1
        ) {
            const existingCaseResult = await transaction
                .request()
                .input(
                    "lead_id",
                    sql.Int,
                    parsedLeadId
                )
                .query(`
                    SELECT TOP 1
                        case_id,
                        case_number,
                        lead_id,
                        program_id,
                        assigned_to,
                        center_code,
                        opened_at,
                        closed_at,
                        remark
                    FROM ImmigrationCases
                    WHERE lead_id = @lead_id
                    ORDER BY case_id DESC
                `);

            await transaction.rollback();
            transactionStarted = false;

            return res.status(409).json({
                success: false,
                message:
                    "This lead has already been converted into a case.",
                case:
                    existingCaseResult.recordset[0] || null
            });
        }

        // ============================================================
        // 9. CHECK IMMIGRATION CASE INDEPENDENTLY
        // ============================================================

        const existingCaseResult = await transaction
            .request()
            .input(
                "lead_id",
                sql.Int,
                parsedLeadId
            )
            .query(`
                SELECT TOP 1
                    case_id,
                    case_number,
                    program_id
                FROM ImmigrationCases
                WHERE lead_id = @lead_id
                ORDER BY case_id DESC
            `);

        if (existingCaseResult.recordset.length > 0) {
            await transaction.rollback();
            transactionStarted = false;

            return res.status(409).json({
                success: false,
                message:
                    "An immigration case already exists for this lead.",
                case: existingCaseResult.recordset[0]
            });
        }

        // ============================================================
        // 10. VERIFY AUTHENTICATED USER EXISTS
        // ============================================================

        const convertedByResult = await transaction
            .request()
            .input(
                "user_id",
                sql.Int,
                parsedConvertedBy
            )
            .query(`
                SELECT TOP 1
                    id,
                    center_code
                FROM Users
                WHERE id = @user_id
            `);

        if (convertedByResult.recordset.length === 0) {
            await transaction.rollback();
            transactionStarted = false;

            return res.status(401).json({
                success: false,
                message:
                    "Authenticated user does not exist."
            });
        }

        // ============================================================
        // 11. DETERMINE ASSIGNED USER
        // ============================================================

        const finalAssignedTo =
            requestedAssignedTo !== null
                ? requestedAssignedTo
                : (
                    lead.assigned_to !== null &&
                        lead.assigned_to !== undefined &&
                        lead.assigned_to !== ""
                        ? Number(lead.assigned_to)
                        : null
                );

        // ============================================================
        // 12. VALIDATE ASSIGNED USER
        // ============================================================

        let assignedUser = null;

        if (
            finalAssignedTo !== null &&
            finalAssignedTo !== undefined
        ) {
            if (
                !Number.isInteger(Number(finalAssignedTo)) ||
                Number(finalAssignedTo) <= 0
            ) {
                await transaction.rollback();
                transactionStarted = false;

                return res.status(400).json({
                    success: false,
                    message: "Invalid assigned_to."
                });
            }

            const assignedUserResult = await transaction
                .request()
                .input(
                    "user_id",
                    sql.Int,
                    Number(finalAssignedTo)
                )
                .query(`
                    SELECT TOP 1
                        id,
                        center_code
                    FROM Users
                    WHERE id = @user_id
                `);

            if (assignedUserResult.recordset.length === 0) {
                await transaction.rollback();
                transactionStarted = false;

                return res.status(400).json({
                    success: false,
                    message:
                        `Assigned user ${finalAssignedTo} does not exist.`
                });
            }

            assignedUser =
                assignedUserResult.recordset[0];
        }

        // ============================================================
        // 13. DETERMINE CENTER CODE
        // ============================================================

        const finalCenterCode =
            center_code !== undefined &&
                center_code !== null &&
                center_code !== ""
                ? String(center_code).trim()
                : lead.center_code;

        if (!finalCenterCode) {
            await transaction.rollback();
            transactionStarted = false;

            return res.status(400).json({
                success: false,
                message:
                    "center_code is required either in request or on the lead."
            });
        }

        // ============================================================
        // 14. VERIFY SELECTED IMMIGRATION PROGRAM
        // ============================================================

        const programResult = await transaction
            .request()
            .input(
                "program_id",
                sql.Int,
                parsedProgramId
            )
            .query(`
                SELECT TOP 1
                    program_id,
                    program_name,
                    description,
                    is_active
                FROM ImmigrationPrograms
                WHERE program_id = @program_id
            `);

        if (programResult.recordset.length === 0) {
            await transaction.rollback();
            transactionStarted = false;

            return res.status(400).json({
                success: false,
                message:
                    `Immigration program ${parsedProgramId} does not exist.`
            });
        }

        const selectedProgram =
            programResult.recordset[0];

        if (
            selectedProgram.is_active === false ||
            selectedProgram.is_active === 0
        ) {
            await transaction.rollback();
            transactionStarted = false;

            return res.status(400).json({
                success: false,
                message:
                    `Immigration program "${selectedProgram.program_name}" is inactive.`
            });
        }

        // ============================================================
        // 15. LOAD WORKFLOW FOR SELECTED PROGRAM
        //
        // NO HARD-CODED STAGE HERE.
        //
        // WorkflowStages.program_id determines which workflow
        // belongs to the selected immigration program.
        // ============================================================

        const workflowStagesResult = await transaction
            .request()
            .input(
                "program_id",
                sql.Int,
                parsedProgramId
            )
            .query(`
                SELECT
                    stage_id,
                    program_id,
                    stage_code,
                    stage_name,
                    department,
                    stage_no,
                    sort_order,
                    is_active
                FROM WorkflowStages
                WHERE program_id = @program_id
                  AND is_active = 1
                ORDER BY
                    stage_no ASC,
                    sort_order ASC,
                    stage_id ASC
            `);

        const workflowStages =
            workflowStagesResult.recordset;

        if (workflowStages.length === 0) {
            await transaction.rollback();
            transactionStarted = false;

            return res.status(400).json({
                success: false,
                message:
                    `No active workflow stages are configured for immigration program "${selectedProgram.program_name}".`
            });
        }

        // ============================================================
        // 16. SELECT INITIAL STAGE FROM PROGRAM WORKFLOW
        //
        // This is dynamic.
        //
        // Example:
        //
        // Program 1:
        //   stage 1 -> PCE
        //   stage 2 -> Express Entry
        //
        // Program 2:
        //   stage 1 -> Assessment
        //   stage 2 -> Profile Creation
        //
        // The controller does not know the stage names.
        // ============================================================

        const initialStage = workflowStages[0];

        // ============================================================
        // 17. LOAD STEPS FOR SELECTED INITIAL STAGE
        // ============================================================

        const workflowStepsResult = await transaction
            .request()
            .input(
                "stage_id",
                sql.Int,
                initialStage.stage_id
            )
            .query(`
                SELECT
                    workflow_step_id,
                    stage_id,
                    step_code,
                    step_name,
                    sort_order,
                    is_active
                FROM WorkflowSteps
                WHERE stage_id = @stage_id
                  AND is_active = 1
                ORDER BY
                    sort_order ASC,
                    workflow_step_id ASC
            `);

        const workflowSteps =
            workflowStepsResult.recordset;

        // ============================================================
        // 18. GENERATE CASE NUMBER
        // ============================================================

        const caseNumber = await generateCaseNumber(
            transaction,
            finalCenterCode
        );

        // ============================================================
        // 19. CREATE IMMIGRATION CASE
        // ============================================================

        const caseResult = await transaction
            .request()
            .input(
                "case_number",
                sql.VarChar(50),
                caseNumber
            )
            .input(
                "lead_id",
                sql.Int,
                parsedLeadId
            )
            .input(
                "program_id",
                sql.Int,
                parsedProgramId
            )
            .input(
                "assigned_to",
                sql.Int,
                finalAssignedTo !== null
                    ? Number(finalAssignedTo)
                    : null
            )
            .input(
                "center_code",
                sql.VarChar(50),
                finalCenterCode
            )
            .input(
                "opened_at",
                sql.DateTime,
                new Date()
            )
            .input(
                "remark",
                sql.NVarChar(sql.MAX),
                remark
            )
            .query(`
                INSERT INTO ImmigrationCases
                (
                    case_number,
                    lead_id,
                    program_id,
                    assigned_to,
                    center_code,
                    opened_at,
                    remark,
                    created_at,
                    updated_at
                )
                OUTPUT
                    INSERTED.case_id,
                    INSERTED.case_number,
                    INSERTED.lead_id,
                    INSERTED.program_id,
                    INSERTED.assigned_to,
                    INSERTED.center_code,
                    INSERTED.opened_at,
                    INSERTED.remark,
                    INSERTED.created_at,
                    INSERTED.updated_at
                VALUES
                (
                    @case_number,
                    @lead_id,
                    @program_id,
                    @assigned_to,
                    @center_code,
                    @opened_at,
                    @remark,
                    GETDATE(),
                    GETDATE()
                )
            `);

        if (caseResult.recordset.length === 0) {
            throw new Error(
                "Immigration case could not be created."
            );
        }

        const newCase = caseResult.recordset[0];
        const caseId = newCase.case_id;

        // ============================================================
        // 20. CREATE ONLY THE INITIAL CASE STAGE
        // ============================================================

        const caseStageResult = await transaction
            .request()
            .input(
                "case_id",
                sql.Int,
                caseId
            )
            .input(
                "stage_id",
                sql.Int,
                initialStage.stage_id
            )
            .input(
                "status",
                sql.VarChar(50),
                "In Progress"
            )
            .input(
                "assigned_to",
                sql.Int,
                finalAssignedTo !== null
                    ? Number(finalAssignedTo)
                    : null
            )
            .input(
                "started_at",
                sql.DateTime,
                new Date()
            )
            .input(
                "remarks",
                sql.NVarChar(sql.MAX),
                remark
            )
            .query(`
                INSERT INTO CaseStages
                (
                    case_id,
                    stage_id,
                    status,
                    assigned_to,
                    started_at,
                    remarks
                )
                OUTPUT
                    INSERTED.case_stage_id,
                    INSERTED.case_id,
                    INSERTED.stage_id,
                    INSERTED.status,
                    INSERTED.assigned_to,
                    INSERTED.started_at,
                    INSERTED.remarks
                VALUES
                (
                    @case_id,
                    @stage_id,
                    @status,
                    @assigned_to,
                    @started_at,
                    @remarks
                )
            `);

        if (caseStageResult.recordset.length === 0) {
            throw new Error(
                "Initial case stage could not be created."
            );
        }

        const caseStage =
            caseStageResult.recordset[0];

        // ============================================================
        // 21. CREATE WORKFLOW STEPS FOR INITIAL STAGE
        //
        // Steps are loaded dynamically from WorkflowSteps.
        //
        // First step = In Progress
        // Remaining steps = Pending
        // ============================================================

        let stepsCreated = 0;

        if (workflowSteps.length > 0) {
            for (
                let index = 0;
                index < workflowSteps.length;
                index++
            ) {
                const step = workflowSteps[index];

                const stepStatus =
                    index === 0
                        ? "In Progress"
                        : "Pending";

                const startedAt =
                    index === 0
                        ? new Date()
                        : null;

                await transaction
                    .request()
                    .input(
                        "case_id",
                        sql.Int,
                        caseId
                    )
                    .input(
                        "workflow_step_id",
                        sql.Int,
                        step.workflow_step_id
                    )
                    .input(
                        "step_status",
                        sql.VarChar(50),
                        stepStatus
                    )
                    .input(
                        "assigned_to",
                        sql.Int,
                        finalAssignedTo !== null
                            ? Number(finalAssignedTo)
                            : null
                    )
                    .input(
                        "started_at",
                        sql.DateTime,
                        startedAt
                    )
                    .query(`
                        INSERT INTO CaseSteps
                        (
                            case_id,
                            workflow_step_id,
                            step_status,
                            assigned_to,
                            started_at
                        )
                        VALUES
                        (
                            @case_id,
                            @workflow_step_id,
                            @step_status,
                            @assigned_to,
                            @started_at
                        )
                    `);

                stepsCreated++;
            }
        }

        // ============================================================
        // 22. STATUS HISTORY
        // ============================================================

        await transaction
            .request()
            .input(
                "lead_id",
                sql.Int,
                parsedLeadId
            )
            .input(
                "case_id",
                sql.Int,
                caseId
            )
            .input(
                "case_stage_id",
                sql.Int,
                caseStage.case_stage_id
            )
            .input(
                "entity_type",
                sql.VarChar(50),
                "CASE"
            )
            .input(
                "old_status",
                sql.VarChar(100),
                lead.lead_status_name || "New"
            )
            .input(
                "new_status",
                sql.VarChar(100),
                "Converted"
            )
            .input(
                "changed_by",
                sql.Int,
                parsedConvertedBy
            )
            .input(
                "remarks",
                sql.NVarChar(sql.MAX),
                "Lead converted into immigration case."
            )
            .query(`
                INSERT INTO StatusHistory
                (
                    lead_id,
                    case_id,
                    case_stage_id,
                    entity_type,
                    old_status,
                    new_status,
                    changed_by,
                    remarks,
                    changed_at
                )
                VALUES
                (
                    @lead_id,
                    @case_id,
                    @case_stage_id,
                    @entity_type,
                    @old_status,
                    @new_status,
                    @changed_by,
                    @remarks,
                    GETDATE()
                )
            `);

        // ============================================================
        // 23. CASE ASSIGNMENT HISTORY
        // ============================================================

        if (
            finalAssignedTo !== null &&
            finalAssignedTo !== undefined
        ) {
            await transaction
                .request()
                .input(
                    "case_id",
                    sql.Int,
                    caseId
                )
                .input(
                    "old_user_id",
                    sql.Int,
                    lead.assigned_to
                )
                .input(
                    "new_user_id",
                    sql.Int,
                    Number(finalAssignedTo)
                )
                .input(
                    "assigned_by",
                    sql.Int,
                    parsedConvertedBy
                )
                .input(
                    "remarks",
                    sql.NVarChar(sql.MAX),
                    "Initial case assignment during lead conversion."
                )
                .query(`
                    INSERT INTO CaseAssignmentHistory
                    (
                        case_id,
                        old_user_id,
                        new_user_id,
                        assigned_by,
                        remarks,
                        assigned_at
                    )
                    VALUES
                    (
                        @case_id,
                        @old_user_id,
                        @new_user_id,
                        @assigned_by,
                        @remarks,
                        GETDATE()
                    )
                `);
        }

        // ============================================================
        // 24. CASE PARTICIPANT
        // ============================================================

        if (
            finalAssignedTo !== null &&
            finalAssignedTo !== undefined
        ) {
            await transaction
                .request()
                .input(
                    "case_id",
                    sql.Int,
                    caseId
                )
                .input(
                    "user_id",
                    sql.Int,
                    Number(finalAssignedTo)
                )
                .input(
                    "participant_role",
                    sql.VarChar(50),
                    participantRole
                )
                .input(
                    "assigned_from",
                    sql.DateTime,
                    new Date()
                )
                .query(`
                    INSERT INTO CaseParticipants
                    (
                        case_id,
                        user_id,
                        participant_role,
                        assigned_from,
                        is_active,
                        created_at
                    )
                    VALUES
                    (
                        @case_id,
                        @user_id,
                        @participant_role,
                        @assigned_from,
                        1,
                        GETDATE()
                    )
                `);
        }

        // ============================================================
        // 25. PAYMENT
        // ============================================================

        let createdPayment = null;

        if (
            payment !== null &&
            payment !== undefined
        ) {
            const paymentAmount =
                Number(payment.amount);

            const paymentTypeId =
                payment.payment_type_id !== undefined &&
                    payment.payment_type_id !== null &&
                    payment.payment_type_id !== ""
                    ? Number(payment.payment_type_id)
                    : null;

            const receivedBy =
                payment.received_by !== undefined &&
                    payment.received_by !== null &&
                    payment.received_by !== ""
                    ? Number(payment.received_by)
                    : parsedConvertedBy;

            // --------------------------------------------------------
            // Validate payment receiver
            // --------------------------------------------------------

            const receivedByResult =
                await transaction
                    .request()
                    .input(
                        "user_id",
                        sql.Int,
                        receivedBy
                    )
                    .query(`
                        SELECT TOP 1
                            id
                        FROM Users
                        WHERE id = @user_id
                    `);

            if (
                receivedByResult.recordset.length === 0
            ) {
                throw new Error(
                    `Payment received_by user ${receivedBy} does not exist.`
                );
            }

            // --------------------------------------------------------
            // Payment date
            // --------------------------------------------------------

            const paymentDate =
                payment.payment_date
                    ? new Date(
                        payment.payment_date
                    )
                    : new Date();

            if (
                Number.isNaN(
                    paymentDate.getTime()
                )
            ) {
                throw new Error(
                    "Invalid payment_date."
                );
            }

            // --------------------------------------------------------
            // Duplicate transaction reference
            // --------------------------------------------------------

            if (
                payment.transaction_reference !==
                undefined &&
                payment.transaction_reference !==
                null &&
                payment.transaction_reference !== ""
            ) {
                const transactionExists =
                    await transaction
                        .request()
                        .input(
                            "transaction_reference",
                            sql.VarChar(255),
                            payment.transaction_reference
                        )
                        .query(`
                            SELECT TOP 1
                                payment_id
                            FROM Payments
                            WHERE transaction_reference =
                                @transaction_reference
                        `);

                if (
                    transactionExists.recordset
                        .length > 0
                ) {
                    throw new Error(
                        `Payment transaction reference '${payment.transaction_reference}' already exists.`
                    );
                }
            }

            // --------------------------------------------------------
            // Insert payment
            // --------------------------------------------------------

            const paymentResult =
                await transaction
                    .request()
                    .input(
                        "lead_id",
                        sql.Int,
                        parsedLeadId
                    )
                    .input(
                        "case_id",
                        sql.Int,
                        caseId
                    )
                    .input(
                        "payment_type_id",
                        sql.Int,
                        paymentTypeId
                    )
                    .input(
                        "receipt_number",
                        sql.VarChar(100),
                        payment.receipt_number ||
                        null
                    )
                    .input(
                        "amount",
                        sql.Decimal(18, 2),
                        paymentAmount
                    )
                    .input(
                        "currency_code",
                        sql.VarChar(10),
                        payment.currency_code ||
                        "CAD"
                    )
                    .input(
                        "payment_method",
                        sql.VarChar(50),
                        payment.payment_method ||
                        null
                    )
                    .input(
                        "payment_status",
                        sql.VarChar(50),
                        payment.payment_status ||
                        "Paid"
                    )
                    .input(
                        "transaction_reference",
                        sql.VarChar(255),
                        payment.transaction_reference ||
                        null
                    )
                    .input(
                        "payment_date",
                        sql.DateTime,
                        paymentDate
                    )
                    .input(
                        "received_by",
                        sql.Int,
                        receivedBy
                    )
                    .input(
                        "remarks",
                        sql.NVarChar(sql.MAX),
                        payment.remarks || null
                    )
                    .query(`
                        INSERT INTO Payments
                        (
                            lead_id,
                            case_id,
                            payment_type_id,
                            receipt_number,
                            amount,
                            currency_code,
                            payment_method,
                            payment_status,
                            transaction_reference,
                            payment_date,
                            received_by,
                            remarks,
                            created_at,
                            updated_at
                        )
                        OUTPUT
                            INSERTED.payment_id,
                            INSERTED.lead_id,
                            INSERTED.case_id,
                            INSERTED.payment_type_id,
                            INSERTED.receipt_number,
                            INSERTED.amount,
                            INSERTED.currency_code,
                            INSERTED.payment_method,
                            INSERTED.payment_status,
                            INSERTED.transaction_reference,
                            INSERTED.payment_date,
                            INSERTED.received_by,
                            INSERTED.remarks,
                            INSERTED.created_at,
                            INSERTED.updated_at
                        VALUES
                        (
                            @lead_id,
                            @case_id,
                            @payment_type_id,
                            @receipt_number,
                            @amount,
                            @currency_code,
                            @payment_method,
                            @payment_status,
                            @transaction_reference,
                            @payment_date,
                            @received_by,
                            @remarks,
                            GETDATE(),
                            GETDATE()
                        )
                    `);

            if (
                paymentResult.recordset.length > 0
            ) {
                createdPayment =
                    paymentResult.recordset[0];
            }
        }

        // ============================================================
        // 26. UPDATE LEAD
        //
        // Keep existing application behavior:
        // is_converted = 1
        // lead_status = 7
        // ============================================================

        await transaction
            .request()
            .input(
                "lead_id",
                sql.Int,
                parsedLeadId
            )
            .query(`
                UPDATE Leads
                SET
                    is_converted = 1,
                    lead_status = 7,
                    updated_at = GETDATE()
                WHERE lead_id = @lead_id
            `);

        // ============================================================
        // 27. ACTIVITY LOG
        // ============================================================

        let activityDescription =
            `Lead ${parsedLeadId} converted into case ${caseNumber}.`;

        activityDescription +=
            ` Immigration program: ${selectedProgram.program_name}.`;

        activityDescription +=
            ` Initial stage: ${initialStage.stage_name}.`;

        if (createdPayment) {
            activityDescription +=
                ` Payment of ${createdPayment.amount} ${createdPayment.currency_code} was recorded.`;
        }

        await transaction
            .request()
            .input(
                "lead_id",
                sql.Int,
                parsedLeadId
            )
            .input(
                "case_id",
                sql.Int,
                caseId
            )
            .input(
                "user_id",
                sql.Int,
                parsedConvertedBy
            )
            .input(
                "activity_type",
                sql.VarChar(100),
                createdPayment
                    ? "LEAD_CONVERTED_WITH_PAYMENT"
                    : "LEAD_CONVERTED"
            )
            .input(
                "entity_type",
                sql.VarChar(50),
                "CASE"
            )
            .input(
                "entity_id",
                sql.Int,
                caseId
            )
            .input(
                "old_value",
                sql.NVarChar(sql.MAX),
                "Lead"
            )
            .input(
                "new_value",
                sql.NVarChar(sql.MAX),
                createdPayment
                    ? "ImmigrationCase + Payment"
                    : "ImmigrationCase"
            )
            .input(
                "description",
                sql.NVarChar(sql.MAX),
                activityDescription
            )
            .input(
                "ip_address",
                sql.VarChar(100),
                req.ip || null
            )
            .input(
                "user_agent",
                sql.NVarChar(500),
                req.get("user-agent") || null
            )
            .query(`
                INSERT INTO ActivityLogs
                (
                    lead_id,
                    case_id,
                    user_id,
                    activity_type,
                    entity_type,
                    entity_id,
                    old_value,
                    new_value,
                    description,
                    ip_address,
                    user_agent,
                    created_at
                )
                VALUES
                (
                    @lead_id,
                    @case_id,
                    @user_id,
                    @activity_type,
                    @entity_type,
                    @entity_id,
                    @old_value,
                    @new_value,
                    @description,
                    @ip_address,
                    @user_agent,
                    GETDATE()
                )
            `);

        // ============================================================
        // 28. COMMIT
        // ============================================================

        await transaction.commit();
        transactionStarted = false;

        // ============================================================
        // 29. RESPONSE
        // ============================================================

        return res.status(201).json({
            success: true,

            message: createdPayment
                ? "Lead successfully converted into immigration case and payment recorded."
                : "Lead successfully converted into immigration case.",

            data: {
                case_id: caseId,
                case_number: caseNumber,
                lead_id: parsedLeadId,

                program: {
                    program_id:
                        selectedProgram.program_id,
                    program_name:
                        selectedProgram.program_name
                },

                assigned_to:
                    finalAssignedTo !== null
                        ? Number(finalAssignedTo)
                        : null,

                center_code: finalCenterCode,

                stage: {
                    case_stage_id:
                        caseStage.case_stage_id,
                    stage_id:
                        initialStage.stage_id,
                    stage_code:
                        initialStage.stage_code,
                    stage_name:
                        initialStage.stage_name,
                    stage_no:
                        initialStage.stage_no,
                    department:
                        initialStage.department,
                    status:
                        caseStage.status
                },

                steps_created: stepsCreated,

                payment: createdPayment
                    ? {
                        payment_id:
                            createdPayment.payment_id,
                        payment_type_id:
                            createdPayment.payment_type_id,
                        receipt_number:
                            createdPayment.receipt_number,
                        amount:
                            createdPayment.amount,
                        currency_code:
                            createdPayment.currency_code,
                        payment_method:
                            createdPayment.payment_method,
                        payment_status:
                            createdPayment.payment_status,
                        transaction_reference:
                            createdPayment.transaction_reference,
                        payment_date:
                            createdPayment.payment_date,
                        received_by:
                            createdPayment.received_by,
                        remarks:
                            createdPayment.remarks
                    }
                    : null
            }
        });
    } catch (error) {
        // ============================================================
        // 30. ROLLBACK TRANSACTION
        // ============================================================

        if (
            transaction &&
            transactionStarted
        ) {
            try {
                await transaction.rollback();
            } catch (rollbackError) {
                console.error(
                    "Transaction rollback failed:",
                    rollbackError
                );
            }
        }

        console.error(
            "convertLeadtoCase Error:",
            error
        );

        return next(error);
    }
};





function participantRoleOrFallback(role) {
    return role || 'Primary Case Officer';
}


// ---------------------------- COMMON CONTROLLER FOR ADMIN / SUPER ADMIN / AGENT --------END------------------------------------- //








// -------------------------------------- AGENT SPECIFIC CONTROLLERS ----------------START-------------------------------- //


// Gell Leads for agent
export const getAgentLeads = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const centerCode = req.user?.center_code;

        if (!userId || !centerCode) {
            return res.status(401).json({
                success: false,
                message: 'User authentication or center information missing'
            });
        }

        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(
            Math.max(parseInt(req.query.limit) || 20, 1),
            100
        );

        const offset = (page - 1) * limit;

        const pool = await poolPromise;

        const request = pool.request();

        request.input('user_id', sql.Int, userId);
        request.input('center_code', sql.NVarChar(50), centerCode);
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limit);

        const result = await request.query(`
            SELECT
                L.lead_id,
                L.lead_number,
                L.first_name,
                L.middle_name,
                L.last_name,
                L.full_name,
                L.mobile_number,
                L.alt_phone_number,
                L.email_address,
                L.alt_email,
                L.source,
                L.lead_status,
                LS.status_name,
                L.center_code,
                L.assigned_to,
                L.is_converted,
                L.remark,
                L.created_at,
                L.updated_at
            FROM Leads L
            LEFT JOIN LeadStatuses LS
                ON L.lead_status = LS.id
            WHERE
                L.assigned_to = @user_id
                AND L.center_code = @center_code
                AND L.is_converted = 0
            ORDER BY L.created_at DESC
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY;

            SELECT COUNT(*) AS total
            FROM Leads
            WHERE
                assigned_to = @user_id
                AND center_code = @center_code
                AND is_converted = 0;
        `);

        const total = result.recordsets[1][0].total;

        return res.status(200).json({
            success: true,
            data: result.recordsets[0],
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        next(error);
    }
};


// Search Leads for agent
export const searchAgentLeads = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const centerCode = req.user?.center_code;
        const search = req.query.search?.trim();

        if (!userId || !centerCode) {
            return res.status(401).json({
                success: false,
                message: 'User authentication or center information missing'
            });
        }

        if (!search) {
            return res.status(400).json({
                success: false,
                message: 'Search value is required'
            });
        }

        const page = Math.max(parseInt(req.query.page) || 1, 1);

        const limit = Math.min(
            Math.max(parseInt(req.query.limit) || 20, 1),
            100
        );

        const offset = (page - 1) * limit;

        const pool = await poolPromise;
        const request = pool.request();

        request.input('user_id', sql.Int, userId);
        request.input('center_code', sql.NVarChar(50), centerCode);
        request.input('search', sql.NVarChar(150), `%${search}%`);
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limit);

        const result = await request.query(`
            SELECT
                L.lead_id,
                L.lead_number,
                L.first_name,
                L.middle_name,
                L.last_name,
                L.full_name,
                L.mobile_number,
                L.alt_phone_number,
                L.email_address,
                L.alt_email,
                L.source,
                L.lead_status,
                LS.status_name,
                L.center_code,
                L.assigned_to,
                L.is_converted,
                L.remark,
                L.created_at,
                L.updated_at
            FROM Leads L
            LEFT JOIN LeadStatuses LS
                ON L.lead_status = LS.id
            WHERE
                L.assigned_to = @user_id
                AND L.center_code = @center_code
                AND L.is_converted = 0
                AND (
                    L.lead_number LIKE @search
                    OR L.first_name LIKE @search
                    OR L.middle_name LIKE @search
                    OR L.last_name LIKE @search
                    OR L.full_name LIKE @search
                    OR L.mobile_number LIKE @search
                    OR L.alt_phone_number LIKE @search
                    OR L.email_address LIKE @search
                    OR L.alt_email LIKE @search
                )
            ORDER BY L.created_at DESC
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY;

            SELECT COUNT(*) AS total
            FROM Leads
            WHERE
                assigned_to = @user_id
                AND center_code = @center_code
                AND is_converted = 0
                AND (
                    lead_number LIKE @search
                    OR first_name LIKE @search
                    OR middle_name LIKE @search
                    OR last_name LIKE @search
                    OR full_name LIKE @search
                    OR mobile_number LIKE @search
                    OR alt_phone_number LIKE @search
                    OR email_address LIKE @search
                    OR alt_email LIKE @search
                );
        `);

        const total = result.recordsets[1][0].total;

        return res.status(200).json({
            success: true,
            data: result.recordsets[0],
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Error in searchAgentLeads:', error);
    }
};


// Filter Leads for agent
export const filterAgentLeads = async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const centerCode = req.user?.center_code;

        const leadStatus =
            req.query.lead_status !== undefined
                ? parseInt(req.query.lead_status, 10)
                : null;

        if (!userId || !centerCode) {
            return res.status(401).json({
                success: false,
                message: 'User authentication or center information missing'
            });
        }

        // lead_status is required for this API
        if (leadStatus === null) {
            return res.status(400).json({
                success: false,
                message: 'Provide lead_status'
            });
        }

        if (!Number.isInteger(leadStatus)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid lead_status'
            });
        }

        const page = Math.max(
            parseInt(req.query.page, 10) || 1,
            1
        );

        const limit = Math.min(
            Math.max(
                parseInt(req.query.limit, 10) || 20,
                1
            ),
            100
        );

        const offset = (page - 1) * limit;

        const pool = await poolPromise;

        const request = pool.request();

        request.input('user_id', sql.Int, userId);
        request.input('center_code', sql.NVarChar(50), centerCode);
        request.input('lead_status', sql.Int, leadStatus);
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limit);

        const result = await request.query(`
            SELECT
                L.lead_id,
                L.lead_number,
                L.first_name,
                L.middle_name,
                L.last_name,
                L.full_name,
                L.mobile_number,
                L.alt_phone_number,
                L.email_address,
                L.alt_email,
                L.source,
                L.lead_status,
                LS.status_name,
                L.center_code,
                L.assigned_to,
                L.is_converted,
                L.remark,
                L.created_at,
                L.updated_at
            FROM Leads AS L
            LEFT JOIN LeadStatuses AS LS
                ON L.lead_status = LS.id
            WHERE
                L.assigned_to = @user_id
                AND L.center_code = @center_code
                AND L.is_converted = 0
                AND L.lead_status = @lead_status
            ORDER BY L.created_at DESC
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY;

            SELECT COUNT(*) AS total
            FROM Leads AS L
            WHERE
                L.assigned_to = @user_id
                AND L.center_code = @center_code
                AND L.is_converted = 0
                AND L.lead_status = @lead_status;
        `);

        const leads = result.recordsets[0];
        const total = result.recordsets[1][0]?.total || 0;

        return res.status(200).json({
            success: true,
            data: leads,
            filters: {
                lead_status: leadStatus
            },
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Error in filterAgentLeads:', error);

        return res.status(500).json({
            success: false,
            message: 'Failed to filter agent leads',
            error: error.message
        });
    }
};



// Lead status count


// -------------------------------------- AGENT SPECIFIC CONTROLLERS ----------------END-------------------------------- //







