// routes/layout.js
import express from 'express';
import { pool } from '../lib/db.js';
import { getUser } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';

export const layoutRouter = express.Router();

layoutRouter.use(getUser);

layoutRouter.post('/', async (req, res) => {
  const { links, hiddenLinks } = req.body ?? {};
  if (links && !Array.isArray(links))       throw new HttpError(400, 'links must be an array');
  if (hiddenLinks && !Array.isArray(hiddenLinks)) throw new HttpError(400, 'hiddenLinks must be an array');

  const payload = JSON.stringify({ links: links || [], hiddenLinks: hiddenLinks || [] });
  if (payload.length > 512 * 1024) throw new HttpError(413, 'Layout too large');

  await pool.query(
    `INSERT INTO user_layouts (user_id, links, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET links = EXCLUDED.links, updated_at = now()`,
    [req.user.id, payload]
  );
  res.json({ ok: true });
});

layoutRouter.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT links FROM user_layouts WHERE user_id = $1', [req.user.id]);
  if (!rows.length || !rows[0].links) return res.json({ links: [], hiddenLinks: [] });
  try {
    const parsed = JSON.parse(rows[0].links);
    if (Array.isArray(parsed)) return res.json({ links: parsed, hiddenLinks: [] });
    res.json({ links: parsed.links || [], hiddenLinks: parsed.hiddenLinks || [] });
  } catch {
    res.json({ links: [], hiddenLinks: [] });
  }
});

