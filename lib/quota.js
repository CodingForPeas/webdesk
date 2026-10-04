// lib/quota.js
import crypto from 'crypto';
import { pool } from './db.js';
import { DISK_QUOTA } from './config.js';

function userLockId(userId) {
  const digest = crypto.createHash('sha256').update(String(userId)).digest();
  return BigInt(`0x${digest.subarray(0, 8).toString('hex')}`);
}

async function withUserQuotaLock(userId, fn) {
  const client = await pool.connect();

  try {
    const lockId = userLockId(userId);
    await client.query('SELECT pg_advisory_lock($1::bigint)', [lockId.toString()]);
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockId.toString()]);
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
      `UPDATE users
         SET used_bytes = GREATEST(0, used_bytes - $2::bigint)
       WHERE id = $1`,
      [userId, bytes.toString()]
    );
  });
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