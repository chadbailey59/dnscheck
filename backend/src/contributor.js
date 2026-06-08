'use strict';

const dns = require('dns').promises;
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { ALL_DOMAINS } = require('./config');
const { probe } = require('./poller');
const { findResolverGroup, listProviderNames } = require('./ispResolvers');

const DEFAULT_UPLOAD_URL = 'https://dnscheck.fun/api/probes';
const UPLOAD_URL = process.env.DNSCHECK_UPLOAD_URL || process.env.UPLOAD_URL || DEFAULT_UPLOAD_URL;
const TRACE_TARGET = process.env.TRACE_TARGET ?? '9.9.9.9';
const TRACE_MAX_HOPS = parseInt(process.env.TRACE_MAX_HOPS ?? '8', 10);
const TRACE_WAIT_SECS = parseInt(process.env.TRACE_WAIT_SECS ?? '2', 10);
const PROBE_INTERVAL_MS = Math.max(parseInt(process.env.PROBE_INTERVAL_MS ?? '60000', 10) || 60000, 1000);
const ENABLE_RDAP = process.env.DNSCHECK_DISABLE_RDAP !== '1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function runCommand(command, args, timeoutMs) {
  return new Promise(resolve => {
    execFile(command, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: err?.message ?? null,
      });
    });
  });
}

function isPublicIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeUuid(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return UUID_RE.test(id) ? id : null;
}

async function contributorId() {
  const envId = normalizeUuid(process.env.DNSCHECK_CONTRIBUTOR_ID);
  if (envId) return { id: envId, source: 'DNSCHECK_CONTRIBUTOR_ID' };
  if (process.env.DNSCHECK_CONTRIBUTOR_ID) {
    throw new Error('DNSCHECK_CONTRIBUTOR_ID must be a valid UUID');
  }

  return { id: randomUUID(), source: 'generated' };
}

function parseTraceEvidence(output) {
  const lines = output.split(/\r?\n/).slice(1);
  const ips = [];
  const evidence = [];

  for (const line of lines) {
    const lineIps = [...line.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map(m => m[0]);
    const publicIps = lineIps.filter(isPublicIpv4);
    if (publicIps.length === 0) continue;
    ips.push(...publicIps);
    evidence.push(line);
  }

  return { ips: unique(ips), evidence };
}

async function reverseDns(ip) {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise(resolve => setTimeout(() => resolve([]), 1500)),
    ]);
    return Array.isArray(names) ? names : [];
  } catch (_e) {
    return [];
  }
}

async function rdapEvidence(ip) {
  if (!ENABLE_RDAP || typeof fetch !== 'function') return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`https://rdap.org/ip/${ip}`, { signal: controller.signal });
    if (!res.ok) return [];
    const body = await res.text();
    return [body.slice(0, 20_000)];
  } catch (_e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function discoverIsp() {
  if (process.env.ISP_PROVIDER) {
    const group = findResolverGroup(process.env.ISP_PROVIDER);
    return { group, method: 'ISP_PROVIDER override', evidenceCount: group ? 1 : 0 };
  }

  const trace = await runCommand(
    'traceroute',
    ['-m', String(TRACE_MAX_HOPS), '-w', String(TRACE_WAIT_SECS), TRACE_TARGET],
    (TRACE_MAX_HOPS * TRACE_WAIT_SECS + 3) * 1000,
  );
  const { ips, evidence } = parseTraceEvidence(trace.stdout + trace.stderr);
  const firstPublicIps = ips.slice(0, 4);

  for (const ip of firstPublicIps) {
    evidence.push(...await reverseDns(ip));
    evidence.push(...await rdapEvidence(ip));
  }

  const group = findResolverGroup(evidence.join('\n'));
  return { group, method: `traceroute ${TRACE_TARGET}`, evidenceCount: evidence.length };
}

function domainsToProbe() {
  if (!process.env.DOMAINS) return ALL_DOMAINS;
  return unique(process.env.DOMAINS.split(',').map(d => d.trim().toLowerCase()));
}

async function uploadRows(rows, id, uploadId) {
  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contributor_id: id, upload_id: uploadId, rows }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${body}`);
  return JSON.parse(body);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runBatch(group, domains, id) {
  const ts = new Date().toISOString();
  const uploadId = randomUUID();

  console.log(`Upload ID: ${uploadId}.`);
  console.log(`Probing ${group.servers.length} resolver${group.servers.length === 1 ? '' : 's'} x ${domains.length} domain${domains.length === 1 ? '' : 's'}.`);

  const rows = [];
  for (const server of group.servers) {
    for (const domain of domains) {
      const result = await probe(server, domain);
      rows.push({
        ts,
        category: 'isp',
        provider: group.provider,
        server,
        domain,
        ...result,
      });
    }
  }

  const uploaded = await uploadRows(rows, id.id, uploadId);
  const failures = rows.filter(row => !row.ok).length;
  console.log(`Uploaded ${uploaded.inserted} result${uploaded.inserted === 1 ? '' : 's'} as run ${uploaded.run_id}, upload ${uploaded.upload_id}; failures=${failures}.`);
}

async function main() {
  if (!UPLOAD_URL) {
    console.error('Set DNSCHECK_UPLOAD_URL to your hosted /api/probes endpoint.');
    process.exit(2);
  }

  const { group, method, evidenceCount } = await discoverIsp();
  if (!group) {
    console.error(`Could not identify a configured ISP from ${method}.`);
    console.error(`Set ISP_PROVIDER to one of: ${listProviderNames().join(', ')}`);
    process.exit(2);
  }

  const id = await contributorId();
  const domains = domainsToProbe();
  console.log(`Contributor ID: ${id.id} (${id.source}).`);
  console.log(`Identified ${group.provider} via ${method} (${evidenceCount} local evidence item${evidenceCount === 1 ? '' : 's'}).`);
  console.log(`Running every ${PROBE_INTERVAL_MS}ms until stopped.`);

  for (;;) {
    try {
      await runBatch(group, domains, id);
    } catch (e) {
      console.error(e);
    }
    await sleep(PROBE_INTERVAL_MS);
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { contributorId, normalizeUuid, parseTraceEvidence };
