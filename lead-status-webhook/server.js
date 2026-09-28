require('dotenv').config();
const express = require('express');
const { isQualifyingStatus, buildLeadEvent, sendToStape, qualifyingStatuses } = require('./lib/capi');

const app = express();
app.use(express.json());

const { PORT = 3000, STAPE_CAPI_ENDPOINT, WEBHOOK_SECRET } = process.env;

if (!STAPE_CAPI_ENDPOINT) {
  console.warn('WARNING: STAPE_CAPI_ENDPOINT is not set — requests will fail until it is configured in .env');
}

console.log(`Qualifying statuses: ${qualifyingStatuses.join(', ')}`);

app.post('/webhook/lead-status', async (req, res) => {
  try {
    if (WEBHOOK_SECRET && req.get('x-webhook-secret') !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    // lead_id: your CRM's internal id (used for event dedup)
    // lead_gen_id: the original Meta Lead Ads leadgen_id, if you stored it — improves match quality
    const { lead_id, lead_gen_id, email, phone, status, event_time } = req.body;

    if (!lead_id || !status) {
      return res.status(400).json({ error: 'lead_id and status are required' });
    }

    // Only push when the CRM status is exactly "Qualified" or "Not Qualified"
    // (or whatever QUALIFYING_STATUSES is set to). Anything else is skipped, not an error.
    if (!isQualifyingStatus(status)) {
      console.log(`Skipped lead ${lead_id}: status "${status}" is not a qualifying status`);
      return res.status(200).json({ ok: true, skipped: true, reason: 'status_not_qualifying' });
    }

    const event = buildLeadEvent({ lead_id, lead_gen_id, email, phone, status, event_time });

    await sendToStape([event]);

    console.log(`Sent "${event.custom_data.lead_status}" event for lead ${lead_id}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.listen(PORT, () => console.log(`Lead status webhook listening on :${PORT}`));
