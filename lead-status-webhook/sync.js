require('dotenv').config();
const { runSync } = require('./lib/sync');

runSync().catch((err) => {
  console.error('[sync] fatal error:', err);
  process.exitCode = 1;
});
