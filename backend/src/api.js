'use strict';

const express = require('express');
const path = require('path');
const { getLatest, getHistory } = require('./db');
const { DNS_SERVERS, SAMPLE_DOMAINS, CONTROL_DOMAIN } = require('./config');

function createApp() {
  const app = express();

  app.get('/api/config', (_req, res) => {
    res.json({ servers: DNS_SERVERS, domains: SAMPLE_DOMAINS, control: CONTROL_DOMAIN });
  });

  app.get('/api/latest', async (req, res) => {
    const runId = req.query.run_id ? Number(req.query.run_id) : null;
    try {
      res.json(await getLatest(runId));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/history', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '180', 10) || 180, 1), 1440);
    try {
      res.json(await getHistory(limit));
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
