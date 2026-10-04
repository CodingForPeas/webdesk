// lib/validate.js
import path from 'path';
import net from 'net';
import * as FileType from 'file-type';
import { ALLOWED_EXTENSIONS, TEXT_BASED_EXTS, EXTENSION_MIME_MAP, LINK_ALLOWED_HOSTS } from './config.js';
import { HttpError } from './errors.js';

export function validateFilename(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const safe = path.basename(filename);
  if (!/^[a-zA-Z0-9._-]+$/.test(safe)) return null;
  if (!safe || safe === '.' || safe === '..') return null;
  return safe;
}

export function isInside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

export function assertAllowedExt(safeName) {
  const ext = path.extname(safeName).slice(1).toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw new HttpError(400, `File type .${ext || 'unknown'} is not allowed.`);
  }
  return ext;
}

/**
 * Security: reject javascript:, data:, file:, localhost/loopback, and
 * any host not in the allowlist in production.
 *
 * Dev mode:
 *  - if no allowlist is set, warn and allow
 *  - this is only for local/dev use and should not be used in prod
 */
export function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'Invalid URL.');
  }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new HttpError(400, 'Only http(s) URLs are allowed.');
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (net.isIP(host)) {
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(host)) {
      throw new HttpError(400, 'Internal addresses are not allowed.');
    }
    if (/^(::1$|fe[89ab][0-9a-f]:|f[cd])/i.test(host)) {
      throw new HttpError(400, 'Internal addresses are not allowed.');
    }
    throw new HttpError(400, 'IP address URLs are not allowed.');
  }

  if (/^localhost$/i.test(host) || /^0x/i.test(host) || /^\d+$/.test(host)) {
    throw new HttpError(400, 'Internal addresses are not allowed.');
  }

  // Fail closed in production: if no allowlist is configured, reject
  if (LINK_ALLOWED_HOSTS.size === 0) {
    if (process.env.NODE_ENV === 'production') {
      throw new HttpError(
        403,
        'Shared link URLs are disabled: LINK_ALLOWED_HOSTS is not configured in production.'
      );
    }

    console.warn('⚠️  LINK_ALLOWED_HOSTS is empty — allowing all hosts only in dev mode.');
    return u.toString();
  }

  const ok = [...LINK_ALLOWED_HOSTS].some(h => host === h || host.endsWith('.' + h));
  if (!ok) {
    throw new HttpError(400, `Host ${host} is not in the allowed list.`);
  }

  return u.toString();
}

export async function validateFileContent(buffer, safeName) {
  const ext = path.extname(safeName).slice(1).toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw new HttpError(400, `File type .${ext || 'unknown'} is not allowed.`);
  }

  if (TEXT_BASED_EXTS.has(ext)) {
    if (buffer.includes(0)) {
      throw new HttpError(400, 'File contains binary data but has a text extension.');
    }
    return;
  }

  if ((ext === 'jpg' || ext === 'jpeg') &&
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff) {
    return;
  }

  let detected;
  try {
    detected = await FileType.fromBuffer(buffer);
  } catch {
    throw new HttpError(400, 'Could not determine file type.');
  }

  if (!detected) {
    throw new HttpError(400, 'Unrecognized file format.');
  }

  const extOk = detected.ext === ext ||
    (ext === 'jpg' && detected.ext === 'jpeg') ||
    (ext === 'jpeg' && detected.ext === 'jpg');

  if (!extOk) {
    throw new HttpError(400, `File content (${detected.ext}) does not match extension (.${ext}).`);
  }

  const expected = EXTENSION_MIME_MAP[ext] || [];
  if (expected.length && !expected.includes(detected.mime)) {
    throw new HttpError(400, `Detected MIME ${detected.mime} not allowed for .${ext}.`);
  }
}