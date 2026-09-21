import sql from "mssql";
import { poolPromise } from "../config/db.js";

export const getMyImmigrationCases = async (req, res, next) => {
    try {
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized. User ID not found."
            });
        }

        const page = Math.max(
            parseInt(req.query.page, 10) || 1,
            1
        );

        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || 10, 1),
            100
        );

        const offset = (page - 1) * limit;

        const programId = req.query.program_id ? parseInt(req.query.program_id, 10) : null;
        if (req.query.program_id && (!Number.isInteger(programId) || programId <= 0)) {
            return res.status(400).json({
                success: false,
                message: "program_id must be a valid positive integer."
            });
        }

        const pool = await poolPromise;

        const request = pool.request();

        request.input("userId", sql.Int, userId);
        request.input("programId", sql.Int, programId);
        request.input("offset", sql.Int, offset);
        request.input("limit", sql.Int, limit);

        const result = await request.query(`
            SELECT
                ic.case_id,
                ic.case_number,
                ic.lead_id,
                ic.program_id,
                ic.assigned_to,
                ic.center_code,
                ic.opened_at,
                ic.closed_at,
                ic.remark,
                ic.created_at,
                ic.updated_at,

                -- Immigration Program
                ip.program_name,

                -- Lead
                l.first_name,
                l.middle_name,
                l.last_name,
                l.alt_email,
                l.email_address,
                l.alt_phone_number,
                l.mobile_number,

                -- Assigned User
                u.id AS assigned_user_id,
                u.name AS assigned_user_name,


                latestStage.stage_id,
                latestStage.status AS stage_status,
                latestStage.assigned_to AS stage_assigned_to,
                latestStage.started_at AS stage_started_at,
                latestStage.completed_at AS stage_completed_at,
                latestStage.remarks AS stage_remarks,

                ws.stage_name,

                COUNT(*) OVER() AS total_count

            FROM ImmigrationCases AS ic

            LEFT JOIN ImmigrationPrograms AS ip
                ON ip.program_id = ic.program_id

            LEFT JOIN Leads AS l
                ON l.lead_id = ic.lead_id

            LEFT JOIN Users AS u
                ON u.id = ic.assigned_to

            OUTER APPLY (
            SELECT TOP 1
                cs.stage_id,
                cs.status,
                cs.assigned_to,
                cs.started_at,
                cs.completed_at,
                cs.remarks
            FROM CaseStages AS cs
            WHERE cs.case_id = ic.case_id
            ORDER BY
                cs.created_at DESC,
                cs.case_stage_id DESC
            ) AS latestStage

            LEFT JOIN WorkflowStages AS ws
                ON ws.stage_id = latestStage.stage_id

            WHERE ic.assigned_to = @userId
              AND (@programId IS NULL OR ic.program_id = @programId)

            ORDER BY ic.created_at DESC

            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY;
        `);

        const total =
            result.recordset.length > 0
                ? Number(result.recordset[0].total_count)
                : 0;

        const data = result.recordset.map(
            ({ total_count, ...caseData }) => caseData
        );

        return res.status(200).json({
            success: true,
            message: "Immigration cases retrieved successfully.",
            data,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error(
            "getMyImmigrationCases Error:",
            error
        );

        next(error);
    }
};



export const getImmigrationCaseById = async (req, res, next) => {
    try {
        const { caseId } = req.params;

        const pool = await poolPromise;

        const request = pool.request();
        request.input("caseId", sql.Int, caseId);

        const result = await request.query(`
            SELECT
                ic.case_id,
                ic.case_number,
                ic.lead_id,
                ic.program_id,
                ic.assigned_to,
                ic.center_code,
                ic.opened_at,
                ic.closed_at,
                ic.remark,
                ic.created_at,
                ic.updated_at,

                -- Immigration Program
                ip.program_name,
                -- Lead
                l.first_name,
                l.middle_name,
                l.last_name,
                l.alt_email,
                l.email_address,
                l.alt_phone_number,
                l.mobile_number,
                -- Assigned User
                u.id AS assigned_user_id,
                u.name AS assigned_user_name,

                latestStage.stage_id,
                latestStage.status AS stage_status,
                latestStage.assigned_to AS stage_assigned_to,
                latestStage.started_at AS stage_started_at,
                latestStage.completed_at AS stage_completed_at,
                latestStage.remarks AS stage_remarks,
                ws.stage_name

            FROM ImmigrationCases AS ic
            LEFT JOIN ImmigrationPrograms AS ip
                ON ip.program_id = ic.program_id
            LEFT JOIN Leads AS l
                ON l.lead_id = ic.lead_id
            LEFT JOIN Users AS u
                ON u.id = ic.assigned_to
            OUTER APPLY (
                SELECT TOP 1
                    cs.stage_id,
                    cs.status,
                    cs.assigned_to,
                    cs.started_at,
                    
                    cs.completed_at,
                    cs.remarks
                FROM CaseStages AS cs
                WHERE cs.case_id = ic.case_id
                ORDER BY
                    cs.created_at DESC,
                    cs.case_stage_id DESC
            ) AS latestStage
            LEFT JOIN WorkflowStages AS ws
                ON ws.stage_id = latestStage.stage_id
            WHERE ic.case_id = @caseId;
        `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Immigration case not found."
            });
        }

        const immigrationCase = result.recordset[0];

        return res.status(200).json({
            success: true,
            message: "Immigration case retrieved successfully.",
            data: immigrationCase
        });

    } catch (error) {
        console.error(
            "getImmigrationCaseById Error:",
            error
        );

        next(error);
    }
};



