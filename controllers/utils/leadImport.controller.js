import XLSX from "xlsx";
import { sql, poolPromise } from "../../config/db.js";
import { createActivityLog } from "../../helpers/activityLogs.js";
import { getRequestInfo } from "../../helpers/requestInfo.js";
import {
    LEAD_CAMPAIGN_TEXT_FIELDS,
    DEFAULT_CAMPAIGN_COUNTRY,
    detectCampaignType,
    normalizeCampaignType,
    normalizePhone,
    mergeRebuttals,
    IGNORED_SHEET_HEADERS
} from "../../helpers/leadCampaigns.js";

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

    disposition: "disposition",

    id: "meta_lead_id",
    form_id: "meta_form_id",
    form_name: "meta_form_name",
    is_organic: "meta_is_organic",
    platform: "meta_platform",
    campaign_name: "meta_campaign_name",

    nationality: "nationality",
    conditional_question_1: "conditional_question_1",

    // Special Healthcare form questions
    what_is_your_current_healthcare_profession: "healthcare_profession",
    how_many_years_of_relevant_work_experience_do_you_have: "total_work_experience",
    what_is_your_highest_completed_qualification: "education",
    have_you_taken_an_approved_english_or_french_language_test: "language_test_taken",
    when_are_you_planning_to_explore_moving_to_canada: "planned_move_timeline",

    work_phone_number: "work_phone_number",


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
/**
 * Canonical fields whose answer is ALSO kept in Leads.rebuttals (JSON), so new
 * form questions / sheet columns never need a schema change.
 */
const REBUTTAL_FIELDS = new Set([
    "planned_move_timeline",
    "language_test_taken",
    "conditional_question_1",
    "total_work_experience"
]);

const buildColumnMap = (headerRow) => {
    const columnMap = {};
    // { columnIndex -> rebuttal key }: every header that is not a core field and
    // not explicitly ignored (so brand-new columns are captured automatically)
    const rebuttalColumns = {};
    const normalizedHeaders = headerRow.map(normalizeHeader);

    // "Lead Date" present => any bare "Date"/"Time" columns are call-tracking
    // columns we do not import. No "Lead Date" (Special Healthcare sheet) => the
    // bare "Date" IS the lead date.
    const hasLeadDate = normalizedHeaders.includes("lead_date");

    normalizedHeaders.forEach((normalized, index) => {
        let field = HEADER_SYNONYMS[normalized];

        if (normalized === "date") {
            field = hasLeadDate ? undefined : "lead_date";
        }

        if (field) {
            columnMap[index] = field;
        }

        if (normalized && !IGNORED_SHEET_HEADERS.has(normalized)) {
            if (!field || REBUTTAL_FIELDS.has(field)) {
                // stable key for known questions, header text for new ones
                rebuttalColumns[index] = field && REBUTTAL_FIELDS.has(field) ? field : normalized;
            }
        }
    });

    return { columnMap, rebuttalColumns };
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

const toBitOrNull = (value) => {
    const str = toTrimmedStringOrNull(value);
    if (str === null) return null;
    return ["true", "1", "yes"].includes(str.toLowerCase()) ? 1 : 0;
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
 * A row is skipped as a duplicate only when full_name, email_address
 * AND mobile_number ALL match an existing lead - matching on just one
 * or two of those fields does not count as a duplicate.
 *
 * Also stores the campaign fields (see database/lead_campaigns_schema.sql)
 * and handles the three Meta sheet layouts (Basic / Special Healthcare / UK).
 *
 * Query params: campaign_type, campaign_country, campaign_name, update_existing=true
 *
 * Populates:
 *  - Leads (first_name, last_name, phone_number -> mobile_number,
 *    email -> email_address, english_proficiency_level, lead_status,
 *    assigned_to, remark, income_band_(per_month) -> income_band_per_month,
 *    created_at)
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

        const { columnMap, rebuttalColumns } = buildColumnMap(headerRow);

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
            .query(`SELECT id, status_name, sort_order FROM LeadStatuses`);

        const statusByName = new Map(
            statusResult.recordset.map((s) => [
                normalizeHeader(s.status_name),
                s.id
            ])
        );

        /*
         * Leads.lead_status is NOT NULL, so unmatched/missing status
         * text can't just be left as NULL - fall back to whichever
         * status has the lowest sort_order (e.g. "New").
         */
        const defaultStatus = statusResult.recordset.reduce(
            (min, s) =>
                !min || s.sort_order < min.sort_order ? s : min,
            null
        );
        const defaultStatusId = defaultStatus?.id ?? null;

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

        /*
         * Which of the three sheet layouts is this? Detected from the headers,
         * overridable with ?campaign_type=  &campaign_country=  &campaign_name=
         * (query string or form field). Needed because the "Basic" sheet mixes
         * Middle East and Healthcare leads and carries no campaign column.
         */
        const opt = (k) => toTrimmedStringOrNull(req.query?.[k] ?? req.body?.[k]);
        const sheetCampaignType =
            normalizeCampaignType(opt("campaign_type")) ||
            detectCampaignType(new Set(Object.values(columnMap)));
        const sheetCampaignCountry =
            opt("campaign_country") ??
            DEFAULT_CAMPAIGN_COUNTRY[sheetCampaignType] ??
            null;
        const sheetCampaignName = opt("campaign_name");
        // true => rows matching an existing lead fill that lead's EMPTY campaign
        // columns instead of being skipped (used to tag the data already in prod).
        const updateExisting = ["true", "1", "yes"].includes(
            String(opt("update_existing") ?? "").toLowerCase()
        );

        // true => for rows matching an existing lead, the Disposition column replaces
        // that lead's current lead_status (only when the Disposition matches a LeadStatuses name).
        // Works together with update_existing; without it duplicates are skipped as before.
        const overwriteStatus = ["true", "1", "yes"].includes(
            String(opt("overwrite_status") ?? "").toLowerCase()
        );

        const imported = [];
        const updated = [];
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

            const rawPhoneNumber = toTrimmedStringOrNull(fields.phone_number);
            // Leads.mobile_number is NOT NULL - default to '' when missing.
            const phoneNumber = rawPhoneNumber ?? "";
            const email = toTrimmedStringOrNull(fields.email);
            const englishProficiency = toTrimmedStringOrNull(
                fields.english_proficiency_level
            );

            const metaLeadId =
                toTrimmedStringOrNull(fields.meta_lead_id)?.replace(/^l:/i, "") ?? null;
            const normPhone = normalizePhone(rawPhoneNumber);
            const normEmail = email ? email.toLowerCase() : null;

            // Values that live in the lead's child tables
            // (LeadEducation / LeadWorkExperience / LeadAddresses / LeadPersonalInformation)
            const education = toTrimmedStringOrNull(fields.education);
            const jobTitle =
                toTrimmedStringOrNull(fields.job_title) ||
                toTrimmedStringOrNull(fields.healthcare_profession);
            const totalWorkExperience = extractNumber(
                fields.total_work_experience
            );
            const countryOfResidence = toTrimmedStringOrNull(
                fields.country_of_residence
            );
            const nationality = toTrimmedStringOrNull(fields.nationality);

            // Values for the campaign columns of this row.
            // Everything that is not a core column goes into rebuttals (JSON)
            const rebuttalAnswers = {};
            Object.entries(rebuttalColumns).forEach(([index, key]) => {
                const answer = toTrimmedStringOrNull(rawRow[Number(index)]);
                if (answer !== null) rebuttalAnswers[key] = answer;
            });
            const campaignValues = {};
            Object.keys(LEAD_CAMPAIGN_TEXT_FIELDS).forEach((col) => {
                campaignValues[col] = toTrimmedStringOrNull(fields[col]);
            });
            campaignValues.campaign_type = sheetCampaignType;
            campaignValues.campaign_country = sheetCampaignCountry;
            campaignValues.meta_campaign_name =
                campaignValues.meta_campaign_name ?? sheetCampaignName;

            const leadDate = toDateOrNull(fields.lead_date) || toDateOrNull(fields.created_time);
            const extraValues = {
                lead_date: [sql.DateTime2, leadDate],
                meta_lead_id: [sql.NVarChar(50), metaLeadId],
                meta_form_id: [sql.NVarChar(50), toTrimmedStringOrNull(fields.meta_form_id)],
                meta_is_organic: [sql.Bit, toBitOrNull(fields.meta_is_organic)],
                meta_created_time: [sql.DateTime2, toDateOrNull(fields.created_time)]
            };
            const newRebuttals = mergeRebuttals(null, rebuttalAnswers);
            const campaignColumns = [
                ...Object.entries(LEAD_CAMPAIGN_TEXT_FIELDS).map(([col, type]) => [col, type, campaignValues[col]]),
                ...Object.entries(extraValues).map(([col, [type, value]]) => [col, type, value]),
                ["rebuttals", sql.NVarChar(sql.MAX), newRebuttals]
            ];

            /*
             * Duplicate check against leads already in the CRM (the ones imported
             * before this change have no Meta id, so phone / email are matched too):
             * Meta id, then last-10-digits of the phone, then email.
             */
            if (metaLeadId || normPhone || normEmail) {
                const dupResult = await pool
                    .request()
                    .input("meta_lead_id", sql.NVarChar(50), metaLeadId)
                    .input("phone", sql.VarChar(15), normPhone)
                    .input("email", sql.NVarChar(150), normEmail)
                    .query(`
                        SELECT TOP 1 lead_id, rebuttals
                        FROM dbo.Leads
                        WHERE (@meta_lead_id IS NOT NULL AND meta_lead_id = @meta_lead_id)
                           OR (@phone IS NOT NULL AND RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(
                                  ISNULL(mobile_number, ''), '+', ''), ' ', ''), '-', ''), 'p:', ''), 10) = @phone)
                           OR (@email IS NOT NULL AND LOWER(LTRIM(RTRIM(email_address))) = @email)
                        ORDER BY lead_id
                    `);

                if (dupResult.recordset.length > 0) {
                    const existingId = dupResult.recordset[0].lead_id;

                    if (!updateExisting && !overwriteStatus) {
                        skipped.push({
                            row: rowNumber,
                            reason: `Duplicate - matches existing lead_id ${existingId} (Meta id / phone / email)`
                        });
                        continue;
                    }

                    // Fill ONLY empty campaign columns; never touch status, assignment, remarks, etc.
                    try {
                        const upd = pool.request().input("lead_id", sql.Int, existingId);
                        // overwrite_status: Disposition replaces the current status
                        const dispText = toTrimmedStringOrNull(fields.disposition);
                        const newStatusId =
                            overwriteStatus && dispText
                                ? statusByName.get(normalizeHeader(dispText)) || null
                                : null;
                        if (overwriteStatus && dispText && !newStatusId) {
                            errors.push({
                                row: rowNumber,
                                reason: `Disposition "${dispText}" did not match any LeadStatuses.status_name - status left unchanged`
                            });
                        }
                        const sets = [];
                        if (updateExisting) {
                            campaignColumns
                                .filter(([col]) => col !== "rebuttals")
                                .forEach(([col, type, value]) => {
                                    upd.input(col, type, value);
                                    sets.push(`${col} = ISNULL(${col}, @${col})`);
                                });
                            // existing answers win; only missing keys are added
                            upd.input(
                                "rebuttals",
                                sql.NVarChar(sql.MAX),
                                mergeRebuttals(dupResult.recordset[0].rebuttals, rebuttalAnswers, { overwrite: false })
                            );
                            sets.push("rebuttals = @rebuttals");
                        }
                        if (newStatusId) {
                            upd.input("new_status", sql.Int, newStatusId);
                            sets.push("lead_status = @new_status");
                        }
                        if (sets.length === 0) {
                            skipped.push({
                                row: rowNumber,
                                reason: `Duplicate - matches existing lead_id ${existingId}; no Disposition to apply`
                            });
                            continue;
                        }
                        // another lead already owning this Meta id would violate the unique index
                        await upd.query(`
                            UPDATE dbo.Leads
                            SET ${sets.join(", ")}, updated_at = GETDATE()
                            WHERE lead_id = @lead_id
                        `);

                        // Fill child-table rows the lead does not have yet (never overwrites existing rows)
                        if (updateExisting) await pool
                            .request()
                            .input("lead_id", sql.Int, existingId)
                            .input("highest_level", sql.NVarChar(sql.MAX), education)
                            .input("industry_area", sql.NVarChar(255), jobTitle)
                            .input("years_of_experience", sql.Decimal(10, 2), totalWorkExperience)
                            .input("country", sql.VarChar(100), countryOfResidence)
                            .input("nationality", sql.NVarChar(100), nationality)
                            .query(`
                                IF @highest_level IS NOT NULL
                                   AND NOT EXISTS (SELECT 1 FROM LeadEducation WHERE lead_id = @lead_id)
                                    INSERT INTO LeadEducation (lead_id, highest_level, created_at, updated_at)
                                    VALUES (@lead_id, @highest_level, GETDATE(), GETDATE());

                                IF (@industry_area IS NOT NULL OR @years_of_experience IS NOT NULL)
                                   AND NOT EXISTS (SELECT 1 FROM LeadWorkExperience WHERE lead_id = @lead_id)
                                    INSERT INTO LeadWorkExperience
                                        (lead_id, industry_area, years_of_experience, noc_code, noc_title, created_at, updated_at)
                                    VALUES (@lead_id, @industry_area, @years_of_experience, '', '', GETDATE(), GETDATE());

                                IF @country IS NOT NULL
                                   AND NOT EXISTS (SELECT 1 FROM LeadAddresses WHERE lead_id = @lead_id)
                                    INSERT INTO LeadAddresses (lead_id, address_type, country, is_primary, created_at, updated_at)
                                    VALUES (@lead_id, 'Current', @country, 1, GETDATE(), GETDATE());

                                IF @nationality IS NOT NULL
                                BEGIN
                                    IF EXISTS (SELECT 1 FROM LeadPersonalInformation WHERE lead_id = @lead_id)
                                        UPDATE LeadPersonalInformation
                                        SET nationality = @nationality, updated_at = GETDATE()
                                        WHERE lead_id = @lead_id AND (nationality IS NULL OR nationality = '');
                                    ELSE
                                        INSERT INTO LeadPersonalInformation (lead_id, nationality, created_at, updated_at)
                                        VALUES (@lead_id, @nationality, GETDATE(), GETDATE());
                                END
                            `);
                        updated.push({
                            row: rowNumber,
                            lead_id: existingId,
                            ...(newStatusId ? { lead_status: newStatusId } : {})
                        });
                    } catch (updError) {
                        errors.push({ row: rowNumber, reason: updError.message || "Update failed" });
                    }
                    continue;
                }
            }

            const rowWarnings = [];

            // "Disposition" column holds the status_name text - resolved
            // against LeadStatuses and only the matching id goes into
            // Leads.lead_status.
            const dispositionText = toTrimmedStringOrNull(fields.disposition);
            const matchedStatusId = dispositionText
                ? statusByName.get(normalizeHeader(dispositionText)) || null
                : null;

            // Leads.lead_status is NOT NULL - fall back to the default status.
            const leadStatusId = matchedStatusId ?? defaultStatusId;

            if (dispositionText && !matchedStatusId) {
                rowWarnings.push(
                    `Disposition "${dispositionText}" did not match any LeadStatuses.status_name — defaulted to "${defaultStatus?.status_name}"`
                );
            } else if (!dispositionText) {
                rowWarnings.push(
                    `Disposition missing — defaulted to "${defaultStatus?.status_name}"`
                );
            }

            const assignedToText = toTrimmedStringOrNull(fields.assigned_to);
            const assignedToId = assignedToText
                ? userByNameOrEmail.get(normalizeHeader(assignedToText)) ||
                  userByNameOrEmail.get(assignedToText.toLowerCase()) ||
                  null
                : null;

            if (assignedToText && !assignedToId) {
                rowWarnings.push(
                    `assigned_to "${assignedToText}" did not match any Users.name/email — left unassigned`
                );
            }

            const incomeBand = toTrimmedStringOrNull(fields.income_band);
            const remark = toTrimmedStringOrNull(fields.remarks);

            const createdAt =
                toDateOrNull(fields.created_time) ||
                toDateOrNull(fields.lead_date) ||
                new Date();

            if (leadStatusId === null) {
                errors.push({
                    row: rowNumber,
                    reason: "No LeadStatuses configured to default to - add at least one row to LeadStatuses"
                });
                continue;
            }

            const transaction = new sql.Transaction(pool);

            try {
                await transaction.begin();

                const leadRequest = new sql.Request(transaction);
                campaignColumns.forEach(([col, type, value]) =>
                    leadRequest.input(col, type, value)
                );
                const leadResult = await leadRequest
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
                    .input(
                        "income_band_per_month",
                        sql.VarChar(100),
                        incomeBand
                    )
                    .input("created_at", sql.DateTime, createdAt)
                    .input("alt_phone_number", sql.NVarChar(30), toTrimmedStringOrNull(fields.work_phone_number))
                    .query(`
                        INSERT INTO dbo.Leads (
                            first_name,
                            last_name,
                            full_name,
                            mobile_number,
                            alt_phone_number,
                            email_address,
                            source,
                            lead_status,
                            assigned_to,
                            is_converted,
                            is_connected,
                            english_proficiency_level,
                            remark,
                            income_band_per_month,
                            created_at,
                            updated_at,
                            ${campaignColumns.map(([col]) => col).join(", ")}
                        )
                        OUTPUT inserted.lead_id
                        VALUES (
                            @first_name,
                            @last_name,
                            @full_name,
                            @mobile_number,
                            @alt_phone_number,
                            @email_address,
                            @source,
                            @lead_status,
                            @assigned_to,
                            @is_converted,
                            @is_connected,
                            @english_proficiency_level,
                            @remark,
                            @income_band_per_month,
                            @created_at,
                            GETDATE(),
                            ${campaignColumns.map(([col]) => `@${col}`).join(", ")}
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
                        .input("highest_level", sql.NVarChar(sql.MAX), education || null)
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
                        // noc_code / noc_title are NOT NULL with no default
                        // and the sheet has no NOC data - use a placeholder.
                        .input("noc_code", sql.NVarChar(50), "")
                        .input("noc_title", sql.NVarChar(255), "")
                        .query(`
                            INSERT INTO LeadWorkExperience (
                                lead_id,
                                industry_area,
                                years_of_experience,
                                noc_code,
                                noc_title,
                                created_at,
                                updated_at
                            )
                            VALUES (
                                @lead_id,
                                @industry_area,
                                @years_of_experience,
                                @noc_code,
                                @noc_title,
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

                if (nationality) {
                    await new sql.Request(transaction)
                        .input("lead_id", sql.Int, leadId)
                        .input("nationality", sql.NVarChar(100), nationality)
                        .query(`
                            INSERT INTO LeadPersonalInformation (
                                lead_id,
                                nationality,
                                created_at,
                                updated_at
                            )
                            VALUES (
                                @lead_id,
                                @nationality,
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
                    lead_number: leadNumber,
                    assigned_to: assignedToId,
                    lead_status: leadStatusId,
                    warnings: rowWarnings.length ? rowWarnings : undefined
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
                updated_existing: updated.length,
                skipped: skipped.length,
                failed: errors.length
            },
            campaign: {
                campaign_type: sheetCampaignType,
                campaign_country: sheetCampaignCountry,
                update_existing: updateExisting,
                overwrite_status: overwriteStatus
            },
            imported,
            updated,
            skipped,
            errors
        });

    } catch (error) {
        next(error);
    }
};
