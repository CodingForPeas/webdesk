// lib/thesvg.js
import { THESVG_URL } from './config.js';

const TTL_MS = 60 * 60 * 1000;
let index = null;      // [{ slug, variant, keys: Set<string> }]
let indexAt = 0;
let pending = null;

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function buildIndex(list) {
  return list.map(icon => {
    const variantKeys = icon.variants && typeof icon.variants === 'object'
      ? Object.keys(icon.variants) : [];
    const variant = variantKeys.includes('default') ? 'default' : (variantKeys[0] || 'default');
    const keys = new Set([norm(icon.slug), norm(icon.title)]);
    (Array.isArray(icon.aliases) ? icon.aliases : []).forEach(a => keys.add(norm(a)));
    keys.delete('');
    return { slug: icon.slug, variant, keys };
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
    if (index) return index;   // serve stale cache if thesvg is briefly down
    throw e;
  }
}

// "github.com" / "www.map.mortis.org.uk" -> candidate names
function hostCandidates(rawUrl) {
  try {
    const parts = new URL(rawUrl).hostname.replace(/^www\./, '').split('.');
    return parts.length > 2 ? [parts[0], parts[parts.length - 2]] : [parts[0]];
  } catch { return []; }
}

// Returns a same-origin icon URL, or '' if nothing matches. Never throws.
export async function findIconUrl(title, url) {
  try {
    const idx = await loadIndex();
    const candidates = [title, ...hostCandidates(url)].map(norm).filter(c => c.length >= 2);
    for (const c of candidates) {
      const hit = idx.find(i => i.keys.has(c));
      if (hit) return `/api/thesvg/${encodeURIComponent(hit.slug)}/${encodeURIComponent(hit.variant)}.svg`;
    }
  } catch (e) {
    console.warn('thesvg lookup failed:', e.message);
  }
  return '';
}

export async function fetchSvg(slug, variant) {
  const r = await fetch(
    `${THESVG_URL}/icons/${encodeURIComponent(slug)}/${encodeURIComponent(variant)}.svg`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length > 1024 * 1024 ? null : buf;
}
