import XLSX from "xlsx";
import { sql, poolPromise } from "../../config/db.js";
import { createActivityLog } from "../../helpers/activityLogs.js";
import { getRequestInfo } from "../../helpers/requestInfo.js";

/**
 * Maps every recognised spreadsheet header (after normalization) to a
 * canonical field name. Headers are matched by NAME, never by column
 * position, so columns can appear in any order in the source file.
 */
const HEADER_SYNONYMS = {
    lead_date: "lead_date",

    created_time: "created_time",
    created_at: "created_time",

    english_proficiency_level: "english_proficiency_level",
    english_proficiency: "english_proficiency_level",

    total_work_experience: "total_work_experience",
    work_experience: "total_work_experience",
    years_of_experience: "total_work_experience",

    income_band_per_month: "income_band",
    income_band: "income_band",
    monthly_income: "income_band",

    country_of_residence: "country_of_residence",
    country: "country_of_residence",

    education: "education",
    highest_education: "education",
    qualification: "education",

    first_name: "first_name",
    firstname: "first_name",

    last_name: "last_name",
    lastname: "last_name",

    phone_number: "phone_number",
    phone: "phone_number",
    mobile_number: "phone_number",
    mobile: "phone_number",

    job_title: "job_title",
    jobtitle: "job_title",
    designation: "job_title",
    industry_area: "job_title",

    email: "email",
    email_address: "email",

    lead_status: "lead_status",
    status: "lead_status",

    assigned_to: "assigned_to",
    assigned_agent: "assigned_to",
    agent: "assigned_to",

    remarks: "remarks",
    remark: "remarks"
};

/**
 * Normalizes a raw Excel header into a lookup key:
 * lowercase, trim, and collapse anything that isn't a letter/digit
 * into a single underscore.
 *
 * e.g. "Income Band (Per Month)" -> "income_band_per_month"
 *      "english_proficiency_level_"  -> "english_proficiency_level"
 */
const normalizeHeader = (header) => {
    return String(header ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
};

/**
 * Builds a { columnIndex -> canonicalField } map from the header row,
 * so each cell is read by what its header says, not by its position.
 */
const buildColumnMap = (headerRow) => {
    const columnMap = {};

    headerRow.forEach((rawHeader, index) => {
        const normalized = normalizeHeader(rawHeader);
        const field = HEADER_SYNONYMS[normalized];

        if (field) {
            columnMap[index] = field;
        }
    });

    return columnMap;
};

const toTrimmedStringOrNull = (value) => {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    return str === "" ? null : str;
};

/**
 * Pulls the first number out of free-text experience values like
 * "5 years", "3-5", "2.5" -> 5, 3, 2.5
 */
const extractNumber = (value) => {
    const str = toTrimmedStringOrNull(value);
    if (str === null) return null;

    const match = str.match(/[\d.]+/);
    if (!match) return null;

    const num = parseFloat(match[0]);
    return Number.isFinite(num) ? num : null;
};

const toDateOrNull = (value) => {
    if (value === null || value === undefined || value === "") return null;

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * Converts the header row + one data row into a { canonicalField: value }
 * object, using the column map built from header names.
 */
const mapRowToFields = (columnMap, rowValues) => {
    const row = {};

    Object.entries(columnMap).forEach(([index, field]) => {
        row[field] = rowValues[Number(index)] ?? null;
    });

    return row;
};

const generateLeadNumber = (leadId) => {
    const now = new Date();

    const day = String(now.getDate()).padStart(2, "0");
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const year = String(now.getFullYear()).slice(-2);

    return `L${leadId}-${day}${month}${year}`;
};

/**
 * Import Leads from an uploaded Excel/CSV file.
 *
 * Columns are matched by header NAME (case/spacing/punctuation
 * insensitive), never by column order. Unmatched/extra columns are
 * ignored. Each row is imported in its own transaction so a bad row
 * doesn't block the rest of the file.
 *
 * Populates:
 *  - Leads (first_name, last_name, phone_number -> mobile_number,
 *    email -> email_address, english_proficiency_level, lead_status,
 *    assigned_to, remark, created_at)
 *  - LeadEducation (education -> highest_level)
 *  - LeadWorkExperience (total_work_experience -> years_of_experience,
 *    job_title -> industry_area)
 *  - LeadAddress (country_of_residence -> country)
 *
 * POST /api/v1/leads/import  (multipart/form-data, field name: "file")
 */
export const importLeadsFromExcel = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No file uploaded. Attach an Excel/CSV file under field 'file'."
            });
        }

        const workbook = XLSX.read(req.file.buffer, {
            type: "buffer",
            cellDates: true
        });

        const sheetName = workbook.SheetNames[0];

        if (!sheetName) {
            return res.status(400).json({
                success: false,
                message: "The uploaded file does not contain any sheets."
            });
        }

        const sheet = workbook.Sheets[sheetName];

        const rows = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            defval: null,
            raw: true
        });

        if (rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "The uploaded sheet is empty."
            });
        }

        const [headerRow, ...dataRows] = rows;

        const columnMap = buildColumnMap(headerRow);

        if (Object.keys(columnMap).length === 0) {
            return res.status(400).json({
                success: false,
                message: "None of the columns in the sheet could be recognized. Check the header row."
            });
        }

        const pool = await poolPromise;
        const { ipAddress, userAgent } = getRequestInfo(req);
        const userId = req.user?.id || req.user?.user_id || null;

        /*
         * Pre-fetch LeadStatuses and Users ONCE so "lead_status" and
         * "Assigned To" text values can be resolved to IDs without
         * a DB round trip per row.
         */
        const statusResult = await pool
            .request()
            .query(`SELECT id, status_name FROM LeadStatuses`);

        const statusByName = new Map(
            statusResult.recordset.map((s) => [
                normalizeHeader(s.status_name),
                s.id
            ])
        );

        const usersResult = await pool
            .request()
            .query(`SELECT id, name, email FROM Users`);

        const userByNameOrEmail = new Map();

        usersResult.recordset.forEach((u) => {
            if (u.name) {
                userByNameOrEmail.set(normalizeHeader(u.name), u.id);
            }
            if (u.email) {
                userByNameOrEmail.set(
                    String(u.email).trim().toLowerCase(),
                    u.id
                );
            }
        });

        const imported = [];
        const skipped = [];
        const errors = [];

        for (let i = 0; i < dataRows.length; i++) {
            const rowNumber = i + 2; // +1 for 0-index, +1 for header row
            const rawRow = dataRows[i];

            // Skip completely blank rows
            if (!rawRow || rawRow.every((cell) => cell === null || cell === "")) {
                continue;
            }

            const fields = mapRowToFields(columnMap, rawRow);

            const firstName = toTrimmedStringOrNull(fields.first_name);
            const lastName = toTrimmedStringOrNull(fields.last_name);

            if (!firstName || !lastName) {
                skipped.push({
                    row: rowNumber,
                    reason: "Missing required first_name/last_name"
                });
                continue;
            }

            const fullName = [firstName, lastName]
                .filter(Boolean)
                .join(" ");

            const phoneNumber = toTrimmedStringOrNull(fields.phone_number);
            const email = toTrimmedStringOrNull(fields.email);
            const englishProficiency = toTrimmedStringOrNull(
                fields.english_proficiency_level
            );

            const leadStatusText = toTrimmedStringOrNull(fields.lead_status);
            const leadStatusId = leadStatusText
                ? statusByName.get(normalizeHeader(leadStatusText)) || null
                : null;

            const assignedToText = toTrimmedStringOrNull(fields.assigned_to);
            const assignedToId = assignedToText
                ? userByNameOrEmail.get(normalizeHeader(assignedToText)) ||
                  userByNameOrEmail.get(assignedToText.toLowerCase()) ||
                  null
                : null;

            const incomeBand = toTrimmedStringOrNull(fields.income_band);
            const remarksText = toTrimmedStringOrNull(fields.remarks);

            const remarkParts = [];
            if (incomeBand) remarkParts.push(`Income Band (per month): ${incomeBand}`);
            if (remarksText) remarkParts.push(remarksText);
            const remark = remarkParts.length ? remarkParts.join(" | ") : null;

            const createdAt =
                toDateOrNull(fields.created_time) ||
                toDateOrNull(fields.lead_date) ||
                new Date();

            const education = toTrimmedStringOrNull(fields.education);
            const jobTitle = toTrimmedStringOrNull(fields.job_title);
            const totalWorkExperience = extractNumber(
                fields.total_work_experience
            );
            const countryOfResidence = toTrimmedStringOrNull(
                fields.country_of_residence
            );

            const transaction = new sql.Transaction(pool);

            try {
                await transaction.begin();

                const leadResult = await new sql.Request(transaction)
                    .input("first_name", sql.NVarChar(100), firstName)
                    .input("last_name", sql.NVarChar(100), lastName)
                    .input("full_name", sql.NVarChar(250), fullName)
                    .input("mobile_number", sql.NVarChar(30), phoneNumber)
                    .input("email_address", sql.NVarChar(150), email)
                    .input("source", sql.NVarChar(150), "Excel Import")
                    .input("lead_status", sql.Int, leadStatusId)
                    .input("assigned_to", sql.Int, assignedToId)
                    .input("is_converted", sql.Bit, 0)
                    .input("is_connected", sql.Bit, 0)
                    .input(
                        "english_proficiency_level",
                        sql.NVarChar(50),
                        englishProficiency
                    )
                    .input("remark", sql.NVarChar(sql.MAX), remark)
                    .input("created_at", sql.DateTime, createdAt)
                    .query(`
                        INSERT INTO dbo.Leads (
                            first_name,
                            last_name,
                            full_name,
                            mobile_number,
                            email_address,
                            source,
                            lead_status,
                            assigned_to,
                            is_converted,
                            is_connected,
                            english_proficiency_level,
                            remark,
                            created_at,
                            updated_at
                        )
                        OUTPUT inserted.lead_id
                        VALUES (
                            @first_name,
                            @last_name,
                            @full_name,
                            @mobile_number,
                            @email_address,
                            @source,
                            @lead_status,
                            @assigned_to,
                            @is_converted,
                            @is_connected,
                            @english_proficiency_level,
                            @remark,
                            @created_at,
                            GETDATE()
                        )
                    `);

                const leadId = leadResult.recordset[0].lead_id;
                const leadNumber = generateLeadNumber(leadId);

                await new sql.Request(transaction)
                    .input("lead_id", sql.Int, leadId)
                    .input("lead_number", sql.NVarChar(50), leadNumber)
                    .query(`
                        UPDATE dbo.Leads
                        SET
                            lead_number = @lead_number,
                            updated_at = GETDATE()
                        WHERE lead_id = @lead_id
                    `);

                if (education) {
                    await new sql.Request(transaction)
                        .input("lead_id", sql.Int, leadId)
                        .input("highest_level", sql.NVarChar(100), education)
                        .query(`
                            INSERT INTO LeadEducation (
                                lead_id,
                                highest_level,
                                created_at,
                                updated_at
                            )
                            VALUES (
                                @lead_id,
                                @highest_level,
                                GETDATE(),
                                GETDATE()
                            )
                        `);
                }

                if (jobTitle || totalWorkExperience !== null) {
                    await new sql.Request(transaction)
                        .input("lead_id", sql.Int, leadId)
                        .input("industry_area", sql.NVarChar(255), jobTitle)
                        .input(
                            "years_of_experience",
                            sql.Decimal(10, 2),
                            totalWorkExperience
                        )
                        .query(`
                            INSERT INTO LeadWorkExperience (
                                lead_id,
                                industry_area,
                                years_of_experience,
                                created_at,
                                updated_at
                            )
                            VALUES (
                                @lead_id,
                                @industry_area,
                                @years_of_experience,
                                GETDATE(),
                                GETDATE()
                            )
                        `);
                }

                if (countryOfResidence) {
                    await new sql.Request(transaction)
                        .input("lead_id", sql.Int, leadId)
                        .input("address_type", sql.VarChar(50), "Current")
                        .input("country", sql.VarChar(100), countryOfResidence)
                        .input("is_primary", sql.Bit, 1)
                        .query(`
                            INSERT INTO LeadAddresses (
                                lead_id,
                                address_type,
                                country,
                                is_primary,
                                created_at,
                                updated_at
                            )
                            VALUES (
                                @lead_id,
                                @address_type,
                                @country,
                                @is_primary,
                                GETDATE(),
                                GETDATE()
                            )
                        `);
                }

                await createActivityLog({
                    transaction,
                    leadId,
                    userId,
                    activityType: "IMPORT",
                    entityType: "LEAD",
                    entityId: leadId,
                    oldValue: null,
                    newValue: JSON.stringify({
                        first_name: firstName,
                        last_name: lastName,
                        email_address: email,
                        mobile_number: phoneNumber
                    }),
                    description: `Lead ${leadNumber} imported from Excel (row ${rowNumber})`,
                    ipAddress,
                    userAgent
                });

                await transaction.commit();

                imported.push({
                    row: rowNumber,
                    lead_id: leadId,
                    lead_number: leadNumber
                });

            } catch (rowError) {
                try {
                    await transaction.rollback();
                } catch (rollbackError) {
                    console.error("Import row rollback failed:", rollbackError);
                }

                errors.push({
                    row: rowNumber,
                    reason: rowError.message || "Unknown error"
                });
            }
        }

        return res.status(200).json({
            success: true,
            message: "Lead import completed",
            summary: {
                total_rows: dataRows.length,
                imported: imported.length,
                skipped: skipped.length,
                failed: errors.length
            },
            imported,
            skipped,
            errors
        });

    } catch (error) {
        next(error);
    }
};
