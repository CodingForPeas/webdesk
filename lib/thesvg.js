// lib/thesvg.js
import fs from 'fs/promises';
import path from 'path';
import { THESVG_URL, THESVG_REGISTRY, ICONS_DIR } from './config.js';

const TTL_MS = 60 * 60 * 1000;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

let index = null;      // [{ slug, variant, keys: Set<string> }]
let indexAt = 0;
let pending = null;

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');


const hostOf = u => {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
};

function buildIndex(list) {
  return list.map(icon => {
    const vk = Array.isArray(icon.variants) ? icon.variants.filter(v => typeof v === 'string') : [];
    const variant = vk.includes('default') ? 'default' : (vk[0] || 'default');
    const keys = new Set([norm(icon.slug), norm(icon.title)]);
    (Array.isArray(icon.aliases) ? icon.aliases : []).forEach(a => keys.add(norm(a)));
    keys.delete('');
    return { slug: icon.slug, variant, keys, host: hostOf(icon.url) };
  }).filter(i => i.slug);
}

async function loadIndex() {
  if (index && Date.now() - indexAt < TTL_MS) return index;
  if (!pending) {
    pending = (async () => {
      const r = await fetch(`${THESVG_URL}/api/registry.json`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`thesvg registry HTTP ${r.status}`);
      const data = await r.json();
      const list = Array.isArray(data) ? data : data.icons;
      if (!Array.isArray(list)) throw new Error('Unexpected registry shape');
      index = buildIndex(list);
      indexAt = Date.now();
      return index;
    })().finally(() => { pending = null; });
  }
  try {
    return await pending;
  } catch (e) {
    if (index) return index;   // stale cache beats nothing
    throw e;
  }
}

function hostCandidates(rawUrl) {
  try {
    const parts = new URL(rawUrl).hostname.replace(/^www\./, '').split('.');
    return parts.length > 2 ? [parts[0], parts[parts.length - 2]] : [parts[0]];
  } catch { return []; }
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// Downloads the SVG into ICONS_DIR (once) and returns its local path, e.g. /icons/thesvg-github.svg
async function downloadIcon(slug, variant) {
  if (!SAFE_NAME.test(slug) || !SAFE_NAME.test(variant)) return '';
  // console.warn('TheSVG URL: ', `${THESVG_URL}/icons/${encodeURIComponent(slug)}/${encodeURIComponent(variant)}.svg`);

  // "thesvg-" prefix so we never overwrite your hand-picked icons (github.svg etc.)
  const fileName = variant === 'default' ? `thesvg-${slug}.svg` : `thesvg-${slug}-${variant}.svg`;
  const dest = path.join(ICONS_DIR, fileName);
  const publicPath = `/icons/${fileName}`;

  if (await exists(dest)) return publicPath;

  const r = await fetch(
    `${THESVG_URL}/icons/${encodeURIComponent(slug)}/${encodeURIComponent(variant)}.svg`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!r.ok) return '';

  const svg = await r.text();
  if (svg.length > 1024 * 1024 || !/<svg[\s>]/i.test(svg)) return '';
  // Icons get served from your own origin, so refuse anything scriptable
  if (/<script|\son\w+\s*=|<foreignObject|javascript:/i.test(svg)) return '';

  await fs.mkdir(ICONS_DIR, { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await fs.writeFile(tmp, svg, 'utf8');
  await fs.rename(tmp, dest);        // atomic, so no half-written files
  return publicPath;
}

// Returns a local icon path, or '' if nothing matched. Never throws.
export async function findIconUrl(title, url) {
  if (!THESVG_URL || !THESVG_REGISTRY) return '';
  try {
    const idx = await loadIndex();
    let hit = null;

    // 1. Exact name match (title, slug or alias)
    const titleKey = norm(title);
    if (titleKey.length >= 2) {
      hit = idx.find(i => i.keys.has(titleKey));
    }

    // 2. Exact website match (github.com -> GitHub)
    if (!hit) {
      const h = hostOf(url);
      if (h) hit = idx.find(i => i.host === h);
    }

    // 3. Guess from hostname parts (e.g. "docker" from docker.example.com)
    if (!hit) {
      for (const c of hostCandidates(url).map(norm).filter(c => c.length >= 2)) {
        hit = idx.find(i => i.keys.has(c));
        if (hit) break;
      }
    }

    if (hit) {
      console.warn('thesvg hit:', hit.slug, hit.variant);
      return await downloadIcon(hit.slug, hit.variant);
    }
    console.warn('thesvg: no match for', title, url);
  } catch (e) {
    console.warn('thesvg lookup failed:', e.message);
  }
  return '';
}

// Keeping for posterity, but not used by the app itself. Use findIconUrl() instead.
export async function fetchSvg(slug, variant) {
  const r = await fetch(
    `${THESVG_URL}/icons/${encodeURIComponent(slug)}/${encodeURIComponent(variant)}.svg`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length > 1024 * 1024 ? null : buf;
}
