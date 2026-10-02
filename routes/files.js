// routes/files.js
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import { getUser } from '../lib/auth.js';
import { validateFilename, isInside, validateFileContent, assertAllowedExt } from '../lib/validate.js';
import { releaseQuota } from '../lib/quota.js';
import { uploadLimiter } from '../lib/security.js';
import { HttpError } from '../lib/errors.js';
import { FILES_DIR, TEXT_BASED_EXTS } from '../lib/config.js';
import { writeWithQuota } from '../lib/storage.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export const filesRouter = express.Router();

filesRouter.use(getUser);

// --- Download ---
filesRouter.get('/download/:filename', async (req, res) => {
  const safeName = validateFilename(req.params.filename);
  if (!safeName) throw new HttpError(400, 'Invalid filename');
  assertAllowedExt(safeName);

  const userDir  = path.join(FILES_DIR, req.user.id);
  const filePath = path.join(userDir, safeName);
  if (!isInside(userDir, filePath)) throw new HttpError(403, 'Access denied');

  try {
    await fs.access(filePath);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  res.download(filePath, safeName);   // download() DOES accept a filename alias
});

// --- List ---
filesRouter.get('/', async (req, res) => {
  const userDir = path.join(FILES_DIR, req.user.id);
  await fs.mkdir(userDir, { recursive: true });
  const files = await fs.readdir(userDir);

  const stats = await Promise.all(files.map(async f => {
    try {
      const st = await fs.stat(path.join(userDir, f));
      if (!st.isFile()) return null;
      return { name: f, size: st.size, modified: st.mtime };
    } catch {
      return null;
    }
  }));
  res.json(stats.filter(Boolean));
});

// --- Upload ---
filesRouter.post('/upload', uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file?.buffer?.length) {
    throw new HttpError(400, 'No file data received. Please ensure the file is not empty.');
  }

  const safeName = validateFilename(req.query.filename || req.file.originalname || 'untitled.bin');
  if (!safeName) {
    throw new HttpError(400, 'Invalid filename. Use only alphanumeric characters, dots, underscores, and hyphens.');
  }

  await validateFileContent(req.file.buffer, safeName);

  const userDir  = path.join(FILES_DIR, req.user.id);
  const filePath = path.join(userDir, safeName);
  if (!isInside(userDir, filePath)) throw new HttpError(403, 'Access denied');
  await fs.mkdir(userDir, { recursive: true });

  await writeWithQuota(req.user.id, filePath, req.file.buffer);

  res.json({ ok: true, name: safeName, size: req.file.buffer.length });
});

// --- Delete ---
filesRouter.delete('/:filename', async (req, res) => {
  const safeName = validateFilename(req.params.filename);
  if (!safeName) throw new HttpError(400, 'Invalid filename');
  assertAllowedExt(safeName);

  const userDir  = path.join(FILES_DIR, req.user.id);
  const filePath = path.join(userDir, safeName);
  if (!isInside(userDir, filePath)) throw new HttpError(403, 'Access denied');

  let size = 0n;
  try {
    size = BigInt((await fs.stat(filePath)).size);
  } catch {
    throw new HttpError(404, 'Not found');
  }

  await fs.unlink(filePath);
  await releaseQuota(req.user.id, size);
  res.json({ ok: true });
});

// --- Create text file ---
filesRouter.post('/create', async (req, res) => {
  const { name, content } = req.body ?? {};
  const safeName = validateFilename(name || 'newfile.txt');
  if (!safeName) throw new HttpError(400, 'Invalid filename');

  const ext = assertAllowedExt(safeName);
  if (!TEXT_BASED_EXTS.has(ext)) {
    throw new HttpError(400, 'Only text-based files can be created via this endpoint.');
  }
  if (typeof content !== 'string') throw new HttpError(400, 'Content must be a string.');
  if (content.includes('\0')) throw new HttpError(400, 'Content contains null bytes.');

  const userDir  = path.join(FILES_DIR, req.user.id);
  const filePath = path.join(userDir, safeName);
  if (!isInside(userDir, filePath)) throw new HttpError(403, 'Access denied');
  await fs.mkdir(userDir, { recursive: true });

  const buf = Buffer.from(content || '', 'utf-8');

  await writeWithQuota(req.user.id, filePath, buf);

  res.json({ ok: true, name: safeName });
});

