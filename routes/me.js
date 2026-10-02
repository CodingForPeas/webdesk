// routes/me.js
import express from 'express';
import { pool } from '../lib/db.js';
import { getUser } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';

export const meRouter = express.Router();

meRouter.get('/', getUser, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT email, name, wallpaper_kind, wallpaper_ref, used_bytes FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!rows.length) throw new HttpError(404, 'User not found');

  const groups = String(req.headers['remote-groups'] || '')
    .split(',').map(g => g.trim().toLowerCase());

  res.json({
    email: rows[0].email,
    name: rows[0].name,
    wallpaper: {
      kind: rows[0].wallpaper_kind || 'gradient',
      ref:  rows[0].wallpaper_ref  || 'classic',
    },
    usedBytes: Number(rows[0].used_bytes),
    isAdmin: groups.includes('admin'),
  });
});

