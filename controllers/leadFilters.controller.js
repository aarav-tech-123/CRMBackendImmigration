import { sql, poolPromise } from "../config/db.js";
import { LEAD_CAMPAIGN_SELECT, normalizeCampaignType, normalizeRebuttalKey, parseRebuttals } from "../helpers/leadCampaigns.js";

/**
 * Query-string values may be repeated or comma separated:
 *   ?campaign_type=UK,BASIC   ?campaign_type=UK&campaign_type=BASIC
 */
const toList = (value) =>
    (Array.isArray(value) ? value : [value])
        .filter((v) => v !== undefined && v !== null)
        .flatMap((v) => String(v).split(","))
        .map((v) => v.trim())
        .filter(Boolean);

const toBool = (value) => {
    if (value === undefined || value === "") return null;
    const v = String(value).toLowerCase();
    if (["true", "1", "yes"].includes(v)) return 1;
    if (["false", "0", "no"].includes(v)) return 0;
    return undefined; // invalid
};

const SORTABLE = {
    created_at: "L.created_at",
    lead_date: "COALESCE(L.lead_date, L.created_at)",
    full_name: "L.full_name",
    updated_at: "L.updated_at"
};

/** Exact-match (case-insensitive by collation) text filters: query param -> column */
const EXACT_FILTERS = {
    // Disposition IS the lead status, so match on the status name
    disposition: "LS.status_name",
    campaign_type: "L.campaign_type",
    campaign_country: "L.campaign_country",
    platform: "L.meta_platform",
    english_proficiency_level: "L.english_proficiency_level",
    income_band: "L.income_band_per_month",
    source: "L.source",
    center_code: "L.center_code"
};

/** Partial-match (LIKE) filters on the Leads table itself */
const LIKE_FILTERS = {
    campaign_name: "L.meta_campaign_name",
    form_name: "L.meta_form_name"
};

/** Partial-match filters on child tables (EXISTS so a lead is never duplicated) */
const CHILD_LIKE_FILTERS = {
    country_of_residence: "EXISTS (SELECT 1 FROM LeadAddresses A WHERE A.lead_id = L.lead_id AND A.country LIKE {p})",
    nationality: "EXISTS (SELECT 1 FROM LeadPersonalInformation P WHERE P.lead_id = L.lead_id AND P.nationality LIKE {p})",
    education: "EXISTS (SELECT 1 FROM LeadEducation E WHERE E.lead_id = L.lead_id AND E.highest_level LIKE {p})",
    job_title: "EXISTS (SELECT 1 FROM LeadWorkExperience W WHERE W.lead_id = L.lead_id AND W.industry_area LIKE {p})"
};

/**
 * Builds the WHERE clause for the lead filter APIs.
 * Returns { error } for bad input, otherwise { where, params } where params is
 * an array of [name, type, value] to bind on each request.
 */
const buildLeadFilter = (query, user) => {
    const where = ["1 = 1"];
    const params = [];
    let n = 0;
    const bind = (type, value) => {
        const name = `p${n++}`;
        params.push([name, type, value]);
        return `@${name}`;
    };

    // ---- scope: agents only ever see their own leads in their center ----
    if (user?.role === "Agent") {
        where.push(`L.assigned_to = ${bind(sql.Int, user.id)}`);
        if (user.center_code) where.push(`L.center_code = ${bind(sql.NVarChar(50), user.center_code)}`);
    }

    // ---- converted leads are hidden unless asked for ----
    const converted = toBool(query.is_converted);
    if (converted === undefined) return { error: "Invalid is_converted value" };
    where.push(`ISNULL(L.is_converted, 0) = ${bind(sql.Bit, converted ?? 0)}`);

    // ---- exact filters (multi value) ----
    for (const [param, column] of Object.entries(EXACT_FILTERS)) {
        let values = toList(query[param]);
        if (param === "campaign_type") values = values.map(normalizeCampaignType).filter(Boolean);
        if (values.length === 0) continue;
        where.push(`${column} IN (${values.map((v) => bind(sql.NVarChar(255), v)).join(", ")})`);
    }

    // ---- partial filters ----
    for (const [param, column] of Object.entries(LIKE_FILTERS)) {
        const values = toList(query[param]);
        if (values.length === 0) continue;
        where.push(`(${values.map((v) => `${column} LIKE ${bind(sql.NVarChar(255), `%${v}%`)}`).join(" OR ")})`);
    }
    for (const [param, template] of Object.entries(CHILD_LIKE_FILTERS)) {
        const values = toList(query[param]);
        if (values.length === 0) continue;
        where.push(`(${values.map((v) => template.replace("{p}", bind(sql.NVarChar(255), `%${v}%`))).join(" OR ")})`);
    }

    // ---- rebuttals (JSON extra answers): ?rb_<question>=value[,value] ----
    // e.g. rb_nationality=British   rb_planned_move_timeline=3 months
    // Partial, case-insensitive match; any key works, no code change for new questions.
    for (const [param, raw] of Object.entries(query)) {
        if (!param.startsWith("rb_")) continue;
        const key = normalizeRebuttalKey(param.slice(3));
        const values = toList(raw);
        if (!key || values.length === 0) continue;
        const k = bind(sql.NVarChar(200), key);
        const likes = values.map((v) => `R.a LIKE ${bind(sql.NVarChar(500), `%${v}%`)}`).join(" OR ");
        where.push(`EXISTS (
                    SELECT 1 FROM OPENJSON(L.rebuttals)
                        WITH (q NVARCHAR(300) '$.question', a NVARCHAR(MAX) '$.answer') R
                    WHERE REPLACE(LOWER(R.q), '?', '') = ${k} AND (${likes}))`);
    }

    // ---- ids ----
    const idFilter = (param, column) => {
        const raw = toList(query[param]);
        if (raw.length === 0) return null;
        const ids = raw.map((v) => parseInt(v, 10));
        if (ids.some((v) => !Number.isInteger(v))) return `Invalid ${param}`;
        where.push(`${column} IN (${ids.map((v) => bind(sql.Int, v)).join(", ")})`);
        return null;
    };
    let err = idFilter("lead_status", "L.lead_status");
    if (err) return { error: err };

    // assigned_to: ids, or "unassigned" for leads nobody owns yet
    const assigned = toList(query.assigned_to);
    if (assigned.length > 0 && user?.role !== "Agent") {
        const unassigned = assigned.some((v) => v.toLowerCase() === "unassigned");
        const ids = assigned.filter((v) => v.toLowerCase() !== "unassigned").map((v) => parseInt(v, 10));
        if (ids.some((v) => !Number.isInteger(v))) return { error: "Invalid assigned_to" };
        const parts = [];
        if (ids.length) parts.push(`L.assigned_to IN (${ids.map((v) => bind(sql.Int, v)).join(", ")})`);
        if (unassigned) parts.push("L.assigned_to IS NULL");
        where.push(`(${parts.join(" OR ")})`);
    }

    // ---- booleans ----
    for (const [param, column] of [["is_connected", "L.is_connected"], ["is_organic", "L.meta_is_organic"]]) {
        const v = toBool(query[param]);
        if (v === undefined) return { error: `Invalid ${param} value` };
        if (v !== null) where.push(`ISNULL(${column}, 0) = ${bind(sql.Bit, v)}`);
    }

    // ---- campaign tagged / untagged (for cleaning up the pre-existing leads) ----
    const hasCampaign = toBool(query.has_campaign);
    if (hasCampaign === undefined) return { error: "Invalid has_campaign value" };
    if (hasCampaign === 1) where.push("L.campaign_type IS NOT NULL");
    if (hasCampaign === 0) where.push("L.campaign_type IS NULL");

    // ---- lead date range (the sheet's Lead Date, falling back to created_at) ----
    for (const [param, op] of [["date_from", ">="], ["date_to", "<"]]) {
        if (!query[param]) continue;
        const d = new Date(query[param]);
        if (Number.isNaN(d.getTime())) return { error: `Invalid ${param}` };
        if (param === "date_to") d.setDate(d.getDate() + 1); // inclusive end date
        where.push(`COALESCE(L.lead_date, L.created_at) ${op} ${bind(sql.DateTime2, d)}`);
    }

    // ---- free text search ----
    const search = typeof query.search === "string" ? query.search.trim() : "";
    if (search) {
        const p = bind(sql.NVarChar(250), `%${search}%`);
        where.push(`(L.full_name LIKE ${p} OR L.email_address LIKE ${p} OR L.mobile_number LIKE ${p}
                     OR L.alt_phone_number LIKE ${p} OR L.lead_number LIKE ${p})`);
    }

    return { where: where.join("\n                AND "), params };
};

const bindAll = (request, params) => {
    params.forEach(([name, type, value]) => request.input(name, type, value));
    return request;
};

/**
 * GET /leads/filter
 *
 * Campaign: campaign_type (BASIC|SPECIAL_HEALTHCARE|UK), campaign_country, campaign_name,
 *           form_name, platform, is_organic, has_campaign
 * Lead:     lead_status (ids), assigned_to (ids | unassigned), disposition,
 *           nationality, country_of_residence, education, job_title (child tables),
 *          
 *           income_band, english_proficiency_level, source, center_code,
 *           rb_<question> = any extra answer stored in rebuttals JSON, e.g. rb_planned_move_timeline=3 months,
 *           is_connected, is_converted
 * Dates:    date_from, date_to (YYYY-MM-DD, on lead date)
 * Other:    search, page, limit (max 100), sort_by (created_at|lead_date|full_name|updated_at),
 *           sort_order (asc|desc)
 * Every text filter accepts several values: ?campaign_type=UK,BASIC
 */
export const filterLeads = async (req, res) => {
    try {
        const built = buildLeadFilter(req.query, req.user);
        if (built.error) {
            return res.status(400).json({ success: false, message: built.error });
        }

        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const offset = (page - 1) * limit;

        const sortColumn = SORTABLE[req.query.sort_by] || SORTABLE.created_at;
        const sortOrder = String(req.query.sort_order).toLowerCase() === "asc" ? "ASC" : "DESC";

        const pool = await poolPromise;

        const dataRequest = bindAll(pool.request(), built.params)
            .input("offset", sql.Int, offset)
            .input("limit", sql.Int, limit);
        const countRequest = bindAll(pool.request(), built.params);

        const from = `
            FROM Leads L
            LEFT JOIN LeadStatuses LS ON L.lead_status = LS.id
            WHERE ${built.where}`;

        const [data, count] = await Promise.all([
            dataRequest.query(`
                SELECT
                    L.lead_id, L.lead_number, L.first_name, L.middle_name, L.last_name, L.full_name,
                    L.mobile_number, L.alt_phone_number, L.email_address, L.alt_email, L.source,
                    L.lead_status, LS.status_name, L.center_code, L.assigned_to, L.is_converted,
                    L.remark, L.english_proficiency_level, L.income_band_per_month, L.is_connected,
                    ${LEAD_CAMPAIGN_SELECT},
                    L.rebuttals,
                    L.created_at, L.updated_at
                ${from}
                ORDER BY ${sortColumn} ${sortOrder}, L.lead_id DESC
                OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`),
            countRequest.query(`SELECT COUNT(*) AS total ${from}`)
        ]);

        const total = count.recordset[0].total;

        return res.status(200).json({
            success: true,
            data: data.recordset.map((lead) => ({ ...lead, rebuttals: parseRebuttals(lead.rebuttals) })),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        });
    } catch (error) {
        console.error("Error in filterLeads:", error);
        return res.status(500).json({ success: false, message: "Failed to filter leads", error: error.message });
    }
};

/**
 * GET /leads/filter/options
 * Distinct values + counts to fill the filter dropdowns
 * (campaign types, countries, forms, dispositions, nationalities...).
 */
export const getLeadFilterOptions = async (req, res) => {
    try {
        const pool = await poolPromise;
        const scopeFor = (alias = "") =>
            req.user?.role === "Agent"
                ? `AND ${alias}assigned_to = @user_id AND ${alias}center_code = @center_code`
                : "";
        const agentScope = scopeFor();
        const childScope = scopeFor("L.");

        const dim = (column) => `
            SELECT '${column}' AS field, ${column} AS value, COUNT(*) AS count
            FROM Leads
            WHERE ISNULL(is_converted, 0) = 0 AND ${column} IS NOT NULL AND ${column} <> '' ${agentScope}
            GROUP BY ${column}`;

        const columns = [
            "campaign_type", "campaign_country", "meta_campaign_name", "meta_form_name", "meta_platform", "english_proficiency_level", "income_band_per_month", "source"
        ];

        const request = pool.request();
        if (agentScope) {
            request.input("user_id", sql.Int, req.user.id);
            request.input("center_code", sql.NVarChar(50), req.user.center_code);
        }

        const result = await request.query(
            `${columns.map(dim).join("\nUNION ALL\n")}\nORDER BY field, count DESC`
        );

        const options = {};
        result.recordset.forEach(({ field, value, count }) => {
            (options[field] ||= []).push({ value, count });
        });

        // Values that live in child tables (nationality, country of residence, education)
        const child = await request.query(`
            SELECT 'nationality' AS field, P.nationality AS value, COUNT(*) AS count
              FROM LeadPersonalInformation P JOIN Leads L ON L.lead_id = P.lead_id
             WHERE ISNULL(L.is_converted, 0) = 0 AND P.nationality IS NOT NULL AND P.nationality <> '' ${childScope}
             GROUP BY P.nationality
            UNION ALL
            SELECT 'country_of_residence', A.country, COUNT(*)
              FROM LeadAddresses A JOIN Leads L ON L.lead_id = A.lead_id
             WHERE ISNULL(L.is_converted, 0) = 0 AND A.country IS NOT NULL AND A.country <> '' ${childScope}
             GROUP BY A.country
            UNION ALL
            SELECT 'education', E.highest_level, COUNT(*)
              FROM LeadEducation E JOIN Leads L ON L.lead_id = E.lead_id
             WHERE ISNULL(L.is_converted, 0) = 0 AND E.highest_level IS NOT NULL AND LEN(E.highest_level) <= 100 ${childScope}
             GROUP BY E.highest_level
            ORDER BY field, count DESC`);
        child.recordset.forEach(({ field, value, count }) => {
            (options[field] ||= []).push({ value, count });
        });

        // Extra answers stored in rebuttals JSON: every question key + its common answers
        const rb = await request.query(`
            SELECT REPLACE(LOWER(R.q), '?', '') AS field, R.a AS value, COUNT(*) AS count
            FROM Leads L
            CROSS APPLY OPENJSON(L.rebuttals)
                WITH (q NVARCHAR(300) '$.question', a NVARCHAR(500) '$.answer') R
            WHERE L.rebuttals IS NOT NULL AND ISNULL(L.is_converted, 0) = 0
              AND R.a IS NOT NULL AND LEN(R.a) <= 100 ${childScope}
            GROUP BY REPLACE(LOWER(R.q), '?', ''), R.a
            ORDER BY field, count DESC`);

        const rebuttals = {};
        rb.recordset.forEach(({ field, value, count }) => {
            (rebuttals[field] ||= []).push({ value, count });
        });
        options.rebuttals = rebuttals;

        return res.status(200).json({ success: true, data: options });
    } catch (error) {
        console.error("Error in getLeadFilterOptions:", error);
        return res.status(500).json({ success: false, message: "Failed to load filter options", error: error.message });
    }
};

/**
 * PUT /leads/campaign/bulk-tag
 * Body: { lead_ids: [1,2,3], campaign_type, campaign_country?, overwrite?: false }
 * Tags leads that already exist (e.g. the ones imported before campaigns
 * were tracked). Without overwrite=true only untagged fields are filled.
 */
export const bulkTagLeadCampaign = async (req, res) => {
    try {
        const ids = [...new Set((req.body?.lead_ids || []).map((v) => parseInt(v, 10)))];
        if (ids.length === 0 || ids.length > 5000 || ids.some((v) => !Number.isInteger(v))) {
            return res.status(400).json({ success: false, message: "lead_ids must be 1-5000 integers" });
        }

        const campaignType = normalizeCampaignType(req.body.campaign_type);
        const campaignCountry = req.body.campaign_country ? String(req.body.campaign_country).trim() : null;
        if (!campaignType && !campaignCountry) {
            return res.status(400).json({ success: false, message: "Provide campaign_type and/or campaign_country" });
        }

        const overwrite = ["true", "1", true, 1].includes(req.body.overwrite);
        const setExpr = (col) => (overwrite ? `COALESCE(@${col}, ${col})` : `ISNULL(${col}, @${col})`);

        const pool = await poolPromise;
        const request = pool.request()
            .input("campaign_type", sql.NVarChar(50), campaignType)
            .input("campaign_country", sql.NVarChar(100), campaignCountry);
        ids.forEach((id, i) => request.input(`id${i}`, sql.Int, id));

        const result = await request.query(`
            UPDATE Leads
            SET campaign_type = ${setExpr("campaign_type")},
                campaign_country = ${setExpr("campaign_country")},
                updated_at = GETDATE()
            WHERE lead_id IN (${ids.map((_, i) => `@id${i}`).join(", ")})`);

        return res.status(200).json({ success: true, updated: result.rowsAffected[0] });
    } catch (error) {
        console.error("Error in bulkTagLeadCampaign:", error);
        return res.status(500).json({ success: false, message: "Failed to tag leads", error: error.message });
    }
};
