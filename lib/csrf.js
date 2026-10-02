// lib/csrf.js
import crypto from 'crypto';
import express from 'express';

const TTL_MS = 5 * 60_000;
const MAX_TOKENS = 100_000; // prevent unbounded Map growth

// token -> { expires, owner }   owner = sha256(remote-user), so tokens
// can't be replayed across identities even if leaked.
// NOTE: tokens are stored in-memory and are intentionally single-process.
// On restart all active tokens are invalidated — clients will fetch a fresh
// one automatically on their next write (withCsrf() retries on 403).
// If this ever moves to a multi-process/multi-instance deployment, replace
// this Map with a shared store (Redis, or a DB table with a TTL index).
const tokens = new Map();

function ownerKey(req) {
  return crypto.createHash('sha256')
    .update(String(req.headers['remote-user'] || 'anon'))
    .digest('hex').slice(0, 32);
}

export function createCsrfRouter() {
  const r = express.Router();
  r.get('/', (req, res) => {  // ← was '/csrf-token'
    if (tokens.size >= MAX_TOKENS) {
      return res.status(503).json({ error: 'Too many active tokens' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    tokens.set(token, { expires: Date.now() + TTL_MS, owner: ownerKey(req) });
    res.json({ token });
  });
  return r;
}

/**
 * Single-use CSRF check. Tokens are consumed on first successful use;
 * the client fetches a fresh one per write (see app.js changes below).
 */
export function csrfMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();

  const token = req.headers['x-csrf-token'];
  if (!token) return res.status(403).json({ error: 'CSRF token missing' });

  const rec = tokens.get(token);
  if (!rec) return res.status(403).json({ error: 'CSRF token invalid or already used' });

  // Consume FIRST — closes the TOCTOU/replay window entirely.
  tokens.delete(token);

  if (rec.expires < Date.now()) {
    return res.status(403).json({ error: 'CSRF token expired' });
  }
  if (rec.owner !== ownerKey(req)) {
    return res.status(403).json({ error: 'CSRF token does not match session' });
  }

  next();
}

// Periodic sweep of expired tokens
setInterval(() => {
  const now = Date.now();
  for (const [t, rec] of tokens) if (rec.expires < now) tokens.delete(t);
}, 60_000).unref();

