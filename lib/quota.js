// lib/quota.js
import { pool } from './db.js';
import { DISK_QUOTA } from './config.js';

const LOCK_TIMEOUT_MS = 10000; // max 10s per user's quota operation
const activeLocks = new Map(); // userId -> { resolve, timer }

/**
 * Serializes quota operations per user using a simple in-memory lock.
 * For multi-instance deployments, replace with DB advisory locks.
 */
async function acquireUserLock(userId) {
  while (activeLocks.has(userId)) {
    await new Promise(resolve => {
      const existing = activeLocks.get(userId);
      // Stack handlers in a queue if needed
      const originalResolve = existing.resolve;
      existing.resolve = () => {
        originalResolve();
        resolve();
      };
    });
  }

  const lock = { resolve: null };
  activeLocks.set(userId, lock);

  return new Promise(resolve => {
    lock.resolve = resolve;
    const timer = setTimeout(() => {
      activeLocks.delete(userId);
      resolve();
    }, LOCK_TIMEOUT_MS);
    lock.timer = timer;
  }).then(() => {
    clearTimeout(lock.timer);
    activeLocks.delete(userId);
  });
}

// Atomically reserves `bytes` against the user's quota. Returns true if allowed.
export async function reserveQuota(userId, bytes) {
  const unlock = await acquireUserLock(userId);
  try {
    const { rows } = await pool.query(
      `UPDATE users
          SET used_bytes = used_bytes + $2::bigint
        WHERE id = $1
          AND used_bytes + $2::bigint <= $3::bigint
        RETURNING used_bytes`,
      [userId, bytes.toString(), DISK_QUOTA.toString()]
    );
    return rows.length > 0;
  } finally {
    unlock();
  }
}

export async function releaseQuota(userId, bytes) {
  const unlock = await acquireUserLock(userId);
  try {
    await pool.query(
      `UPDATE users SET used_bytes = GREATEST(0, used_bytes - $2::bigint) WHERE id = $1`,
      [userId, bytes.toString()]
    );
  } finally {
    unlock();
  }
}

/* Better long-term approach (multi-instance safe): If you scale to multiple app instances, use PostgreSQL advisory locks instead:
// lib/quota.js — multi-instance version
import { pool } from './db.js';
import { DISK_QUOTA } from './config.js';

function hashUserId(userId) {
  // Convert userId to a 32-bit integer for advisory lock
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

async function withUserQuotaLock(userId, fn) {
  const client = await pool.connect();
  try {
    const lockId = hashUserId(userId);
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    }
  } finally {
    client.release();
  }
}

export async function reserveQuota(userId, bytes) {
  return withUserQuotaLock(userId, async (client) => {
    const { rows } = await client.query(
      `UPDATE users
          SET used_bytes = used_bytes + $2::bigint
        WHERE id = $1
          AND used_bytes + $2::bigint <= $3::bigint
        RETURNING used_bytes`,
      [userId, bytes.toString(), DISK_QUOTA.toString()]
    );
    return rows.length > 0;
  });
}

export async function releaseQuota(userId, bytes) {
  return withUserQuotaLock(userId, async (client) => {
    await client.query(
      `UPDATE users SET used_bytes = GREATEST(0, used_bytes - $2::bigint) WHERE id = $1`,
      [userId, bytes.toString()]
    );
  });
}
*/