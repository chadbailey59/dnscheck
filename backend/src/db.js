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
        error      TEXT,
        contributor_id UUID,
        source     TEXT        NOT NULL DEFAULT 'hosted',
        upload_id  UUID
      );
      ALTER TABLE probes ADD COLUMN IF NOT EXISTS contributor_id UUID;
      ALTER TABLE probes ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'hosted';
      ALTER TABLE probes ADD COLUMN IF NOT EXISTS upload_id UUID;
      UPDATE probes SET source = 'contributor' WHERE contributor_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_probes_run    ON probes(run_id);
      CREATE INDEX IF NOT EXISTS idx_probes_ts     ON probes(ts);
      CREATE INDEX IF NOT EXISTS idx_probes_server ON probes(server, domain, ts);
      CREATE INDEX IF NOT EXISTS idx_probes_contributor ON probes(contributor_id);
      CREATE INDEX IF NOT EXISTS idx_probes_source_run ON probes(source, run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_probes_upload_unique
        ON probes(upload_id, server, domain)
        WHERE upload_id IS NOT NULL;
      UPDATE probes
      SET run_id = (EXTRACT(EPOCH FROM date_trunc('minute', ts)) * 1000)::BIGINT
      WHERE source = 'contributor'
        AND run_id <> (EXTRACT(EPOCH FROM date_trunc('minute', ts)) * 1000)::BIGINT;
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
      const base = i * 13;
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13})`;
    }).join(',');
    const params = rows.flatMap(r => [
      r.ts, r.run_id, r.category, r.provider, r.server, r.domain,
      r.ok, r.ms, r.ns_count, r.error, r.contributor_id ?? null,
      r.source ?? 'hosted', r.upload_id ?? null,
    ]);
    const result = await client.query(
      `INSERT INTO probes(ts,run_id,category,provider,server,domain,ok,ms,ns_count,error,contributor_id,source,upload_id) VALUES ${values}
       ON CONFLICT DO NOTHING`,
      params,
    );
    return result.rowCount;
  } finally {
    client.release();
  }
}

const CONTRIBUTOR_RUN_ID_SQL = "(EXTRACT(EPOCH FROM date_trunc('minute', ts)) * 1000)::BIGINT";

function minuteRunId(runId) {
  const n = BigInt(runId);
  return n - (n % 60000n);
}

async function getContributorLatest(runId = null) {
  const client = await pool().connect();
  try {
    let targetRunId = runId ? minuteRunId(runId) : null;
    if (!targetRunId) {
      const { rows: [top] } = await client.query(
        `SELECT MAX(${CONTRIBUTOR_RUN_ID_SQL}) AS r FROM probes WHERE source = 'contributor'`,
      );
      targetRunId = top?.r ?? null;
    }
    if (!targetRunId) return { ts: null, run_id: null, rows: [] };

    const { rows } = await client.query(
      `SELECT
         MAX(ts) AS ts,
         category,
         provider,
         server,
         domain,
         BOOL_AND(ok) AS ok,
         ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ms) FILTER (WHERE ms IS NOT NULL))::INTEGER AS ms,
         ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ns_count) FILTER (WHERE ns_count IS NOT NULL))::INTEGER AS ns_count,
         MODE() WITHIN GROUP (ORDER BY error) FILTER (WHERE error IS NOT NULL) AS error
       FROM probes
       WHERE source = 'contributor'
         AND ${CONTRIBUTOR_RUN_ID_SQL} = $1::BIGINT
       GROUP BY category, provider, server, domain
       ORDER BY category, provider, server, domain`,
      [targetRunId],
    );
    return { ts: rows[0]?.ts ?? null, run_id: String(targetRunId), rows };
  } finally {
    client.release();
  }
}

async function getLatest(runId = null, source = 'hosted') {
  if (source === 'contributor') return getContributorLatest(runId);

  const client = await pool().connect();
  try {
    let targetRunId = runId ? BigInt(runId) : null;
    if (!targetRunId) {
      const { rows: [top] } = await client.query('SELECT MAX(run_id) AS r FROM probes WHERE source = $1', [source]);
      targetRunId = top?.r ?? null;
    }
    if (!targetRunId) return { ts: null, run_id: null, rows: [] };
    const { rows } = await client.query(
      `SELECT ts, category, provider, server, domain, ok, ms, ns_count, error
       FROM probes WHERE run_id = $1 AND source = $2
       ORDER BY category, provider, server, domain`,
      [targetRunId, source],
    );
    return { ts: rows[0]?.ts ?? null, run_id: String(targetRunId), rows };
  } finally {
    client.release();
  }
}

async function getContributorHistory(limit) {
  const client = await pool().connect();
  try {
    const { rows: runRows } = await client.query(
      `SELECT DISTINCT ${CONTRIBUTOR_RUN_ID_SQL} AS run_id
       FROM probes
       WHERE source = 'contributor'
       ORDER BY run_id DESC
       LIMIT $1`,
      [limit],
    );
    const runs = runRows.map(r => Number(r.run_id)).reverse();
    if (runs.length === 0) return { runs: [], series: [] };

    const { rows } = await client.query(
      `SELECT
         ${CONTRIBUTOR_RUN_ID_SQL} AS run_id,
         MAX(ts) AS ts,
         category,
         provider,
         server,
         domain,
         BOOL_AND(ok) AS ok,
         ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ms) FILTER (WHERE ms IS NOT NULL))::INTEGER AS ms,
         MODE() WITHIN GROUP (ORDER BY error) FILTER (WHERE error IS NOT NULL) AS error
       FROM probes
       WHERE source = 'contributor'
         AND ${CONTRIBUTOR_RUN_ID_SQL} = ANY($1::BIGINT[])
       GROUP BY ${CONTRIBUTOR_RUN_ID_SQL}, category, provider, server, domain`,
      [runs],
    );

    return rowsToHistory(runs, rows);
  } finally {
    client.release();
  }
}

function rowsToHistory(runs, rows) {
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
}

async function getHistory(limit, source = 'hosted') {
  if (source === 'contributor') return getContributorHistory(limit);

  const client = await pool().connect();
  try {
    const { rows: runRows } = await client.query(
      'SELECT DISTINCT run_id FROM probes WHERE source = $2 ORDER BY run_id DESC LIMIT $1',
      [limit, source],
    );
    const runs = runRows.map(r => Number(r.run_id)).reverse();
    if (runs.length === 0) return { runs: [], series: [] };

    const { rows } = await client.query(
      `SELECT run_id, ts, category, provider, server, domain, ok, ms, error
       FROM probes WHERE run_id = ANY($1) AND source = $2`,
      [runs, source],
    );

    return rowsToHistory(runs, rows);
  } finally {
    client.release();
  }
}

async function getContributorSummary(minutes = 60) {
  const client = await pool().connect();
  try {
    const { rows } = await client.query(
      `SELECT
         provider,
         server,
         domain,
         COUNT(DISTINCT COALESCE(upload_id::TEXT, run_id::TEXT)) AS uploads,
         COUNT(DISTINCT contributor_id) AS contributors,
         COUNT(*) AS rows,
         COUNT(*) FILTER (WHERE NOT ok) AS failures,
         ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ms) FILTER (WHERE ms IS NOT NULL))::INTEGER AS median_ms,
         MODE() WITHIN GROUP (ORDER BY error) FILTER (WHERE error IS NOT NULL) AS common_error,
         MAX(ts) AS last_ts
       FROM probes
       WHERE source = 'contributor'
         AND ts >= NOW() - ($1::TEXT || ' minutes')::INTERVAL
       GROUP BY provider, server, domain
       ORDER BY provider, server, domain`,
      [minutes],
    );
    return { minutes, rows };
  } finally {
    client.release();
  }
}

module.exports = { initDb, insertProbes, getLatest, getHistory, getContributorSummary };
