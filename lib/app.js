// lib/app.js
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import * as FileType from 'file-type';

import { ROOT_DIR, IS_PROD } from './config.js';
import { nonceMiddleware, securityMiddleware, apiLimiter } from './security.js';
import { createCsrfRouter, csrfMiddleware } from './csrf.js';
import { errorHandler } from './errors.js';

import { healthRouter } from '../routes/health.js';
import { linksRouter } from '../routes/links.js';
import { layoutRouter } from '../routes/layout.js';
import { wallpaperRouter } from '../routes/wallpaper.js';
import { filesRouter } from '../routes/files.js';
import { meRouter } from '../routes/me.js';
import { dockerRouter } from '../routes/docker.js';

// Keep your file-type v16 guard — it catches the ESM/CJS footgun at boot
const require_ = (await import('module')).createRequire(import.meta.url);
/* Not Required, keeping for reference
const ftVersion = require_('file-type/package.json').version;
if (!ftVersion.startsWith('16.')) {
  throw new Error(`file-type v${ftVersion} is ESM-only. Pin to file-type@16.x in your Dockerfile.`);
} */

const app = express();

app.set('trust proxy', 1);

app.use(nonceMiddleware);
app.use(securityMiddleware());

app.use(cookieParser());
app.use(cors({ origin: ['https://homu.mortis.org.uk', 'http://localhost:3000'] }));

app.use('/api/csrf-token', createCsrfRouter());

app.use('/api/health', healthRouter);

app.use('/api', csrfMiddleware);

app.use('/api', apiLimiter);

app.use('/api/docker', dockerRouter);


app.use(express.json({ limit: '1mb' }));

// Redirect direct /index.html access so there's one canonical document
app.get('/index.html', (_req, res) => res.redirect(308, '/'));

app.use(express.static(path.join(ROOT_DIR, 'public'), {
  index: false,
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (/\.(js|css|mjs)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

let indexTemplate = null;
async function loadTemplate() {
  indexTemplate = await fs.readFile(path.join(ROOT_DIR, 'public', 'index.html'), 'utf8');
}
app.get('/', async (_req, res) => {
  if (!indexTemplate) await loadTemplate();
  res.type('html');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(indexTemplate.replaceAll('%%NONCE%%', res.locals.nonce));
});

app.use('/api/links', linksRouter);
app.use('/api/layout', layoutRouter);
app.use('/api/wallpapers', wallpaperRouter);
app.use('/api/files', filesRouter);
app.use('/api/me', meRouter);

app.use(errorHandler);

export { app, loadTemplate };

