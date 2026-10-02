// lib/auth.js
import crypto from 'crypto';
import { pool } from './db.js';
import { HttpError } from './errors.js';
import { IS_PROD } from './config.js';

function devModeEnabled() {
  // Belt-and-braces: never allow the bypass once NODE_ENV says production,
  // even if DEV_MODE=1 leaks into the environment by accident.
  if (IS_PROD) return false;
  return process.env.DEV_MODE === '1';
}

if (devModeEnabled()) {
  console.warn('⚠️  DEV_MODE auth bypass is ACTIVE. Do not use in production.');
}

export async function getUser(req, res, next) {
  if (devModeEnabled()) {
    req.user = { id: 'dev-user', email: 'dev@example.com', name: 'Dev User', groups: 'admins' };
    return next();
  }

  const username = req.headers['remote-user'];
  const email    = req.headers['remote-email'];
  const name     = req.headers['remote-name'];
  const groups   = req.headers['remote-groups'];

  if (!username) throw new HttpError(401, 'Unauthorized. No Remote-User header.');

  const safeId   = crypto.createHash('sha256').update(username).digest('hex');
  const safeName = String(name || username).replace(/[^a-zA-Z0-9_. -]/g, '');

  await pool.query(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [safeId, email || safeId + '@mortis.org.uk', safeName]
  );

  req.user = { id: safeId, email, name: safeName, groups };
  next();
}

export function requireAdmin(req, res, next) {
  if (devModeEnabled()) return next();
  const groups = String(req.headers['remote-groups'] || '').split(',').map(g => g.trim().toLowerCase());
  if (!groups.includes('admin')) throw new HttpError(403, 'Admin group required');
  next();
}

