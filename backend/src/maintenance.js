'use strict';

// Data retention: roll raw probes up into run-length-encoded segments
// (probes_summary) as they age, then purge the raw rows. Runs in-process on a
// timer so it works identically on gemini (self-hosted) and Render (managed
// PG) — no pg_cron or external scheduler required.
//
//   - Raw successes are kept RAW_RETENTION_DAYS (default 5) for full detail.
//   - Raw failures are kept FAILURE_RETENTION_DAYS (default 90) for forensics.
//   - Every series' pass/fail history survives forever as compact segments.

const { pool } = require('./db');

const DAY_MS = 86_400_000;
const SEAL_LAG_MS = 90_000; // never seal the freshest, possibly in-flight, runs

const RAW_RETENTION_DAYS     = num(process.env.RAW_RETENTION_DAYS, 5);
const FAILURE_RETENTION_DAYS = num(process.env.FAILURE_RETENTION_DAYS, 90);
const MAINTENANCE_INTERVAL_MS = num(process.env.MAINTENANCE_INTERVAL_MS, 6 * 60 * 60 * 1000);

// Arbitrary fixed key so only one maintenance pass runs at a time, even if
// multiple app instances are connected to the same database.
const ADVISORY_LOCK_KEY = 4071510;

function num(v, d) {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

// Compute RLE segments for raw runs in (afterRunId, untilRunId] and fold them
// into probes_summary, extending an existing open segment where a streak
// crosses the boundary. Returns how many raw runs were sealed.
async function summarize(client, afterRunId, untilRunId) {
  // New segments derived from the raw rows in this window. Contributor uploads
  // produce several rows per (series, run_id) — one per contributor — so we
  // first collapse each run to a single pass/fail (a run is ok only if every
  // observation was ok, matching the dashboard's BOOL_AND semantics) before
  // run-length encoding. observations counts runs, not raw rows.
  const { rows: segs } = await client.query(
    `WITH per_run AS (
       SELECT source, category, provider, server, domain, nsid, run_id,
              bool_and(ok) AS ok,
              max(ts)      AS ts,
              mode() WITHIN GROUP (ORDER BY error) FILTER (WHERE error IS NOT NULL) AS error
       FROM probes
       WHERE run_id > $1 AND run_id <= $2
       GROUP BY source, category, provider, server, domain, nsid, run_id
     ),
     ordered AS (
       SELECT *, (ok IS DISTINCT FROM lag(ok) OVER w) AS flip
       FROM per_run
       WINDOW w AS (PARTITION BY source, category, provider, server, domain, nsid ORDER BY run_id)
     ),
     grp AS (
       SELECT *,
              sum(CASE WHEN flip THEN 1 ELSE 0 END)
                OVER (PARTITION BY source, category, provider, server, domain, nsid ORDER BY run_id) AS seg
       FROM ordered
     )
     SELECT source, category, provider, server, domain, nsid, ok,
            min(run_id) AS start_run_id, max(run_id) AS end_run_id,
            min(ts)     AS start_ts,     max(ts)     AS end_ts,
            count(*)    AS observations,
            CASE WHEN bool_or(ok) THEN NULL
                 ELSE mode() WITHIN GROUP (ORDER BY error) FILTER (WHERE error IS NOT NULL)
            END AS error
     FROM grp
     GROUP BY source, category, provider, server, domain, nsid, ok, seg
     ORDER BY source, category, provider, server, domain, nsid, start_run_id`,
    [afterRunId, untilRunId],
  );
  if (segs.length === 0) return 0;

  const seenSeries = new Set();
  let sealedRuns = 0;
  for (const s of segs) {
    sealedRuns += Number(s.observations);
    const seriesKey = `${s.source}\x00${s.category}\x00${s.provider}\x00${s.server}\x00${s.domain}\x00${s.nsid ?? ''}`;
    const isFirstForSeries = !seenSeries.has(seriesKey);
    seenSeries.add(seriesKey);

    // Only the earliest new segment of a series can continue a pre-existing
    // open segment; later ones are fresh state changes within this window.
    if (isFirstForSeries) {
      const { rowCount } = await client.query(
        `UPDATE probes_summary
         SET end_run_id = $1, end_ts = $2,
             observations = observations + $3,
             error = CASE WHEN ok THEN NULL ELSE COALESCE($4, error) END
         WHERE source = $5 AND category = $6 AND provider = $7
           AND server = $8 AND domain = $9 AND COALESCE(nsid,'') = COALESCE($10,'')
           AND ok = $11
           AND end_run_id = (
             SELECT max(end_run_id) FROM probes_summary
             WHERE source = $5 AND category = $6 AND provider = $7
               AND server = $8 AND domain = $9 AND COALESCE(nsid,'') = COALESCE($10,'')
           )`,
        [s.end_run_id, s.end_ts, s.observations, s.error,
         s.source, s.category, s.provider, s.server, s.domain, s.nsid, s.ok],
      );
      if (rowCount > 0) continue; // extended an existing streak
    }

    await client.query(
      `INSERT INTO probes_summary
         (source, category, provider, server, domain, nsid, ok,
          start_run_id, end_run_id, start_ts, end_ts, observations, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [s.source, s.category, s.provider, s.server, s.domain, s.nsid, s.ok,
       s.start_run_id, s.end_run_id, s.start_ts, s.end_ts, s.observations, s.error],
    );
  }
  return sealedRuns;
}

// Delete raw rows that are both (a) past their retention window and (b) already
// sealed into probes_summary — the watermark guard makes purging safe even if a
// summarize pass fell behind.
async function purge(client, sealedThrough) {
  const okCutoff   = new Date(Date.now() - RAW_RETENTION_DAYS * DAY_MS).toISOString();
  const failCutoff = new Date(Date.now() - FAILURE_RETENTION_DAYS * DAY_MS).toISOString();
  const ok = await client.query(
    `DELETE FROM probes WHERE ok AND ts < $1 AND run_id <= $2`,
    [okCutoff, sealedThrough],
  );
  const fail = await client.query(
    `DELETE FROM probes WHERE NOT ok AND ts < $1 AND run_id <= $2`,
    [failCutoff, sealedThrough],
  );
  return { ok: ok.rowCount, fail: fail.rowCount };
}

// One full pass: seal newly-aged raw runs, then purge. `purgeEnabled=false`
// rolls data up without deleting anything (safe first run / dry run).
async function runMaintenance({ purgeEnabled = true } = {}) {
  const client = await pool().connect();
  try {
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock($1) AS held', [ADVISORY_LOCK_KEY]);
    if (!lock.held) {
      console.log('[maintenance] another pass holds the lock; skipping');
      return;
    }
    try {
      const { rows: [wm] } = await client.query('SELECT COALESCE(max(end_run_id), 0) AS sealed FROM probes_summary');
      const sealedThrough = BigInt(wm.sealed);
      const untilRunId = BigInt(Date.now() - SEAL_LAG_MS);
      if (untilRunId <= sealedThrough) {
        console.log('[maintenance] nothing new to seal');
      } else {
        // Self-contained transaction: roll it back on any error so the
        // connection is clean (not aborted) before we unlock or purge.
        try {
          await client.query('BEGIN');
          const sealed = await summarize(client, sealedThrough.toString(), untilRunId.toString());
          await client.query('COMMIT');
          console.log(`[maintenance] sealed ${sealed} raw rows up to run_id=${untilRunId}`);
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e; // skip purge — never delete raw rows we failed to seal
        }
      }

      if (purgeEnabled) {
        const { rows: [wm2] } = await client.query('SELECT COALESCE(max(end_run_id), 0) AS sealed FROM probes_summary');
        const deleted = await purge(client, wm2.sealed);
        console.log(`[maintenance] purged raw: ${deleted.ok} successes, ${deleted.fail} failures`);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } catch (e) {
    console.error('[maintenance] error:', e.message);
  } finally {
    client.release();
  }
}

function startMaintenance(opts = {}) {
  // Defer the first pass so startup/poller settle, then run on a long interval.
  const timer = setTimeout(function tick() {
    runMaintenance(opts).finally(() => setTimeout(tick, MAINTENANCE_INTERVAL_MS));
  }, 60_000);
  timer.unref?.();
  return timer;
}

module.exports = {
  runMaintenance, summarize, purge, startMaintenance,
  RAW_RETENTION_DAYS, FAILURE_RETENTION_DAYS, MAINTENANCE_INTERVAL_MS,
};

// CLI: `node src/maintenance.js [--no-purge]` runs a single pass and exits.
// Use --no-purge to roll up into segments without deleting any raw rows.
if (require.main === module) {
  const purgeEnabled = !process.argv.includes('--no-purge');
  console.log(`[maintenance] one-shot (purge=${purgeEnabled}, raw=${RAW_RETENTION_DAYS}d, fail=${FAILURE_RETENTION_DAYS}d)`);
  runMaintenance({ purgeEnabled })
    .then(() => pool().end())
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
