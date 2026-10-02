// routes/health.js
import express from 'express';
import { pool } from '../lib/db.js';

export const healthRouter = express.Router();

// Liveness: no DB dependency, always fast
healthRouter.get('/', (_req, res) => res.json({ ok: true }));

// Readiness: verifies Postgres actually answers
healthRouter.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

