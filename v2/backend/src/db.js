'use strict';

const { Pool } = require('pg');

let _pool = null;

function pool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

async function ensureDatabase() {
  // Connect to the default 'postgres' DB to create 'dnscheck' if missing.
  const url = new URL(process.env.DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, '');
  const adminUrl = process.env.DATABASE_URL.replace(url.pathname, '/postgres');
  const { Pool: P } = require('pg');
  const admin = new P({ connectionString: adminUrl });
  try {
    const { rows } = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1', [dbName]
    );
    if (rows.length === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database: ${dbName}`);
    }
  } finally {
    await admin.end();
  }
}

async function initDb() {
  await ensureDatabase();
  const client = await pool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS probes (
        id         BIGSERIAL PRIMARY KEY,
        ts         TIMESTAMPTZ NOT NULL,
        run_id     BIGINT      NOT NULL,
        category   TEXT        NOT NULL,
        provider   TEXT        NOT NULL,
        server     TEXT        NOT NULL,
        domain     TEXT        NOT NULL,
        ok         BOOLEAN     NOT NULL,
        ms         INTEGER,
        ns_count   INTEGER,
        error      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_probes_run    ON probes(run_id);
      CREATE INDEX IF NOT EXISTS idx_probes_ts     ON probes(ts);
      CREATE INDEX IF NOT EXISTS idx_probes_server ON probes(server, domain, ts);
    `);
  } finally {
    client.release();
  }
}

async function insertProbes(rows) {
  if (rows.length === 0) return;
  const client = await pool().connect();
  try {
    const values = rows.map((r, i) => {
      const base = i * 10;
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10})`;
    }).join(',');
    const params = rows.flatMap(r => [
      r.ts, r.run_id, r.category, r.provider, r.server, r.domain,
      r.ok, r.ms, r.ns_count, r.error,
    ]);
    await client.query(
      `INSERT INTO probes(ts,run_id,category,provider,server,domain,ok,ms,ns_count,error) VALUES ${values}`,
      params,
    );
  } finally {
    client.release();
  }
}

async function getLatest(runId = null) {
  const client = await pool().connect();
  try {
    let targetRunId = runId ? BigInt(runId) : null;
    if (!targetRunId) {
      const { rows: [top] } = await client.query('SELECT MAX(run_id) AS r FROM probes');
      targetRunId = top?.r ?? null;
    }
    if (!targetRunId) return { ts: null, run_id: null, rows: [] };
    const { rows } = await client.query(
      `SELECT ts, category, provider, server, domain, ok, ms, ns_count, error
       FROM probes WHERE run_id = $1
       ORDER BY category, provider, server, domain`,
      [targetRunId],
    );
    return { ts: rows[0]?.ts ?? null, run_id: String(targetRunId), rows };
  } finally {
    client.release();
  }
}

async function getHistory(limit) {
  const client = await pool().connect();
  try {
    const { rows: runRows } = await client.query(
      'SELECT DISTINCT run_id FROM probes ORDER BY run_id DESC LIMIT $1',
      [limit],
    );
    const runs = runRows.map(r => Number(r.run_id)).reverse();
    if (runs.length === 0) return { runs: [], series: [] };

    const { rows } = await client.query(
      `SELECT run_id, ts, category, provider, server, domain, ok, ms, error
       FROM probes WHERE run_id = ANY($1)`,
      [runs],
    );

    const seriesMap = new Map();
    for (const r of rows) {
      const key = `${r.category}\x00${r.provider}\x00${r.server}\x00${r.domain}`;
      if (!seriesMap.has(key)) {
        seriesMap.set(key, {
          category: r.category,
          provider: r.provider,
          server: r.server,
          domain: r.domain,
          results: {},
        });
      }
      seriesMap.get(key).results[Number(r.run_id)] = {
        ok: r.ok,
        ms: r.ms,
        ts: r.ts,
        error: r.error,
      };
    }
    return { runs, series: [...seriesMap.values()] };
  } finally {
    client.release();
  }
}

module.exports = { initDb, insertProbes, getLatest, getHistory };
