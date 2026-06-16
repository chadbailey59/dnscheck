'use strict';

const { initDb } = require('./db');
const { startPoller } = require('./poller');
const { startMaintenance } = require('./maintenance');
const { createApp } = require('./api');

const PORT = parseInt(process.env.PORT ?? '8766', 10);
const INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '60000', 10);

async function main() {
  await initDb();
  console.log('DB ready');

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
