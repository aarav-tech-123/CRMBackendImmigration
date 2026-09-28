const crypto = require('crypto');

// Only leads whose CRM status name matches one of these (case-insensitive)
// get pushed to Meta. Configurable via QUALIFYING_STATUSES, comma-separated.
const qualifyingStatuses = (process.env.QUALIFYING_STATUSES || 'Qualified,Not Qualified')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isQualifyingStatus(statusName) {
  if (!statusName) return false;
  return qualifyingStatuses.includes(String(statusName).trim().toLowerCase());
}

// Maps a CRM status name to the value sent in Meta's custom_data.lead_status
function toLeadStatusValue(statusName) {
  return String(statusName).trim().toLowerCase().includes('not') ? 'not_qualified' : 'qualified';
}

function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

// Meta expects phone digits only, in E.164 order, no leading "+", no spaces/dashes/parens
function normalizePhone(phone) {
  if (!phone) return undefined;
  return String(phone).replace(/[^\d]/g, '');
}

function buildLeadEvent({ lead_id, lead_gen_id, email, phone, status, event_time }) {
  const leadStatusValue = toLeadStatusValue(status);

  const userData = {
    em: email ? [sha256(email)] : undefined,
    ph: phone ? [sha256(normalizePhone(phone))] : undefined,
    lead_id: lead_gen_id || lead_id,
  };
  Object.keys(userData).forEach((k) => userData[k] === undefined && delete userData[k]);

  return {
    event_name: 'Lead',
    event_time: event_time ? Math.floor(new Date(event_time).getTime() / 1000) : Math.floor(Date.now() / 1000),
    action_source: 'system_generated',
    event_id: `${lead_id}-${leadStatusValue}`, // dedup key if the same status is sent twice
    user_data: userData,
    custom_data: {
      lead_status: leadStatusValue,
    },
  };
}

async function sendToStape(events) {
  const { STAPE_CAPI_ENDPOINT, STAPE_API_KEY, META_PIXEL_ID } = process.env;

  if (!STAPE_CAPI_ENDPOINT) {
    throw new Error('STAPE_CAPI_ENDPOINT is not set');
  }

  const payload = {
    data: events,
    ...(META_PIXEL_ID ? { pixel_id: META_PIXEL_ID } : {}),
  };

  const response = await fetch(STAPE_CAPI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(STAPE_API_KEY ? { Authorization: `Bearer ${STAPE_API_KEY}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Stape/Meta CAPI error ${response.status}: ${text}`);
  }

  return text;
}

module.exports = {
  qualifyingStatuses,
  isQualifyingStatus,
  toLeadStatusValue,
  sha256,
  normalizePhone,
  buildLeadEvent,
  sendToStape,
};
