// lib/storage.js
import fs from 'fs/promises';
import { reserveQuota, releaseQuota } from './quota.js';
import { HttpError } from './errors.js';

/**
 * Write `buffer` to `filePath`, atomically tracking quota for `userId`.
 * Handles new files, overwrites (delta), and quota rollback on failure.
 */
export async function writeWithQuota(userId, filePath, buffer) {
  const incoming = BigInt(buffer.length);

  let previousSize = 0n;
  try {
    const st = await fs.stat(filePath);
    if (st.isFile()) previousSize = BigInt(st.size);
  } catch { /* new file */ }

  const delta = incoming - previousSize;

  if (delta > 0n && !(await reserveQuota(userId, delta))) {
    throw new HttpError(413, 'Disk quota exceeded.');
  }

  try {
    await fs.writeFile(filePath, buffer);
  } catch (e) {
    if (delta > 0n) await releaseQuota(userId, delta);
    throw e;
  }

  if (delta < 0n) await releaseQuota(userId, -delta);
}