'use strict';

const { execFile } = require('child_process');
const { DNS_SERVERS, ALL_DOMAINS, DOMAINS_BY_TLD, TIMEOUT_SECS } = require('./config');
const { insertProbes } = require('./db');

const STATUS_RE = /status:\s*([A-Z]+)/;

// Never rejects — resolves with { exitCode, stdout, stderr, timedOut }.
function runDig(args, timeoutMs) {
  return new Promise(resolve => {
    const proc = execFile('dig', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        exitCode: err ? (err.code ?? 1) : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        timedOut: err?.killed ?? false,
      });
    });
    void proc;
  });
}

async function probe(server, domain) {
  const start = Date.now();
  const { exitCode, stdout, stderr, timedOut } = await runDig(
    [
      '+tries=1', `+time=${TIMEOUT_SECS}`,
      '+noall', '+answer', '+authority', '+comments',
      `@${server}`, domain, 'NS',
    ],
    (TIMEOUT_SECS + 2) * 1000,
  );
  const ms = Date.now() - start;
  const out = stdout + stderr;

  if (timedOut || exitCode === 9 || out.includes('connection timed out')) {
    return { ok: false, ms, ns_count: null, error: 'timeout' };
  }
  if (exitCode !== 0) {
    const m = STATUS_RE.exec(out);
    const rcode = m ? m[1] : `exit=${exitCode}`;
    return { ok: false, ms, ns_count: null, error: rcode === 'NOERROR' ? `exit=${exitCode}` : rcode };
  }
  const m = STATUS_RE.exec(out);
  const rcode = m ? m[1] : '';
  if (rcode && rcode !== 'NOERROR') {
    return { ok: false, ms, ns_count: null, error: `rcode=${rcode}` };
  }
  const nsPat = new RegExp(
    `^${domain.replace(/\./g, '\\.')}\\.\\s+\\d+\\s+IN\\s+NS`, 'gm',
  );
  const ns_count = (out.match(nsPat) ?? []).length;
  return { ok: true, ms, ns_count, error: null };
}

async function runOnce() {
  const ts = new Date().toISOString();
  const run_id = Date.now();

  const tasks = [];
  for (const { server, category, provider, tld } of DNS_SERVERS) {
    const domains = category === 'authoritative'
      ? (DOMAINS_BY_TLD[tld] ?? ALL_DOMAINS)
      : ALL_DOMAINS;
    for (const domain of domains) {
      tasks.push({ server, category, provider, domain });
    }
  }

  // Run all probes concurrently (with natural back-pressure from the OS / dig timeouts).
  const settled = await Promise.allSettled(
    tasks.map(async t => {
      const r = await probe(t.server, t.domain);
      return { ts, run_id, source: 'hosted', ...t, ...r };
    }),
  );

  const rows = settled
    .filter(s => s.status === 'fulfilled')
    .map(s => s.value);

  await insertProbes(rows);

  const tldFails = rows.filter(r => !r.ok && r.category === 'authoritative').length;
  console.log(`[${ts}] run=${run_id} probes=${rows.length} auth_failures=${tldFails}`);
  return run_id;
}

function startPoller(intervalMs) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } catch (e) {
      console.error('poller error:', e);
    } finally {
      running = false;
    }
  };

  // Run immediately on start, then on interval.
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { probe, runOnce, startPoller };
