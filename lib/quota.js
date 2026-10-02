// lib/quota.js
import { pool } from './db.js';
import { DISK_QUOTA } from './config.js';

/** Atomically reserves `bytes` against the user's quota. Returns true if allowed. */
export async function reserveQuota(userId, bytes) {
  const { rows } = await pool.query(
    `UPDATE users
        SET used_bytes = used_bytes + $2::bigint
      WHERE id = $1
        AND used_bytes + $2::bigint <= $3::bigint
      RETURNING used_bytes`,
    [userId, bytes.toString(), DISK_QUOTA.toString()]
  );
  return rows.length > 0;
}

export async function releaseQuota(userId, bytes) {
  await pool.query(
    `UPDATE users SET used_bytes = GREATEST(0, used_bytes - $2::bigint) WHERE id = $1`,
    [userId, bytes.toString()]
  );
}


