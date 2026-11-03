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
    meta_platform: sql.NVarChar(20)
};

/** Columns appended to every lead SELECT (alias L). */
export const LEAD_CAMPAIGN_SELECT = [
    "lead_date", "campaign_type", "campaign_country", "meta_lead_id",
    "meta_campaign_name", "meta_form_name", "meta_platform", "meta_is_organic"
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

/* ---------------------------------------------------------------------
   Leads.rebuttals - flexible per-lead answers stored as JSON:
     [{"question":"nationality","answer":"British"}, ...]
   (same shape the Meta webhook procedure writes). New sheet columns /
   form questions need NO schema change - they just become new keys.
   --------------------------------------------------------------------- */

/** "Nationality" / "what_is_your_x?" -> "nationality" / "what_is_your_x" */
export const normalizeRebuttalKey = (key) =>
    String(key ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");

/** Parses the stored JSON into [{question, answer}], tolerating NULL / bad data. */
export const parseRebuttals = (json) => {
    if (!json) return [];
    try {
        const parsed = typeof json === "string" ? JSON.parse(json) : json;
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

/**
 * Accepts { key: value } or [{question, answer}] from a request body and
 * returns a clean [{question, answer}] list (blank answers => answer null).
 */
export const toRebuttalList = (input) => {
    if (input === undefined || input === null) return [];
    const pairs = Array.isArray(input)
        ? input.map((r) => [r?.question, r?.answer])
        : Object.entries(typeof input === "object" ? input : {});
    return pairs
        .map(([q, a]) => ({
            question: normalizeRebuttalKey(q),
            answer: a === undefined || a === null || String(a).trim() === "" ? null : String(a).trim()
        }))
        .filter((r) => r.question);
};

/**
 * Merges incoming answers into the existing JSON.
 *  - overwrite=true  (PATCH): incoming wins; answer null removes the key
 *  - overwrite=false (import update_existing): existing answers win, only missing keys are added
 * Returns the JSON string to store, or null when nothing is left.
 */
export const mergeRebuttals = (existingJson, incoming, { overwrite = true } = {}) => {
    const map = new Map();
    parseRebuttals(existingJson).forEach((r) => {
        const k = normalizeRebuttalKey(r?.question);
        if (k && r.answer !== null && r.answer !== undefined) map.set(k, String(r.answer));
    });
    toRebuttalList(incoming).forEach(({ question, answer }) => {
        if (answer === null) {
            if (overwrite) map.delete(question);
        } else if (overwrite || !map.has(question)) {
            map.set(question, answer);
        }
    });
    if (map.size === 0) return null;
    return JSON.stringify([...map].map(([question, answer]) => ({ question, answer })));
};

/** Sheet headers we deliberately do NOT store anywhere (not even in rebuttals). */
export const IGNORED_SHEET_HEADERS = new Set([
    "email_sent", "date", "time", "1st_attempt", "2nd_attempt", "total_dial",
    "a_o_n_bucket", "a_o_n_day", "tagging", "lead_status"
]);
