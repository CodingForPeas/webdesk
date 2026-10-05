// routes/wallpaper.js
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import * as FileType from 'file-type';
import sharp from 'sharp';
import multer from 'multer';
import { pool } from '../lib/db.js';
import { getUser } from '../lib/auth.js';
import { validateFilename, isInside } from '../lib/validate.js';
import { wpUploadLimiter } from '../lib/security.js';
import { HttpError } from '../lib/errors.js';
import { WALL_DIR } from '../lib/config.js';
import { THEMES } from '../public/wallpapers.mjs';
import { writeWithQuota } from '../lib/storage.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export const wallpaperRouter = express.Router();

const VALID_KINDS = ['none', 'color', 'gradient', 'ambient', 'image'];

wallpaperRouter.get('/', getUser, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT wallpaper_kind, wallpaper_ref FROM users WHERE id = $1', [req.user.id]
  );
  if (!rows.length) throw new HttpError(404, 'User not found');
  res.json({ kind: rows[0].wallpaper_kind || 'gradient', ref: rows[0].wallpaper_ref });
});

wallpaperRouter.post('/', getUser, async (req, res) => {
  const { kind, ref } = req.body ?? {};
  if (!VALID_KINDS.includes(kind)) throw new HttpError(400, 'Invalid wallpaper kind.');

  if (kind === 'color' && !Object.hasOwn(THEMES.color, ref ?? '')) throw new HttpError(400, 'Unknown color theme.');

  if (kind === 'gradient' && !Object.hasOwn(THEMES.gradient, ref ?? '')) throw new HttpError(400, 'Unknown gradient theme.');

  if (kind === 'ambient' && !Object.hasOwn(THEMES.ambient, ref)) throw new HttpError(400, 'Unknown ambient theme.');

  if (kind === 'image' && !/^[a-f0-9]{64}\.webp$/.test(ref || '')) throw new HttpError(400, 'Invalid image reference.');

  const r = await pool.query(
    'UPDATE users SET wallpaper_kind = $1, wallpaper_ref = $2 WHERE id = $3',
    [kind, ref || null, req.user.id]
  );
  if (!r.rowCount) throw new HttpError(404, 'User not found');
  res.json({ ok: true, kind, ref: ref || null });
});

wallpaperRouter.post('/upload', getUser, wpUploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file?.buffer?.length) throw new HttpError(400, 'No file data.');

  const sniffed = await FileType.fileTypeFromBuffer(req.file.buffer);
  if (!sniffed || !new Set(['jpeg', 'png', 'webp', 'avif']).has(sniffed.ext)) {
    throw new HttpError(415, 'Only JPEG, PNG, WebP, or AVIF images allowed.');
  }

  const meta = await sharp(req.file.buffer, { failOn: 'error' }).metadata();
  if ((meta.width ?? 0) > 8192 || (meta.height ?? 0) > 8192 || (meta.pages ?? 1) > 1) {
    throw new HttpError(413, 'Image too large or animated.');
  }

  const out = await sharp(req.file.buffer)
    .rotate()
    .resize(2560, 2560, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();

  const hash = crypto.createHash('sha256').update(out).digest('hex');
  const name = `${hash}.webp`;
  const dir  = path.join(WALL_DIR, req.user.id);
  const dest = path.join(dir, name);
  if (!isInside(dir, dest)) throw new HttpError(403, 'Access denied');

  let prevSize = 0n;
  try { prevSize = BigInt((await fs.stat(dest)).size); } catch {}

  if (!prevSize) {
    await fs.mkdir(dir, { recursive: true });
    const files = await fs.readdir(dir).catch(() => []);
    if (files.filter(f => f.endsWith('.webp')).length >= 5) {
      throw new HttpError(409, 'Wallpaper limit reached (5 max).');
    }
  }

  await writeWithQuota(req.user.id, dest, out);

  await pool.query(
    'UPDATE users SET wallpaper_kind = $1, wallpaper_ref = $2 WHERE id = $3',
    ['image', name, req.user.id]
  );

  res.json({ ok: true, wallpaper: { kind: 'image', ref: name } });
});

// GET /api/wallpapers/:filename — fix #7 applied here
wallpaperRouter.get('/:filename', getUser, async (req, res) => {
  const safeName = validateFilename(req.params.filename);
  if (!safeName) throw new HttpError(400, 'Invalid filename');
  if (!safeName.endsWith('.webp')) throw new HttpError(400, 'Only WebP images allowed');

  const dir  = path.join(WALL_DIR, req.user.id);
  const file = path.join(dir, safeName);
  if (!isInside(dir, file)) throw new HttpError(403, 'Access denied');

  // Ownership check: only serve a file this user's row references
  const { rows } = await pool.query(
    `SELECT wallpaper_ref FROM users
      WHERE id = $1 AND wallpaper_kind = 'image' AND wallpaper_ref = $2`,
    [req.user.id, safeName]
  );
  if (!rows.length) throw new HttpError(403, 'Access denied');

  try {
    await fs.access(file);
  } catch {
    throw new HttpError(404, 'Not found');
  }

  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Type', 'image/webp');
  res.sendFile(file);          // ← was res.sendFile(file, safeName): bogus second arg
});

