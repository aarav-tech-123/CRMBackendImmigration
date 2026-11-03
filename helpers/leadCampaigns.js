import { sql } from "../config/db.js";

export const CAMPAIGN_TYPES = {
    BASIC: "BASIC",                         // Basic Middle East + Basic Healthcare sheet
    SPECIAL_HEALTHCARE: "SPECIAL_HEALTHCARE",
    UK: "UK"
};

/** Default target market per sheet type (can be overridden on import). */
export const DEFAULT_CAMPAIGN_COUNTRY = {
    UK: "United Kingdom",
    SPECIAL_HEALTHCARE: "Canada",
    BASIC: null
};

/**
 * Plain text columns on Leads added for campaigns, with their SQL types.
 * Used by create / update / import so the list lives in one place.
 */
export const LEAD_CAMPAIGN_TEXT_FIELDS = {
    campaign_type: sql.NVarChar(50),
    campaign_country: sql.NVarChar(100),
    meta_campaign_name: sql.NVarChar(255),
    meta_form_name: sql.NVarChar(255),
    meta_platform: sql.NVarChar(20),
    nationality: sql.NVarChar(100),
    total_work_experience_text: sql.NVarChar(100),
    planned_move_timeline: sql.NVarChar(150),
    language_test_taken: sql.NVarChar(150),
    conditional_question_1: sql.NVarChar(500),
    tagging: sql.NVarChar(100)
};

/** Columns appended to every lead SELECT (alias L). */
export const LEAD_CAMPAIGN_SELECT = [
    "lead_date", "campaign_type", "campaign_country", "meta_lead_id",
    "meta_campaign_name", "meta_form_name", "meta_platform", "meta_is_organic",
    "nationality", "total_work_experience_text",
    "planned_move_timeline", "language_test_taken", "conditional_question_1",
    "tagging"
].map((c) => `L.${c}`).join(",\n                ");

/** Which sheet layout is this? Decided from the recognised header fields. */
export const detectCampaignType = (fieldNames) => {
    const has = (f) => fieldNames.has(f);
    if (has("nationality")) return CAMPAIGN_TYPES.UK;
    if (has("healthcare_profession") || has("planned_move_timeline")) {
        return CAMPAIGN_TYPES.SPECIAL_HEALTHCARE;
    }
    return CAMPAIGN_TYPES.BASIC;
};

export const normalizeCampaignType = (value) => {
    if (value === undefined || value === null || String(value).trim() === "") return null;
    return String(value).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
};

/** Last 10 digits of a phone number, for duplicate matching. */
export const normalizePhone = (value) => {
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits.length >= 7 ? digits.slice(-10) : null;
};
