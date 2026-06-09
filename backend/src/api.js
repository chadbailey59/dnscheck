'use strict';

const express = require('express');
const path = require('path');
const { getLatest, getHistory, getContributorSummary, insertProbes } = require('./db');
const { DNS_SERVERS, SAMPLE_DOMAINS, CONTROL_DOMAIN } = require('./config');

const MAX_UPLOAD_ROWS = parseInt(process.env.MAX_UPLOAD_ROWS ?? '1000', 10);
const CATEGORIES = new Set(['authoritative', 'third_party', 'isp']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asNonEmptyString(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or less`);
  }
  return trimmed;
}

function asOptionalString(value, field, maxLength) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or less`);
  }
  return trimmed === '' ? null : trimmed;
}

function asNullableInteger(value, field) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer or null`);
  }
  return value;
}

function asTimestamp(value, field) {
  const ts = value == null ? new Date() : new Date(value);
  if (Number.isNaN(ts.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return ts.toISOString();
}

function minuteRunId(ts) {
  return Math.floor(new Date(ts).getTime() / 60000) * 60000;
}

function asOptionalUuid(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !UUID_RE.test(value.trim())) {
    throw new Error(`${field} must be a valid UUID`);
  }
  return value.trim().toLowerCase();
}

function normalizeUpload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('request body must be a JSON object');
  }
  if (!Array.isArray(body.rows)) throw new Error('rows must be an array');
  if (body.rows.length === 0) throw new Error('rows must not be empty');
  if (body.rows.length > MAX_UPLOAD_ROWS) {
    throw new Error(`rows must contain ${MAX_UPLOAD_ROWS} entries or fewer`);
  }

  const contributor_id = asOptionalUuid(body.contributor_id, 'contributor_id');
  const upload_id = asOptionalUuid(body.upload_id, 'upload_id');
  const batchTs = asTimestamp(body.ts, 'ts');
  const rows = body.rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`rows[${index}] must be an object`);
    }
    const category = asNonEmptyString(row.category, `rows[${index}].category`, 32);
    if (!CATEGORIES.has(category)) {
      throw new Error(`rows[${index}].category must be one of: ${[...CATEGORIES].join(', ')}`);
    }
    if (typeof row.ok !== 'boolean') {
      throw new Error(`rows[${index}].ok must be a boolean`);
    }

    return {
      ts: row.ts == null ? batchTs : asTimestamp(row.ts, `rows[${index}].ts`),
      category,
      provider: asNonEmptyString(row.provider, `rows[${index}].provider`, 128),
      server: asNonEmptyString(row.server, `rows[${index}].server`, 255),
      domain: asNonEmptyString(row.domain, `rows[${index}].domain`, 255).toLowerCase(),
      ok: row.ok,
      ms: asNullableInteger(row.ms, `rows[${index}].ms`),
      ns_count: asNullableInteger(row.ns_count, `rows[${index}].ns_count`),
      error: asOptionalString(row.error, `rows[${index}].error`, 255),
      contributor_id,
      source: 'contributor',
      upload_id,
    };
  });
  const run_id = minuteRunId(rows[0].ts);
  for (const row of rows) row.run_id = run_id;

  return { run_id, contributor_id, upload_id, rows };
}

function createApp() {
  const app = express();

  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? '128kb' }));
  app.use((err, _req, res, next) => {
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'request body is too large' });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'request body must be valid JSON' });
      return;
    }
    next(err);
  });

  app.get('/api/config', (_req, res) => {
    res.json({ servers: DNS_SERVERS, domains: SAMPLE_DOMAINS, control: CONTROL_DOMAIN });
  });

  app.post('/api/probes', async (req, res) => {
    let upload;
    try {
      upload = normalizeUpload(req.body);
    } catch (e) {
      res.status(400).json({ error: e.message });
      return;
    }

    try {
      const inserted = await insertProbes(upload.rows);
      res.status(201).json({
        ok: true,
        run_id: String(upload.run_id),
        contributor_id: upload.contributor_id,
        upload_id: upload.upload_id,
        inserted,
        submitted: upload.rows.length,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/latest', async (req, res) => {
    const runId = req.query.run_id ? Number(req.query.run_id) : null;
    try {
      res.json(await getLatest(runId, 'hosted'));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/history', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '180', 10) || 180, 1), 1440);
    try {
      res.json(await getHistory(limit, 'hosted'));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/contributors/latest', async (req, res) => {
    const runId = req.query.run_id ? Number(req.query.run_id) : null;
    try {
      res.json(await getLatest(runId, 'contributor'));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/contributors/history', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '180', 10) || 180, 1), 1440);
    try {
      res.json(await getHistory(limit, 'contributor'));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/contributors/summary', async (req, res) => {
    const minutes = Math.min(Math.max(parseInt(req.query.minutes ?? '60', 10) || 60, 1), 1440);
    try {
      res.json(await getContributorSummary(minutes));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  // Serve React build from ../public (populated by Docker build stage).
  const staticDir = path.join(__dirname, '../public');
  app.use(express.static(staticDir));
  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });

  return app;
}

module.exports = { createApp };
