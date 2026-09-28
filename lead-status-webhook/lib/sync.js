const fs = require('fs');
const path = require('path');
const { isQualifyingStatus, buildLeadEvent, sendToStape, qualifyingStatuses } = require('./capi');

function getConfig() {
  const {
    CRM_API_URL,   // e.g. https://your-crm-domain/api/v1  (no trailing slash needed)
    CRM_API_TOKEN, // SuperAdmin JWT — the export endpoint requires SuperAdmin auth
    SYNC_STATE_FILE = path.join(__dirname, '..', '.sync-state.json'),
  } = process.env;

  return { CRM_API_URL, CRM_API_TOKEN, SYNC_STATE_FILE };
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { last_synced_at: null };
  }
}

function writeState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function fetchLeads({ CRM_API_URL, CRM_API_TOKEN }, updatedSince) {
  if (!CRM_API_URL || !CRM_API_TOKEN) {
    throw new Error('CRM_API_URL and CRM_API_TOKEN must be set in .env');
  }

  const limit = 500;
  let page = 1;
  const allLeads = [];

  for (;;) {
    const url = new URL(`${CRM_API_URL.replace(/\/$/, '')}/leads/export/capi`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(limit));
    if (updatedSince) url.searchParams.set('updated_since', updatedSince);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${CRM_API_TOKEN}` },
    });

    if (!response.ok) {
      throw new Error(`CRM API error ${response.status}: ${await response.text()}`);
    }

    const body = await response.json();
    allLeads.push(...body.data);

    if (page >= body.meta.totalPages) break;
    page++;
  }

  return allLeads;
}

async function runSync() {
  const config = getConfig();
  const state = readState(config.SYNC_STATE_FILE);
  const runStartedAt = new Date().toISOString();

  console.log(`[sync] qualifying statuses: ${qualifyingStatuses.join(', ')}`);
  console.log(`[sync] fetching leads updated since: ${state.last_synced_at || '(none — full sync)'}`);

  const leads = await fetchLeads(config, state.last_synced_at);
  const qualifyingLeads = leads.filter((lead) => isQualifyingStatus(lead.status_name));

  console.log(`[sync] fetched ${leads.length} leads, ${qualifyingLeads.length} match Qualified/Not Qualified`);

  let sent = 0;
  let failed = 0;

  for (const lead of qualifyingLeads) {
    const event = buildLeadEvent({
      lead_id: lead.lead_id,
      email: lead.email_address,
      phone: lead.mobile_number,
      status: lead.status_name,
      event_time: lead.updated_at,
    });

    try {
      await sendToStape([event]);
      sent++;
      console.log(`[sync] sent "${event.custom_data.lead_status}" for lead ${lead.lead_id} (${lead.lead_number})`);
    } catch (err) {
      failed++;
      console.error(`[sync] failed to send lead ${lead.lead_id}:`, err.message);
    }
  }

  console.log(`[sync] done — sent ${sent}, failed ${failed}, skipped ${leads.length - qualifyingLeads.length}`);

  // Only advance the watermark if nothing failed, so a failed lead gets retried next run
  if (failed === 0) {
    writeState(config.SYNC_STATE_FILE, { last_synced_at: runStartedAt });
  }

  return { fetched: leads.length, sent, failed };
}

module.exports = { runSync };
