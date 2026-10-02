
// routes/links.js
import express from 'express';
import { pool, resetLinks } from '../lib/db.js';
import { getUser, requireAdmin } from '../lib/auth.js';
import { assertSafeUrl } from '../lib/validate.js';
import { HttpError } from '../lib/errors.js';
import { DEFAULT_LINKS } from '../lib/config.js';

export const linksRouter = express.Router();

linksRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM shared_links ORDER BY category, title');
  res.json(rows);
});

linksRouter.post('/', getUser, requireAdmin, async (req, res) => {
  const { title, url, icon, category, mode } = req.body ?? {};
  if (!title || !url) throw new HttpError(400, 'Title and URL are required');
  const safeUrl  = assertSafeUrl(url);                       // fix #6
  const safeMode = mode === 'tab' ? 'tab' : 'window';
  const { rows } = await pool.query(
    'INSERT INTO shared_links (title, url, icon, category, mode) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [String(title), safeUrl, icon || '', category || 'General', safeMode]
  );
  res.json({ id: Number(rows[0].id), ok: true });
});

linksRouter.put('/:id', getUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Invalid id');

  const found = await pool.query('SELECT * FROM shared_links WHERE id = $1', [id]);
  if (!found.rows.length) throw new HttpError(404, 'Link not found');
  const existing = found.rows[0];

  const body  = req.body || {};
  const next_ = {
    title:    body.title    ?? existing.title,
    url:      body.url      ?? existing.url,
    icon:     body.icon     ?? existing.icon,
    category: body.category ?? existing.category,
    mode:     body.mode     ?? existing.mode ?? 'window',
  };
  if (next_.mode !== 'tab') next_.mode = 'window';
  if (!next_.title || !next_.url) throw new HttpError(400, 'Title and URL are required');
  next_.url = assertSafeUrl(next_.url);                      // fix #6

  await pool.query(
    'UPDATE shared_links SET title=$1, url=$2, icon=$3, category=$4, mode=$5 WHERE id=$6',
    [next_.title, next_.url, next_.icon, next_.category, next_.mode, id]
  );
  res.json({ ok: true, link: { id, ...next_ } });
});

linksRouter.delete('/:id', getUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query('DELETE FROM shared_links WHERE id = $1', [id]);
  if (!r.rowCount) throw new HttpError(404, 'Link not found');
  res.json({ ok: true });
});

linksRouter.post('/reset', getUser, requireAdmin, async (_req, res) => {
  await resetLinks(DEFAULT_LINKS);
  const { rows } = await pool.query('SELECT * FROM shared_links ORDER BY category, title');
  res.json({ ok: true, links: rows });
});

