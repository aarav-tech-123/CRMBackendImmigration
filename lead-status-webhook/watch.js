require('dotenv').config();
const { runSync } = require('./lib/sync');

const intervalMinutes = Number(process.env.SYNC_INTERVAL_MINUTES) || 15;
const intervalMs = intervalMinutes * 60 * 1000;

async function tick() {
  try {
    await runSync();
  } catch (err) {
    console.error('[watch] sync run failed:', err.message);
  }
}

console.log(`[watch] running sync every ${intervalMinutes} minute(s)`);

tick();
setInterval(tick, intervalMs);
