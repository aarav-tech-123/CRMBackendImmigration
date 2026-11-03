import crypto from "crypto";
import axios from "axios";
import { sql, poolPromise } from "../config/db.js";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const LEAD_FIELDS =
    "created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic,platform,field_data";

/**
 * Meta sends "2026-10-21T10:00:00+0000"; SQL Server only parses the
 * offset when it has a colon ("+00:00").
 */
const normalizeCreatedTime = (value) =>
    typeof value === "string"
        ? value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
        : value;

/**
 * Graph API returns answers as field_data: [{ name, values: [..] }].
 * Flatten to { name: "value" } so it has the same shape as the CSV export
 * and anything Meta adds later ends up in Leads.rebuttals automatically.
 */
const flattenGraphLead = (graphLead) => {
    const flat = {
        id: graphLead.id,
        created_time: normalizeCreatedTime(graphLead.created_time),
        ad_id: graphLead.ad_id,
        ad_name: graphLead.ad_name,
        adset_id: graphLead.adset_id,
        adset_name: graphLead.adset_name,
        campaign_id: graphLead.campaign_id,
        campaign_name: graphLead.campaign_name,
        form_id: graphLead.form_id,
        is_organic: graphLead.is_organic,
        platform: graphLead.platform
    };

    (graphLead.field_data || []).forEach((field) => {
        flat[field.name] = Array.isArray(field.values)
            ? field.values.join(", ")
            : field.values;
    });

    return flat;
};

/**
 * Only leads from campaigns whose name contains one of these words are kept
 * (case-insensitive, comma-separated). Defaults to "canucks"; set
 * META_CAMPAIGN_NAME_FILTER= (empty) to accept every campaign, e.g. for tests
 * (Meta's test leads have no campaign).
 */
const campaignKeywords = (process.env.META_CAMPAIGN_NAME_FILTER ?? "canucks")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

const isWantedCampaign = (lead) => {
    if (campaignKeywords.length === 0) return true;
    const name = String(lead.campaign_name || "").toLowerCase();
    return campaignKeywords.some((k) => name.includes(k));
};

const fetchGraphLead = async (leadgenId) => {
    const { data } = await axios.get(
        `https://graph.facebook.com/${GRAPH_VERSION}/${leadgenId}`,
        {
            params: {
                fields: LEAD_FIELDS,
                access_token: process.env.META_PAGE_ACCESS_TOKEN
            },
            timeout: 15000
        }
    );
    return data;
};

/** Writes one staging row per lead (raw JSON only; the procedure parses it). */
const stageLeads = async (pool, leads) => {
    const batchId = crypto.randomUUID();
    const transaction = new sql.Transaction(pool);

    await transaction.begin();
    try {
        for (const lead of leads) {
            await new sql.Request(transaction)
                .input("batch_id", sql.UniqueIdentifier, batchId)
                .input("raw_json", sql.NVarChar(sql.MAX), JSON.stringify(lead))
                .query(`
                    INSERT INTO dbo.Meta_Leads_Staging (batch_id, raw_json)
                    VALUES (@batch_id, @raw_json)
                `);
        }
        await transaction.commit();
    } catch (error) {
        await transaction.rollback();
        throw error;
    }

    return batchId;
};

/** Parses, de-duplicates and inserts everything Pending in staging. */
const processStaging = async (pool) => {
    const result = await pool.request().execute("dbo.usp_ImportMetaLeads");

    const summary = { Inserted: 0, Duplicate: 0, Error: 0 };
    (result.recordset || []).forEach((row) => {
        summary[row.import_status] = row.cnt;
    });
    return summary;
};

/**
 * GET /meta/webhook - Meta's one-time subscription handshake.
 */
export const verifyMetaWebhook = (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token && token === process.env.META_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
};

const isValidSignature = (req) => {
    const header = req.headers["x-hub-signature-256"];
    if (!header || !req.rawBody || !process.env.META_APP_SECRET) return false;

    const expected =
        "sha256=" +
        crypto
            .createHmac("sha256", process.env.META_APP_SECRET)
            .update(req.rawBody)
            .digest("hex");

    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * POST /meta/webhook - Meta "leadgen" events.
 * Event -> Graph API lead -> staging table -> usp_ImportMetaLeads -> Leads.
 * Returns 500 if a lead could not be staged so Meta retries; retries are
 * safe because meta_lead_id is de-duplicated.
 */
export const receiveMetaWebhook = async (req, res) => {
    if (!isValidSignature(req)) {
        return res.sendStatus(401);
    }

    try {
        const leadgenIds = [];
        (req.body.entry || []).forEach((entry) =>
            (entry.changes || []).forEach((change) => {
                if (change.field === "leadgen" && change.value?.leadgen_id) {
                    leadgenIds.push(change.value.leadgen_id);
                }
            })
        );

        if (leadgenIds.length === 0) {
            return res.sendStatus(200);
        }

        const pool = await poolPromise;
        const leads = [];
        for (const id of leadgenIds) {
            const lead = flattenGraphLead(await fetchGraphLead(id));
            if (isWantedCampaign(lead)) {
                leads.push(lead);
            } else {
                console.log(`Meta lead ${id} skipped (campaign: ${lead.campaign_name || "none"})`);
            }
        }

        if (leads.length === 0) {
            return res.sendStatus(200);
        }

        await stageLeads(pool, leads);
        res.sendStatus(200);

        // Respond first, import after; unprocessed rows stay Pending
        // and are picked up by the next webhook or POST /meta/leads/process.
        processStaging(pool).catch((err) =>
            console.error("Meta lead import failed:", err)
        );
    } catch (error) {
        console.error("Meta webhook error:", error.response?.data || error);
        return res.sendStatus(500);
    }
};

/**
 * POST /meta/leads/process - re-runs staging -> Leads for Pending rows.
 */
export const processPendingMetaLeads = async (req, res) => {
    try {
        const pool = await poolPromise;
        const summary = await processStaging(pool);
        return res.status(200).json({ success: true, ...summary });
    } catch (error) {
        console.error("Meta lead process error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to process staged Meta leads",
            error: error.message
        });
    }
};

/**
 * GET /meta/leads/staging?status=Error|Duplicate|Pending|Inserted
 */
export const listMetaStaging = async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool
            .request()
            .input("status", sql.VarChar(12), req.query.status || null)
            .query(`
                SELECT TOP (200)
                    stg_id, meta_lead_id, import_status, duplicate_reason,
                    lead_id, error_message, received_at, processed_at
                FROM dbo.Meta_Leads_Staging
                WHERE @status IS NULL OR import_status = @status
                ORDER BY stg_id DESC
            `);
        return res.status(200).json({ success: true, data: result.recordset });
    } catch (error) {
        console.error("Meta staging list error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
};
