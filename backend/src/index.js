'use strict';

const { initDb, enforceDomainAllowlist } = require('./db');
const { startPoller } = require('./poller');
const { startMaintenance } = require('./maintenance');
const { createApp } = require('./api');
const { ALL_DOMAINS } = require('./config');

const PORT = parseInt(process.env.PORT ?? '8766', 10);
const INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '60000', 10);

async function main() {
  await initDb();
  console.log('DB ready');

  const removed = await enforceDomainAllowlist(ALL_DOMAINS);
  if (removed.probes || removed.summary) {
    console.log(`Domain allowlist enforced: removed ${removed.probes} probes, ${removed.summary} segments (vacuumed)`);
  }

  startPoller(INTERVAL_MS);
  console.log(`Poller started (interval=${INTERVAL_MS}ms)`);

  startMaintenance();
  console.log('Retention maintenance scheduled');

  const app = createApp();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

main().catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});
