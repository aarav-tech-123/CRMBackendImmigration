import { sql } from '../config/db.js';

export const createActivityLog = async ({
    transaction,
    leadId,
    caseId = null,
    userId,
    activityType,
    entityType = 'LEAD',
    entityId = null,
    oldValue = null,
    newValue = null,
    description,
    ipAddress = null,
    userAgent = null
}) => {

    if (!transaction) {
        throw new Error('SQL transaction is required');
    }

    const request = new sql.Request(transaction);

    request.input(
        'lead_id',
        sql.Int,
        leadId
    );

    request.input(
        'case_id',
        sql.Int,
        caseId
    );

    request.input(
        'user_id',
        sql.Int,
        userId
    );

    request.input(
        'activity_type',
        sql.NVarChar(100),
        activityType
    );

    request.input(
        'entity_type',
        sql.NVarChar(100),
        entityType
    );

    request.input(
        'entity_id',
        sql.Int,
        entityId
    );

    request.input(
        'old_value',
        sql.NVarChar(sql.MAX),
        oldValue
    );

    request.input(
        'new_value',
        sql.NVarChar(sql.MAX),
        newValue
    );

    request.input(
        'description',
        sql.NVarChar(sql.MAX),
        description
    );

    request.input(
        'ip_address',
        sql.NVarChar(100),
        ipAddress
    );

    request.input(
        'user_agent',
        sql.NVarChar(1000),
        userAgent
    );

    await request.query(`
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
};