# Lead Status → Meta CAPI

Pushes leads to Meta Conversions API (via Stape) **only when their CRM
status is "Qualified" or "Not Qualified"** (configurable). Any other status
— New, Contacted, In Progress, Converted, etc. — is skipped.

Two ways to trigger a push:

1. **`sync.js` / `watch.js`** (recommended) — pulls leads from the CRM's
   read-only `GET /leads/export/capi` endpoint and pushes the qualifying
   ones. Nothing needs to change in the CRM for this to work.
2. **`server.js`** — a webhook your CRM can call directly the moment a
   lead's status changes, if you'd rather push in real time than poll.

Both share the same qualification filter and event-building logic
(`lib/capi.js`), so behavior is identical either way.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `STAPE_CAPI_ENDPOINT` — see "Confirm before going live" below.
- `META_PIXEL_ID` — your Meta Pixel / Dataset ID.
- `QUALIFYING_STATUSES` — defaults to `Qualified,Not Qualified`. Must match
  your CRM's `LeadStatuses.status_name` values exactly (case-insensitive).
- For `sync.js` / `watch.js`: `CRM_API_URL` and `CRM_API_TOKEN` (a
  SuperAdmin JWT — the export endpoint requires SuperAdmin auth).
- For `server.js`: `WEBHOOK_SECRET` (only needed if you use the webhook).

## Option 1: Poll the CRM (sync.js / watch.js)

One-off run:

```bash
npm run sync
```

Continuous polling (re-runs every `SYNC_INTERVAL_MINUTES`, default 15):

```bash
npm run watch
```

Each run:

1. Calls `GET {CRM_API_URL}/leads/export/capi`, passing `updated_since` from
   the last successful run (stored in `.sync-state.json`) so it only pulls
   leads that changed since then.
2. Filters to leads whose `status_name` is in `QUALIFYING_STATUSES`.
3. Sends each as a Meta `Lead` event to `STAPE_CAPI_ENDPOINT`.
4. Advances the watermark only if every send succeeded, so a failed lead
   gets retried on the next run instead of being silently skipped.

Getting a `CRM_API_TOKEN`: log in as a SuperAdmin via the CRM's
`POST {CRM_API_URL}/auth/login` (or however your auth route is set up) and
copy the returned JWT. Tokens expire per your CRM's JWT settings, so this
needs refreshing periodically if you run `watch.js` long-term.

## Option 2: Webhook (server.js)

```bash
npm start
```

`POST /webhook/lead-status`

```json
{
  "lead_id": "crm-internal-id-123",
  "lead_gen_id": "meta-leadgen-id-if-you-have-it",
  "email": "lead@example.com",
  "phone": "+1 555 123 4567",
  "status": "Qualified",
  "event_time": "2026-09-28T10:15:00Z"
}
```

Headers:

```
Content-Type: application/json
x-webhook-secret: <same value as WEBHOOK_SECRET>
```

If `status` isn't in `QUALIFYING_STATUSES`, the endpoint responds
`200 { ok: true, skipped: true }` and sends nothing — it's not an error,
just a no-op, so your CRM can call it on every status change without
needing to know the qualification rules itself.

- `lead_gen_id` — if you captured the original Meta Lead Ads `leadgen_id`
  when the lead came in, pass it here. Meta uses it for high-confidence
  matching back to the original ad/form, better than email/phone alone.
  If you don't have it, omit it — falls back to `lead_id`.
- `event_time` is optional; defaults to "now" if omitted.

Either way, `email`/`phone` are hashed with SHA-256 before anything is
sent — raw PII never leaves this service.

## Confirm before going live

I don't have visibility into your specific Stape container's configuration,
so one thing needs to be confirmed on your end before this works:

**`STAPE_CAPI_ENDPOINT`** — the exact URL and payload shape your Stape
container expects depends on which Stape product/trigger you're using:

- If you're using **Stape's Conversion API Gateway**, your dashboard shows
  a direct endpoint URL (something like
  `https://<your-container-domain>/capig/<pixel_id>`) that accepts Meta's
  native CAPI JSON format directly — `sendToStape` in `lib/capi.js` matches
  that format as-is (`{ data: [...], pixel_id }`).
- If your Meta tag instead fires off a **custom event/trigger** inside your
  GTM server container (not the Gateway product), check that trigger's
  name and expected fields in your GTM workspace, and adjust the payload
  built in `lib/capi.js`'s `sendToStape` to match what that trigger listens
  for.

Once confirmed, test with a single curl call and verify the event shows up
in **Meta Events Manager → Test Events**:

```bash
curl -X POST http://localhost:3000/webhook/lead-status \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: change_me" \
  -d '{"lead_id":"test-1","email":"test@example.com","status":"Qualified"}'
```

## Deploying

Plain Node scripts — deploy anywhere that runs Node 18+ (Render, Railway,
Fly.io, a VPS, a scheduled task on the CRM's own server, etc.). Keep `.env`
and `.sync-state.json` out of version control.
