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
 * Fix #6: reject javascript:, data:, file:, and any host outside the allowlist.
 * Only enforced when LINK_ALLOWED_HOSTS is configured — otherwise fail-open
 * with a warning so you don't lock yourself out on first deploy.
 */
export function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'Invalid URL.'); }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new HttpError(400, 'Only http(s) URLs are allowed.');
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (net.isIP(host)) {
    // IPv4 private/reserved ranges
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(host)) {
      throw new HttpError(400, 'Internal addresses are not allowed.');
    }
    // IPv6 loopback, link-local (fe80::/10), unique-local (fc00::/7)
    if (/^(::1$|fe[89ab][0-9a-f]:|f[cd])/i.test(host)) {
      throw new HttpError(400, 'Internal addresses are not allowed.');
    }
    // Block all other IPs — including 0.0.0.0 and any encoded forms
    throw new HttpError(400, 'IP address URLs are not allowed.');
  }

  // Block localhost and numeric shorthands net.isIP() won't catch
  if (/^localhost$/i.test(host) || /^0x/i.test(host) || /^\d+$/.test(host)) {
    throw new HttpError(400, 'Internal addresses are not allowed.');
  }

  if (LINK_ALLOWED_HOSTS.size > 0) {
    const ok = [...LINK_ALLOWED_HOSTS].some(h => host === h || host.endsWith('.' + h));
    if (!ok) throw new HttpError(400, `Host ${host} is not in the allowed list.`);
  }

  return u.toString();
}

export async function validateFileContent(buffer, safeName) {
  const ext = path.extname(safeName).slice(1).toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw new HttpError(400, `File type .${ext || 'unknown'} is not allowed.`);
  }
  if (TEXT_BASED_EXTS.has(ext)) {
    if (buffer.includes(0)) throw new HttpError(400, 'File contains binary data but has a text extension.');
    return;
  }
  if ((ext === 'jpg' || ext === 'jpeg') &&
      buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return;

  let detected;
  try { detected = await FileType.fromBuffer(buffer); }
  catch { throw new HttpError(400, 'Could not determine file type.'); }

  if (!detected) throw new HttpError(400, 'Unrecognized file format.');

  const extOk = detected.ext === ext ||
    (ext === 'jpg' && detected.ext === 'jpeg') ||
    (ext === 'jpeg' && detected.ext === 'jpg');
  if (!extOk) throw new HttpError(400, `File content (${detected.ext}) does not match extension (.${ext}).`);

  const expected = EXTENSION_MIME_MAP[ext] || [];
  if (expected.length && !expected.includes(detected.mime)) {
    throw new HttpError(400, `Detected MIME ${detected.mime} not allowed for .${ext}.`);
  }
}
