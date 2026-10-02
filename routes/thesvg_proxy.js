// routes/thesvg.js
import express from 'express';
import { fetchSvg } from '../lib/thesvg.js';
import { HttpError } from '../lib/errors.js';

export const thesvgRouter = express.Router();

const SAFE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

thesvgRouter.get('/:slug/:variant.svg', async (req, res) => {
  const { slug, variant } = req.params;
  if (!SAFE.test(slug) || !SAFE.test(variant)) throw new HttpError(400, 'Invalid icon');

  const svg = await fetchSvg(slug, variant);
  if (!svg) throw new HttpError(404, 'Icon not found');

  res.set({
    'Content-Type': 'image/svg+xml',
    'X-Content-Type-Options': 'nosniff',
    // Safe in <img>, and inert if someone opens the URL directly
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'public, max-age=86400',
  });
  res.send(svg);
});
