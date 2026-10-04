// lib/csrf.js
import crypto from 'crypto';
import express from 'express';
import { createClient } from 'redis';

const TTL_SECONDS = 5 * 60;
const MAX_TOKENS = 100_000;
const REDIS_KEY_PREFIX = 'csrf:';

let redisClient = null;

async function getRedis() {
  if (!redisClient) {
    redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 50, 500),
      },
    });

    redisClient.on('error', (err) => console.error('Redis CSRF error:', err));
    await redisClient.connect();
  }

  return redisClient;
}

function csrfKey(token) {
  return `${REDIS_KEY_PREFIX}${token}`;
}

function ownerKey(req) {
  return crypto
    .createHash('sha256')
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

    try {
      const matches = await redis.keys(`${REDIS_KEY_PREFIX}*`);
      if (matches.length >= MAX_TOKENS) {
        return res.status(503).json({ error: 'Too many active tokens' });
      }

      const token = crypto.randomBytes(32).toString('base64url');
      const owner = ownerKey(req);
      const key = csrfKey(token);

      await redis.setEx(key, TTL_SECONDS, owner);
      return res.json({ token });
    } catch (err) {
      console.error('Failed to create CSRF token:', err);
      return res.status(500).json({ error: 'Could not create CSRF token.' });
    }
  });

  return r;
}

/**
 * Single-use CSRF check.
 * getDel() atomically retrieves and removes the token.
 */
export async function csrfMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return next();
  }

  const token = req.headers['x-csrf-token'];
  if (!token) {
    return res.status(403).json({ error: 'CSRF token missing' });
  }

  try {
    const redis = await getRedis();
    const key = csrfKey(token);
    const owner = await redis.getDel(key);

    if (!owner) {
      return res.status(403).json({ error: 'CSRF token invalid or already used' });
    }

    const expectedOwner = ownerKey(req);
    if (owner !== expectedOwner) {
      return res.status(403).json({ error: 'CSRF token does not match session' });
    }

    next();
  } catch (err) {
    console.error('CSRF validation failed:', err);
    return res.status(500).json({ error: 'CSRF validation error.' });
  }
}

export async function closeRedis() {
  if (redisClient) {
    await redisClient.quit();
  }
}