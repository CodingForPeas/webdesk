// wallpapers.js
// Shared definitions — imported by BOTH server (Node) and client (browser)
// This is the single source of truth for every wallpaper theme.

export const THEMES = /** @type {const} */ ({
  color: {
    midnight: { label: 'Midnight', color: '#0f172a' },
    slate: { label: 'Slate', color: '#1e293b' },
    white: { label: 'White', color: '#ffffff' },
    charcoal: { label: 'Charcoal', color: '#1a1a2e' },
  },
  gradient: {
    classic: { label: 'Classic', css: 'linear-gradient(135deg, #1e3c72, #2a5298)' },
    forest: { label: 'Forest', css: 'linear-gradient(135deg, #11998e, #38ef7d)' },
    purple: { label: 'Purple', css: 'linear-gradient(135deg, #8E2DE2, #4A00E0)' },
    sunset: { label: 'Sunset', css: 'linear-gradient(135deg, #ff7e5f, #feb47b)' },
    twilight: { label: 'Twilight', css: 'linear-gradient(135deg, #2b5876, #4e4376)' },
    ocean: { label: 'Ocean', css: 'linear-gradient(135deg, #000428, #004e92)' },
  },
  ambient: {
    'mesh-drift': {
      label: 'Mesh Drift',
      base: 'oklch(0.32 0.07 290)',
      nodes: [
        { c: 'oklch(0.72 0.19 12)', x: '18%', y: '24%' },
        { c: 'oklch(0.70 0.17 320)', x: '78%', y: '70%' },
        { c: 'oklch(0.74 0.15 250)', x: '50%', y: '78%' },
        { c: 'oklch(0.80 0.14 190)', x: '88%', y: '72%' },
        { c: 'oklch(0.86 0.16 82)', x: '30%', y: '52%' },
      ],
      dur: '28s',
    },
    tide: {
      label: 'Tide',
      base: 'oklch(0.28 0.05 230)',
      nodes: [
        { c: 'oklch(0.74 0.15 250)', x: '20%', y: '30%' },
        { c: 'oklch(0.78 0.13 210)', x: '80%', y: '60%' },
      ],
      dur: '34s',
    },
    ember: {
      label: 'Ember',
      base: 'oklch(0.30 0.06 30)',
      nodes: [
        { c: 'oklch(0.76 0.20 20)', x: '22%', y: '20%' },
        { c: 'oklch(0.72 0.18 40)', x: '75%', y: '75%' },
        { c: 'oklch(0.80 0.15 15)', x: '60%', y: '25%' },
      ],
      dur: '24s',
    },
    aurora: {
      label: 'Aurora',
      base: '#020510',
      nodes: [], // aurora uses its own CSS bands, not the mesh-drift node system
      dur: '18s',
    },
  },
});

// Client-side helper: build inline style for ambient themes at runtime
export function ambientStyle(id) {
  const t = THEMES.ambient[id];
  if (!t) throw new Error(`Unknown ambient theme: ${id}`);
  const stops = t.nodes.map(n =>
    `radial-gradient(42% 52% at ${n.x} ${n.y}, ${n.c}, transparent 62%)`
  ).join(', ');
  return {
    css: `background: var(--amb-base);`,
    base: t.base,
    nodes: t.nodes,
    dur: t.dur || '28s',
  };
}