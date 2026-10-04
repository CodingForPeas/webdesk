// lib/csrf.js
import crypto from 'crypto';
import express from 'express';
import { createClient } from 'redis';
import { HttpError } from './errors.js';

const TTL_SECONDS = 5 * 60; // 5 min
const MAX_TOKENS = 100_000;

let redisClient = null;

async function getRedis() {
  if (!redisClient) {
    redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: { reconnectStrategy: (retries) => Math.min(retries * 50, 500) },
    });
    redisClient.on('error', (err) => console.error('Redis CSRF error:', err));
    await redisClient.connect();
  }
  return redisClient;
}

function ownerKey(req) {
  return crypto.createHash('sha256')
    .update(String(req.headers['remote-user'] || 'anon'))
    .digest('hex')
    .slice(0, 32);
}

export async function initCsrf() {
  await getRedis();
  console.log('CSRF token store: Redis');
}

export function createCsrfRouter() {
  const r = express.Router();
  r.get('/', async (req, res) => {
    const redis = await getRedis();
    const count = await redis.dbSize();
    if (count >= MAX_TOKENS) {
      return res.status(503).json({ error: 'Too many active tokens' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const owner = ownerKey(req);
    const key = `csrf:${token}`;
    await redis.setEx(key, TTL_SECONDS, owner);
    res.json({ token });
  });
  return r;
}

/**
 * Single-use CSRF check. Tokens are consumed on first successful use.
 */
export async function csrfMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();

  const token = req.headers['x-csrf-token'];
  if (!token) return res.status(403).json({ error: 'CSRF token missing' });

  const redis = await getRedis();
  const key = `csrf:${token}`;
  const owner = await redis.getEx(key, { EX: 0 });  // get and delete atomically (TTL=0)

  if (!owner) return res.status(403).json({ error: 'CSRF token invalid or already used' });

  const expectedOwner = ownerKey(req);
  if (owner !== expectedOwner) {
    return res.status(403).json({ error: 'CSRF token does not match session' });
  }

  next();
}

export async function closeRedis() {
  if (redisClient) await redisClient.quit();
}