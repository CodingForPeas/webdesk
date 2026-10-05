'use strict';

import { THEMES } from '/wallpapers.mjs';
import { createDockerPanel } from '/docker-monitor.js';

// ================= Config =================
const API = '/api';
const MIN_ICON = 32, MAX_ICON = 96, DEFAULT_ICON = 48;

let state = {
  user: null,
  sharedLinks: [],
  myLayout: [],
  hiddenLinks: [],
  wallpaper: null,                 // [CHANGED] was WALLPAPERS[0]; unused now that THEMES drives rendering
  theme: localStorage.getItem('desktop_theme') || 'light',
  nextX: 24, nextY: 24,
  fmIconPos: { x: 24, y: 740 }
};

let zTop = 100001;
let selectedIcon = null;
let ctxTarget = null;
let ctxPos = { x: 0, y: 0 };
let suppressDesktopCtx = false;
let csrfToken = null;    // [CHANGED] now owned by getCsrfToken/withCsrf only
let csrfPending = null;

const openWins = new Map();

// DOM Elements
const desktop = document.getElementById('desktop');
const taskbar = document.getElementById('taskbar');
const clock = document.getElementById('clock');
const ctxmenu = document.getElementById('ctxmenu');
const modalBg = document.getElementById('modal-bg');
const wallpaperModal = document.getElementById('wallpaper-modal');
const wallpaperEl = document.getElementById('wallpaper');
const syncStatus = document.getElementById('sync-status');
const FALLBACK_ICON = '/icons/link.svg';

// ================= Helpers =================
function userIsAdmin() {
  return !!(state.user && state.user.isAdmin);
}

function escapeHtml(s) {
  const d = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, c => d[c]);
}

function uiIcon(name, className = '') {
  return `<svg class="ui-icon ${className}" aria-hidden="true" focusable="false"><use href="/icons/ui.svg#${name}"></use></svg>`;
}

function setStatus(msg, isError) {
  syncStatus.textContent = msg;
  syncStatus.className = isError ? 'error' : '';
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
const debouncedSaveLayout = debounce(() => saveLayoutWithStatus(), 500);

function getNextPosition() {
  const cw = state.iconSize + 42, ch = state.iconSize + 62;   // grid step
  const w = state.iconSize + 36, h = state.iconSize + 36;    // approx icon box
  const placed = state.myLayout.filter(i => Number.isFinite(i.x) && Number.isFinite(i.y));
  const isFree = (x, y) => placed.every(i => Math.abs(i.x - x) >= w || Math.abs(i.y - y) >= h);

  for (let y = 24; y <= 1000; y += ch) {
    for (let x = 24; x <= 250 + state.iconSize; x += cw) {
      if (isFree(x, y)) return { x, y };
    }
  }
  return { x: 24, y: 24 };
}

async function syncGuestLayoutToServer() {
  if (!state.user) return;
  const localData = localStorage.getItem('desktop_layout');
  if (localData) {
    try {
      const parsed = JSON.parse(localData);
      if (parsed.links && parsed.links.length > 0) {
        const existingLayout = state.myLayout || [];
        const existingIds = new Set(existingLayout.map(i => i.linkId));
        parsed.links.forEach(item => {
          const linkId = Number(item.linkId);
          if (!existingIds.has(linkId)) existingLayout.push({ ...item, linkId });
        });
        state.myLayout = existingLayout;
        await saveLayoutWithStatus();
        localStorage.removeItem('desktop_layout');
      }
    } catch { /* ignore malformed data */ }
  }
}

async function saveLayoutWithStatus() {
  if (state.user) {
    if (!state.layoutLoaded) return null;
    const res = await api('/layout', { method: 'POST', body: { links: state.myLayout, hiddenLinks: state.hiddenLinks || [] } });
    if (!res) {
      notify('error', 'Layout save failed', 'Could not sync your layout to the server.');
    }
    return res;
  } else {
    localStorage.setItem('desktop_layout', JSON.stringify({
      links: state.myLayout,
      hiddenLinks: state.hiddenLinks || []
    }));
    return { ok: true };
  }
}

function applyIconSize(px) {
  px = Math.min(MAX_ICON, Math.max(MIN_ICON, Math.round(Number(px)) || DEFAULT_ICON));
  state.iconSize = px;
  document.documentElement.style.setProperty('--icon-size', px + 'px');
  localStorage.setItem('desktop_icon_size', String(px));

  // Looked up here (not cached in consts) so this can safely run before the DOM refs below exist
  const slider = document.getElementById('icon-size-slider');
  const label = document.getElementById('icon-size-value');
  if (slider && Number(slider.value) !== px) slider.value = px;
  if (label) label.textContent = px + 'px';
}
applyIconSize(localStorage.getItem('desktop_icon_size'));

// ================= Icon resolution =================
function getLayoutItem(linkId) {
  return state.myLayout.find(i => i.linkId === linkId);
}

// Local override wins over the shared definition
function resolveIcon(link) {
  const item = getLayoutItem(link.id);
  return item?.icon || link.icon || '';
}

async function setLocalIcon(link, iconUrl) {
  let item = getLayoutItem(link.id);
  if (!item) {
    if (!iconUrl) return;              // nothing to set or clear
    item = { linkId: link.id };        // no x/y, so it stays off the desktop
    state.myLayout.push(item);
  }
  if (iconUrl) item.icon = iconUrl;
  else delete item.icon;

  // Don't leave empty entries behind
  if (!item.icon && !isOnDesktop(link.id)) {
    state.myLayout = state.myLayout.filter(i => i !== item);
  }

  const res = await saveLayoutWithStatus();
  await renderIcons();
  if (!res && iconUrl) {
    notify('error', 'Icon save failed', api._lastError || 'Unknown error');
  }
}

// ================= CSRF Token Management =================   [CHANGED]
let writeQueue = Promise.resolve();   // kept: serialises writes in case tokens are single-use

async function fetchCsrfToken() {
  const res = await fetch('/api/csrf-token');
  if (!res.ok) throw new Error(`CSRF token request failed (${res.status})`);
  const data = await res.json();
  if (!data?.token) throw new Error('CSRF response missing token');
  csrfToken = data.token;
  return csrfToken;
}

// Deduplicates concurrent requests; force=true discards a stale/consumed token.
function getCsrfToken(force = false) {
  if (force) csrfToken = null;
  if (csrfToken) return Promise.resolve(csrfToken);
  if (!csrfPending) {
    csrfPending = fetchCsrfToken().finally(() => { csrfPending = null; });
  }
  return csrfPending;
}

// Single low-level entry point for every /api call.
// Attaches a token on writes and replays once if the server answers 403.
// Returns a raw Response — callers decide how to parse it.
async function withCsrf(path, options = {}) {
  const isWrite = ['POST', 'PUT', 'DELETE', 'PATCH']
    .includes((options.method || 'GET').toUpperCase());

  const send = async (token) => {
    const headers = { ...(options.headers || {}) };
    if (token) headers['X-CSRF-Token'] = token;
    return fetch(`/api${path}`, { ...options, headers });
  };

  if (!isWrite) return send(null);

  // Serialise writes so two POSTs never race for the same token.
  let res;
  await (writeQueue = writeQueue.then(async () => {
    res = await send(await getCsrfToken());
    if (res.status === 403) {
      res = await send(await getCsrfToken(true));
    }
  }));
  return res;
}

// ================= API Calls =================   [CHANGED]
async function api(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };

  try {
    const res = await withCsrf(endpoint, {
      ...options,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });

    if (!res.ok) {
      let detail = res.statusText || `HTTP ${res.status}`;
      try {
        const b = await res.json();
        detail = b.error || b.message || detail;
      } catch { /* non-JSON error body */ }
      setStatus(`Error: ${detail}`, true);
      throw new Error(detail);
    }

    return await res.json();
  } catch (e) {
    setStatus(`API Error: ${e.message}`, true);
    console.error('API call failed:', endpoint, e);
    api._lastError = e.message;
    return null;
  }
}

async function login() {
  window.location.href = 'https://auth.mortis.org.uk/?rd=' + encodeURIComponent(window.location.href);
}
async function logout() {
  window.location.href = 'https://auth.mortis.org.uk/logout?rd=' + encodeURIComponent(window.location.href);
}

async function loadLayoutForGuest() {
  const data = localStorage.getItem('desktop_layout');
  if (data) {
    try {
      const parsed = JSON.parse(data);
      applyLayoutData(parsed);
    } catch {
      state.myLayout = [];
      state.hiddenLinks = [];
    }
  } else {
    state.myLayout = [];
    state.hiddenLinks = [];
  }
}

async function loadUser() {
  try {
    const user = await api('/me');
    if (user) {
      state.user = user;
      updateWelcomeText();
      addFileManagerIcon();
      document.getElementById('user-name').textContent = user.name || user.email;
      document.getElementById('btn-login').style.display = 'none';
      document.getElementById('btn-logout').style.display = '';
    } else {
      state.user = null;
      document.getElementById('user-name').textContent = 'Guest';
      document.getElementById('btn-login').style.display = '';
      document.getElementById('btn-logout').style.display = '';
      await loadLayoutForGuest();
    }
  } catch (e) {
    console.error('loadUser failed:', e);
    setStatus('Load error', true);
  }
}

async function loadSharedLinks() {
  const links = await api('/links');
  if (links) state.sharedLinks = links;
}

function applyLayoutData(data) {
  const byId = new Map();
  for (const raw of data.links || []) {
    const linkId = Number(raw.linkId);
    if (!Number.isFinite(linkId)) continue;
    const prev = byId.get(linkId);
    if (!prev) byId.set(linkId, { ...raw, linkId });
    else if (raw.icon && !prev.icon) prev.icon = raw.icon;  // keep first position, salvage icon
  }
  state.myLayout = [...byId.values()];
  state.hiddenLinks = [...new Set((data.hiddenLinks || []).map(Number))];
}

async function loadLayout() {
  const data = await api('/layout');
  if (data) {
    applyLayoutData(data);
    state.layoutLoaded = true;
    if (state.myLayout.length !== (data.links || []).length) {
      debouncedSaveLayout();   // persist the cleaned-up layout
    }
    await renderIcons();
  }
}

async function saveWallpaper(wallpaper) {
  if (!state.user) return;
  const res = await api('/wallpapers', { method: 'POST', body: wallpaper });
  if (res && res.ok) {
    applyWallpaper(wallpaper);
    notify('success', 'Wallpaper saved successfully');
  } else {
    notify('error', 'Wallpaper save failed', api._lastError || 'Could not save wallpaper.');
  }
}

const GUEST_WP_KEY = 'desktop_wallpaper';
const DEFAULT_WALLPAPER = { kind: 'gradient', ref: 'classic' };

function readGuestWallpaper() {
  try {
    const wp = JSON.parse(localStorage.getItem(GUEST_WP_KEY));
    if (wp && Object.hasOwn(THEMES, wp.kind) && Object.hasOwn(THEMES[wp.kind], wp.ref)) {
      return { kind: wp.kind, ref: wp.ref };
    }
  } catch { /* ignore malformed data */ }
  return null;
}

// ================= Theme =================
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('desktop_theme', theme);
  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.querySelector('use').setAttribute('href', `/icons/ui.svg#${theme === 'dark' ? 'sun' : 'moon'}`);
    btn.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    btn.title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;
  }
}

document.getElementById('btn-theme').addEventListener('click', () => {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
});

applyTheme(state.theme);

// ================= Wallpaper =================
let currentWallpaper = { kind: 'gradient', ref: 'classic' };

// The one function that renders — NEVER sends CSS to the server
function applyWallpaper(wp) {
  const el = document.getElementById('wallpaper');
  if (!el) return;

  // Always tear down aurora's injected DOM, whatever we're switching to
  el.querySelectorAll('.aur-bands, .aur-horizon, .aur-mountains').forEach(n => n.remove());

  el.dataset.kind = wp.kind;
  el.dataset.ambId = wp.kind === 'ambient' ? wp.ref : '';
  el.style.cssText = '';  // hard reset

  switch (wp.kind) {
    case 'none':
      break;

    case 'color':
      el.style.background = THEMES.color[wp.ref]?.color || THEMES.color.midnight.color;
      break;

    case 'gradient':
      el.style.background = THEMES.gradient[wp.ref]?.css || THEMES.gradient.classic.css;
      break;

    case 'ambient': {
      const t = THEMES.ambient[wp.ref] || THEMES.ambient['mesh-drift'];
      el.style.setProperty('--amb-base', t.base);
      (t.nodes || []).forEach((n, i) => el.style.setProperty(`--amb-c${i + 1}`, n.c));

      if (wp.ref === 'aurora') {
        el.insertAdjacentHTML('afterbegin', `
        <div class="aur-bands">
          <div class="aur-band aur-band-1"></div>
          <div class="aur-band aur-band-2"></div>
          <div class="aur-band aur-band-3"></div>
        </div>
        <div class="aur-horizon"></div>
        <div class="aur-mountains">
          <svg viewBox="0 0 1440 200" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
            <!-- far ridge -->
            <path d="M0,200 L0,120
                     C110,120 110,70 220,80
                     C350,70 350,100 480,90
                     C590,100 590,40 800,80
                     C820,80 820,95 940,95
                     C1010,75 980,55 1080,55
                     C1310,55 1310,90 1440,90
                     L1440,200 Z" fill="#0d0d0d"/>
            <!-- near hills -->
            <path d="M0,200 L0,150
                     C80,150 80,175 180,155
                     C280,125 230,165 400,145
                     C510,145 410,130 660,140
                     C740,120 740,150 860,140
                     C980,150 980,138 1100,158
                     C1100,148 1100,175 1270,165
                     C1370,145 1370,180 1440,160
                     L1440,200 Z" fill="rgba(0,10,8,.95)"/>
          </svg>
        </div>
        `);
      }
      break;
    }

    case 'image':
      el.style.backgroundImage = `url("/api/wallpapers/${wp.ref}")`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      break;
  }
}


async function loadWallpaper() {
  if (!state.user) {
    applyWallpaper(readGuestWallpaper() || DEFAULT_WALLPAPER);
    return;
  }
  try {
    const wp = await api('/wallpapers');
    if (wp) {
      applyWallpaper({ kind: wp.kind || 'gradient', ref: wp.ref || 'classic' });
    }
  } catch (e) {
    console.error('Failed to load wallpaper:', e);
    applyWallpaper({ kind: 'gradient', ref: 'classic' });
  }
}

// --- Wallpaper picker modal ---
document.getElementById('btn-wallpaper').addEventListener('click', () => {
  wallpaperModal.style.display = 'flex';
  renderWallpaperPicker();
});

document.getElementById('wp-cancel').addEventListener('click', () => {
  wallpaperModal.style.display = 'none';
});

wallpaperModal.addEventListener('pointerdown', e => {
  if (e.target === wallpaperModal) wallpaperModal.style.display = 'none';
});

document.getElementById('icon-size-slider').addEventListener('input', e => {
  applyIconSize(e.target.value);
});

// ToDo: Preview
function renderWallpaperPicker(activeTab = 0) {
  const grid = document.getElementById('wp-grid');
  grid.innerHTML = '';

  // Rebuild tab bar
  const tabBar = document.createElement('div');
  tabBar.className = 'wallpaper-picker-tabs';
  const tabs = [
    { key: 'color', label: 'Colors' },      // shorter so 4 tabs fit in 360px
    { key: 'gradient', label: 'Gradients' },
    { key: 'ambient', label: 'Ambient' },
    { key: 'image', label: 'Image' },
  ];
  const flexTab = document.createElement('div');
  flexTab.id = "wp-tab";
  tabs.forEach((tab, index) => {
    const btn = document.createElement('button');
    btn.textContent = tab.label;
    btn.addEventListener('click', () => renderWallpaperPicker(index));
    if (index === activeTab) btn.classList.add('active');
    flexTab.appendChild(btn);
  });
  tabBar.appendChild(flexTab);
  grid.appendChild(tabBar);

  const cat = tabs[activeTab];
  if (cat.key === 'image') {
    renderUploadPanel(grid);
    return;
  }
  const themes = THEMES[cat.key];

  Object.entries(themes).forEach(([id, t]) => {
    const div = document.createElement('div');
    div.className = 'wallpaper-option' + (currentWallpaper.kind === cat.key && currentWallpaper.ref === id ? ' selected' : '');

    if (cat.key === 'color') {
      div.style.background = t.color;
    } else if (cat.key === 'gradient') {
      div.style.background = t.css;
    } else if (cat.key === 'ambient') {
      if (id === 'aurora') {
        div.style.background = `
      linear-gradient(180deg,
        #020510 0%,
        rgba(0,80,50,.8) 30%,
        rgba(0,170,255,.4) 55%,
        rgba(170,68,255,.3) 75%,
        #020510 100%
      )
    `;
        // Faint star dots
        div.style.backgroundImage = `
      radial-gradient(1px 1px at 20% 20%, rgba(255,255,255,.8) 0%, transparent 100%),
      radial-gradient(1px 1px at 60% 15%, rgba(255,255,255,.6) 0%, transparent 100%),
      radial-gradient(1px 1px at 80% 30%, rgba(255,255,255,.7) 0%, transparent 100%),
      radial-gradient(1px 1px at 40% 10%, rgba(255,255,255,.5) 0%, transparent 100%),
      linear-gradient(180deg,
        #020510 0%,
        rgba(0,80,50,.8) 30%,
        rgba(0,170,255,.4) 55%,
        rgba(170,68,255,.3) 75%,
        #020510 100%
      )
    `;
      } else {
        div.style.background = t.base;
      }
    }

    div.dataset.wp = JSON.stringify({ kind: cat.key, ref: id });
    div.title = t.label;

    div.onclick = () => {
      if (!state.user) {
        applyWallpaper({ kind: cat.key, ref: id });
        localStorage.setItem(GUEST_WP_KEY, JSON.stringify({ kind: cat.key, ref: id }));
        grid.querySelectorAll('.wallpaper-option').forEach(el => el.classList.remove('selected'));
        div.classList.add('selected');
        return;
      }

      api('/wallpapers', { method: 'POST', body: { kind: cat.key, ref: id } })
        .then(res => {
          if (res && res.ok) {
            applyWallpaper({ kind: cat.key, ref: id });
            grid.querySelectorAll('.wallpaper-option').forEach(el => el.classList.remove('selected'));
            div.classList.add('selected');
            document.getElementById('wp-cancel').click();
            notify('success', 'Wallpaper updated', t.label);
          } else {
            notify('error', 'Save failed', api._lastError || 'Could not save wallpaper.');
          }
        });
    };

    grid.appendChild(div);
  });
}

// Client-side image compression
function canvasToFile(canvas, type, quality, name) {
  return new Promise(resolve => {
    canvas.toBlob(blob => {
      resolve(blob && blob.type === type ? new File([blob], name, { type }) : null);
    }, type, quality);
  });
}

async function compressImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Cap at 2560px
    const MAX = 2560;
    let w = bitmap.width;
    let h = bitmap.height;
    if (w > MAX || h > MAX) {
      if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
      else { w = Math.round(w * MAX / h); h = MAX; }
    }

    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    return (await canvasToFile(canvas, 'image/webp', 0.82, 'wallpaper.webp')) || (await canvasToFile(canvas, 'image/jpeg', 0.85, 'wallpaper.jpg'));
  } catch (e) {
    console.error('Compression failed:', e);
    return null;
  }
}

const WP_UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

function renderUploadPanel(grid) {
  const panel = document.createElement('div');
  panel.className = 'wpu-panel';
  grid.appendChild(panel);

  if (!state.user) {
    panel.innerHTML = '<p class="hint">Log in to upload your own wallpaper.</p>';
    return;
  }

  panel.innerHTML = `
    <div class="wpu-drop">
      <input type="file" class="wpu-input" accept="image/jpeg,image/png,image/webp,image/avif">
      <svg class="wpu-cloud" viewBox="0 0 24 24" width="30" height="30" fill="none"
           stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <polyline points="16 16 12 12 8 16"/>
        <line x1="12" y1="12" x2="12" y2="21"/>
        <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
      </svg>
      <p class="wpu-title">Drag &amp; drop an image here or <span class="wpu-browse">browse</span></p>
      <span class="wpu-note">JPEG, PNG, WebP or AVIF</span>
    </div>
    <div class="wpu-list"></div>`;

  const drop = panel.querySelector('.wpu-drop');
  const input = panel.querySelector('.wpu-input');
  const list = panel.querySelector('.wpu-list');
  let busy = false;

  function createItem(file) {
    const item = document.createElement('div');
    item.className = 'wpu-item';
    item.innerHTML = `
      <div class="wpu-item-info">
        <div class="wpu-name">
          <span class="wpu-name-text"></span>
          <span class="wpu-size"></span>
        </div>
        <div class="wpu-bar"><div class="wpu-fill"></div></div>
        <div class="wpu-status"></div>
      </div>
      <span class="wpu-done" hidden>✓</span>
      <button type="button" class="wpu-action" title="Try again" hidden>↻</button>`;

    // textContent, never innerHTML, for anything that came from the user's filesystem
    item.querySelector('.wpu-name-text').textContent = file.name;
    item.querySelector('.wpu-size').textContent = `${(file.size / 1048576).toFixed(2)} MB`;

    const fill = item.querySelector('.wpu-fill');
    const status = item.querySelector('.wpu-status');
    const doneEl = item.querySelector('.wpu-done');
    const retryBtn = item.querySelector('.wpu-action');
    let onRetry = null;
    retryBtn.addEventListener('click', () => onRetry?.());

    return {
      el: item,
      setProgress(pct, text) {
        item.classList.remove('has-error');
        retryBtn.hidden = true;
        doneEl.hidden = true;
        fill.style.width = pct + '%';
        status.textContent = text || `${pct}%`;
      },
      setDone() {
        retryBtn.hidden = true;
        doneEl.hidden = false;
        status.textContent = 'Done';
      },
      setError(msg, retry) {
        item.classList.add('has-error');
        fill.style.width = '100%';
        doneEl.hidden = true;
        status.textContent = msg;
        onRetry = retry || null;
        retryBtn.hidden = !retry;
      }
    };
  }

  function handleFiles(files) {
    const file = files && files[0];          // single file only; extras are ignored
    if (!file || busy) return;

    list.innerHTML = '';
    const ui = createItem(file);
    list.appendChild(ui.el);

    if (!WP_UPLOAD_TYPES.has(file.type)) {
      ui.setError('Only JPEG, PNG, WebP or AVIF images are allowed.');
      return;
    }
    busy = true;
    uploadWallpaperFile(file, ui).finally(() => { busy = false; });
  }

  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('drag');
    handleFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => {
    handleFiles(input.files);
    input.value = '';                        // lets you pick the same file again
  });
}

async function uploadWallpaperFile(file, ui) {
  try {
    ui.setProgress(10, 'Optimising image…');
    const compressed = await compressImage(file);
    if (!compressed) throw new Error("Couldn't process that image.");

    ui.setProgress(40, 'Uploading…');
    const formData = new FormData();
    formData.append('file', compressed, compressed.name);

    const res = await withCsrf('/wallpapers/upload', { method: 'POST', body: formData });
    if (!res.ok) {
      let msg = 'Upload failed';
      try { msg = (await res.json()).error || msg; } catch { /* non-JSON body */ }
      throw new Error(msg);
    }

    const data = await res.json();
    ui.setProgress(100, 'Finishing…');
    ui.setDone();
    applyWallpaper({ kind: 'image', ref: data.wallpaper.ref });
    notify('success', 'Wallpaper uploaded', file.name);
    setTimeout(() => { wallpaperModal.style.display = 'none'; }, 900);
  } catch (e) {
    ui.setError(e.message, () => uploadWallpaperFile(file, ui));
  }
}
// ================= Icons =================
function getLinkById(id) {
  return state.sharedLinks.find(l => l.id === id);
}

function isOnDesktop(linkId) {
  const it = getLayoutItem(linkId);
  return !!it && Number.isFinite(it.x) && Number.isFinite(it.y);
}

async function addToDesktop(link, at) {
  const pos = at || getNextPosition();
  let item = getLayoutItem(link.id);
  if (!item) { item = { linkId: link.id }; state.myLayout.push(item); }
  item.x = pos.x; item.y = pos.y;
  await saveLayoutWithStatus();
  await renderIcons();
}

async function removeFromDesktop(link) {
  const item = getLayoutItem(link.id);
  if (!item || !isOnDesktop(link.id)) return;
  if (item.icon) { delete item.x; delete item.y; }   // keep personal icon override
  else state.myLayout = state.myLayout.filter(i => i.linkId !== link.id);
  await saveLayoutWithStatus();
  await renderIcons();
  notify('info', 'Removed from desktop', `"${link.title}" is still in the Start menu.`);
}

async function renderIcons() {
  desktop.querySelectorAll('.icon:not(.fm-icon)').forEach(el => el.remove());
  state.sharedLinks.forEach(link => {
    if (link.hidden || !isOnDesktop(link.id)) return;
    const pos = getLayoutItem(link.id);
    desktop.appendChild(buildIcon(link, pos.x, pos.y));
  });
}

function buildIcon(link, x, y) {
  const el = document.createElement('div');
  el.className = 'icon';
  el.dataset.linkId = link.id;
  el.style.left = x + 'px';
  el.style.top = y + 'px';

  const icon = resolveIcon(link);
  const imgSrc = icon || FALLBACK_ICON;

  // Use img element with onerror handler to avoid quote issues in attributes
  const img = document.createElement('img');
  img.src = imgSrc;
  img.onerror = function () {
    this.onerror = null;
    this.src = FALLBACK_ICON;
  };
  img.style.cssText = 'pointer-events:none;transition:filter 0.15s,transform 0.15s;';

  const label = document.createElement('span');
  label.textContent = link.title;

  el.appendChild(img);
  el.appendChild(label);

  makeDraggable(el, () => {
    const pos = state.myLayout.find(i => i.linkId === link.id);
    if (pos) {
      pos.x = parseFloat(el.style.left);
      pos.y = parseFloat(el.style.top);
    } else {
      state.myLayout.push({ linkId: link.id, x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
    }
    debouncedSaveLayout();
  });

  el.addEventListener('pointerdown', e => { select(el, link); e.stopPropagation(); });
  el.addEventListener('dblclick', () => openWindow(link));
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    suppressDesktopCtx = true;
    setTimeout(() => suppressDesktopCtx = false, 0);
    select(el, link);
    ctxPos = { x: e.clientX, y: e.clientY };
    ctxTarget = link;
    showMenu(e.clientX, e.clientY, true);
  });
  return el;
}

function select(el, link) {
  deselect();
  selectedIcon = { el, link };
  el.classList.add('selected');
}
function deselect() {
  if (selectedIcon) selectedIcon.el.classList.remove('selected');
  selectedIcon = null;
}

document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;

  if (e.key === 'Escape') closeStartMenu();

  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIcon?.link) {
    const link = selectedIcon.link;
    deselect();
    removeFromDesktop(link);
  }
});

// ================= Icon collision =================
const INITIAL_FRICTION = 15;        // px of pointer overshoot before a new contact starts moving
const MAX_FORCE_MULTIPLIER = 6;     // max multiplier for push distance
const WALL_SNUG = 4;                // how close to a wall counts as "pinned"
const ICON_GAP = 5;                 // breathing room between icons
const ESCAPE_FORCE = 40;            // wall resistance, folded back in
const RELEASE_SLACK = 10;           // how far apart icons must get before resistance resets
const DESK_TOP = 28, DESK_BOTTOM = 28;

function pinned(r, axis) {
  return axis === 'x'
    ? r.x <= WALL_SNUG || r.x + r.w >= innerWidth - WALL_SNUG
    : r.y <= DESK_TOP + WALL_SNUG || r.y + r.h >= innerHeight - DESK_BOTTOM - WALL_SNUG;
}

function rectsOverlap(a, b, gap = 0) {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

function inBounds(r) {
  return r.x >= 0 && r.x + r.w <= innerWidth &&
    r.y >= DESK_TOP && r.y + r.h <= innerHeight - DESK_BOTTOM;
}

// Simulate the push on copies of the rects; nothing touches the DOM until it succeeds.
function settle(pusher, rects, depth, ctx) {
  if (depth > 6) return false;
  const p = rects.get(pusher);
  for (const [other, r] of rects) {
    if (other === pusher || !rectsOverlap(p, r, ICON_GAP)) continue;

    const dx = (r.x + r.w / 2) - (p.x + p.w / 2);
    const dy = (r.y + r.h / 2) - (p.y + p.h / 2);
    const overlapX = (p.w + r.w) / 2 + ICON_GAP - Math.abs(dx);
    const overlapY = (p.h + r.h) / 2 + ICON_GAP - Math.abs(dy);
    const horizontal = overlapX < overlapY;

    let pushDist = horizontal ? overlapX : overlapY;

    if (depth === 0) {
      // Overshoot measured only along the shove axis, and only toward the other icon
      const axis = horizontal ? 'x' : 'y';
      const dir = (horizontal ? dx : dy) < 0 ? -1 : 1;
      const along = (a, b) => Math.max(0, (a[axis] - b[axis]) * dir);
      const force = along(ctx.want, ctx.start);

      // Friction: only applies to icons we haven't started pushing yet
      if (!ctx.engaged.has(other)) {
        if (!ctx.contacts.has(other)) ctx.contacts.set(other, { ...ctx.want });
        if (along(ctx.want, ctx.contacts.get(other)) < INITIAL_FRICTION) return false;
      }

      // Wall resistance: also only once per contact (unchanged)
      const dragAxis = Math.abs(ctx.drag.x) >= Math.abs(ctx.drag.y) ? 'x' : 'y';
      if (axis !== dragAxis && pinned(r, dragAxis)) {
        if (!ctx.escaped.has(other) && ctx.force < ESCAPE_FORCE) return false;
        ctx.escHits.add(other);
      }
      ctx.hits.add(other);

      // Harder shove = further push (never less than the overlap)
      const mult = Math.min(MAX_FORCE_MULTIPLIER, Math.max(1, 1 + (force - INITIAL_FRICTION) / 100));
      pushDist *= mult;
    }

    if (horizontal) r.x += (dx < 0 ? -1 : 1) * pushDist;
    else r.y += (dy < 0 ? -1 : 1) * pushDist;

    if (!inBounds(r)) return false;
    if (!settle(other, rects, depth + 1, ctx)) return false;
  }
  return true;
}

function tryPlace(el, nx, ny, rects, force, engaged, escaped, contacts, want) {
  const prev = rects.get(el);
  const ctx = {
    drag: { x: nx - prev.x, y: ny - prev.y },
    start: { x: prev.x, y: prev.y },
    force, engaged, escaped, contacts, want,
    hits: new Set(), escHits: new Set()
  };
  const next = new Map([...rects].map(([k, r]) => [k, { ...r }]));
  next.get(el).x = nx;
  next.get(el).y = ny;
  return settle(el, next, 0, ctx) ? { rects: next, ctx } : null;
}

// Saves one icon's position into the right place (layout vs. the Files icon)
function persistIconPos(el) {
  const x = parseFloat(el.style.left), y = parseFloat(el.style.top);
  if (el.dataset.app === 'filemanager') {
    state.fmIconPos = { x, y };
    localStorage.setItem('fm_icon_pos', JSON.stringify(state.fmIconPos));
    return;
  }
  const id = Number(el.dataset.linkId);
  const item = getLayoutItem(id);
  if (item) { item.x = x; item.y = y; }
  else state.myLayout.push({ linkId: id, x, y });
}

function makeDraggable(el, onEnd) {
  const TOP_BAR_HEIGHT = 28;
  const BOTTOM_BAR_HEIGHT = 28;

  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const ICON_W = el.offsetWidth, ICON_H = el.offsetHeight;
    const sx = e.clientX, sy = e.clientY;
    const ox = parseFloat(el.style.left), oy = parseFloat(el.style.top);
    let moved = false;
    el.setPointerCapture(e.pointerId);

    let rects = new Map();        // Snapshot every icon (including the Files icon) at drag start
    const engaged = new Set();    // icons whose friction we've already overcome
    const escaped = new Set();    // icons whose wall resistance we've already overcome
    const contacts = new Map();   // icon -> where the pointer was at first contact
    const touched = new Set();    // icons that got pushed and need saving

    desktop.querySelectorAll('.icon').forEach(i => rects.set(i, { x: i.offsetLeft, y: i.offsetTop, w: i.offsetWidth, h: i.offsetHeight }));

    function mv(ev) {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 3) { moved = true; el.classList.add('dragging'); }
      if (!moved) return;

      const maxX = Math.max(0, innerWidth - ICON_W);
      const maxY = Math.max(0, innerHeight - TOP_BAR_HEIGHT - BOTTOM_BAR_HEIGHT - ICON_H);
      const nx = Math.max(0, Math.min(maxX, ox + dx));
      const ny = Math.max(TOP_BAR_HEIGHT, Math.min(maxY, oy + dy));

      // Full move first, then slide along one axis if that's blocked
      const cur = rects.get(el);
      const force = Math.hypot(nx - cur.x, ny - cur.y);

      const want = { x: nx, y: ny };

      // Forget first-contact points for icons the pointer has moved clear of
      const wantRect = { ...rects.get(el), x: nx, y: ny };
      for (const o of [...contacts.keys()]) {
        if (!rectsOverlap(wantRect, rects.get(o), ICON_GAP + RELEASE_SLACK)) contacts.delete(o);
      }

      const res = tryPlace(el, nx, ny, rects, force, engaged, escaped, contacts, want)
        || tryPlace(el, nx, cur.y, rects, force, engaged, escaped, contacts, want)
        || tryPlace(el, cur.x, ny, rects, force, engaged, escaped, contacts, want);

      if (!res) return;
      rects = res.rects;

      // Remember what we're pushing; forget icons we've moved clear of
      res.ctx.hits.forEach(o => engaged.add(o));
      res.ctx.escHits.forEach(o => escaped.add(o));
      const me = rects.get(el);
      for (const o of [...engaged]) {
        if (!rectsOverlap(me, rects.get(o), ICON_GAP + RELEASE_SLACK)) {
          engaged.delete(o);
          escaped.delete(o);
        }
      }

      rects.forEach((r, i) => {
        if (parseFloat(i.style.left) === r.x && parseFloat(i.style.top) === r.y) return;
        i.style.left = r.x + 'px';
        i.style.top = r.y + 'px';
        if (i !== el) touched.add(i);
      });
    }

    function up() {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.classList.remove('dragging');
      el.releasePointerCapture(e.pointerId);
      if (!moved) return;
      touched.forEach(persistIconPos);
      if ([...touched].some(t => t.dataset.linkId)) debouncedSaveLayout();
      onEnd?.();
    }

    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
  });
}

// ================= Docker Monitor App =================

const DOCKER_APP = { id: 'docker', title: 'Docker', url: 'app://docker' };

function openDockerMonitor() {
  if (!userIsAdmin()) {
    notify('error', 'Admins only', 'Docker monitor requires admin permission.');
    return;
  }
  if (openWins.has(DOCKER_APP.url)) { restoreWin(DOCKER_APP.url); return; }

  const win = document.createElement('div');
  win.className = 'window';
  win.style.width = '820px';
  win.style.height = '480px';
  win.style.left = Math.max(0, innerWidth / 2 - 410) + 'px';
  win.style.top = Math.max(0, innerHeight / 2 - 240) + 'px';
  win.style.zIndex = ++zTop;

  win.innerHTML = `
    <div class="titlebar">
      <span class="title">${uiIcon('docker')} Docker</span>
      <button data-act="min" title="Minimize">–</button>
      <button data-act="close" title="Close">✕</button>
    </div>
    <div class="dkr-host"></div>
    <div class="resize-handle resize-n"></div>
    <div class="resize-handle resize-s"></div>
    <div class="resize-handle resize-e"></div>
    <div class="resize-handle resize-w"></div>
    <div class="resize-handle resize-ne"></div>
    <div class="resize-handle resize-nw"></div>
    <div class="resize-handle resize-se"></div>
    <div class="resize-handle resize-sw"></div>`;

  // Drag by titlebar (same behaviour as the other windows)
  const bar = win.querySelector('.titlebar');
  const TITLEBAR_H = 34;
  const BOTTOM_BAR_HEIGHT = 28;

  bar.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'BUTTON') return;
    const sx = e.clientX, sy = e.clientY;
    const ox = parseFloat(win.style.left), oy = parseFloat(win.style.top);
    const winH = win.offsetHeight;

    function mv(ev) {
      const maxY = Math.max(TITLEBAR_H, innerHeight - BOTTOM_BAR_HEIGHT - winH);
      win.style.left = Math.max(0, ox + ev.clientX - sx) + 'px';
      win.style.top = Math.max(0, Math.min(maxY, oy + ev.clientY - sy)) + 'px';
    }
    function up() {
      bar.removeEventListener('pointermove', mv);
      bar.removeEventListener('pointerup', up);
    }
    bar.setPointerCapture(e.pointerId);
    bar.addEventListener('pointermove', mv);
    bar.addEventListener('pointerup', up);
  });

  win.addEventListener('pointerdown', () => { win.style.zIndex = ++zTop; setActive(DOCKER_APP.url); });
  win.querySelector('[data-act="close"]').onclick = () => closeWindow(DOCKER_APP.url);
  win.querySelector('[data-act="min"]').onclick = () => minimizeWin(DOCKER_APP.url);
  makeResizable(win);

  // Mount the panel. Polling pauses while the window is minimised.
  const panel = createDockerPanel({
    api,
    intervalMs: 5000,
    isActive: () => !win.classList.contains('minimized'),
  });
  win.querySelector('.dkr-host').appendChild(panel.el);

  desktop.appendChild(win);
  addTaskButton(DOCKER_APP, win, DOCKER_APP.url);
  openWins.get(DOCKER_APP.url).onClose = panel.stop;   // so the timer dies with the window

  panel.start();
}

// ================= File Manager App =================
const FILE_MANAGER = { id: 'filemanager', title: 'File Manager', url: 'app://files' };

function openFileManager() {
  if (openWins.has(FILE_MANAGER.url)) { restoreWin(FILE_MANAGER.url); return; }
  const win = document.createElement('div');
  win.className = 'window';
  win.style.width = '560px';
  win.style.height = '420px';
  win.style.left = Math.max(0, innerWidth / 2 - 280) + 'px';
  win.style.top = Math.max(0, innerHeight / 2 - 210) + 'px';
  win.style.zIndex = ++zTop;
  win.innerHTML = `
    <div class="titlebar">
      <span class="title">${uiIcon('folder')} File Manager</span>
      <button data-act="min" title="Minimize">–</button>
      <button data-act="close" title="Close">✕</button>
    </div>
    <div class="file-manager">
      <div class="fm-toolbar">
        <button id="fm-refresh">${uiIcon('refresh')} Refresh</button>
        <button id="fm-newfile">${uiIcon('plus')} New text file</button>
        <input type="file" id="fm-upload-input" style="display:none">
        <button id="fm-upload">${uiIcon('upload')} Upload</button>
      </div>
      <div class="fm-upload-area" id="fm-dropzone">Drop files here to upload</div>
      <div class="fm-list" id="fm-list"></div>
    </div>`;

  const bar = win.querySelector('.titlebar');
  const TITLEBAR_H = 34;
  const BOTTOM_BAR_HEIGHT = 28;

  bar.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'BUTTON') return;
    const sx = e.clientX, sy = e.clientY, ox = win.offsetLeft, oy = win.offsetTop;
    const winW = win.offsetWidth;
    const winH = win.offsetHeight;
    function mv(ev) {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      const maxY = Math.max(TITLEBAR_H, innerHeight - BOTTOM_BAR_HEIGHT - winH);
      win.style.left = Math.max(0, ox + dx) + 'px';
      win.style.top = Math.max(0, Math.min(maxY, oy + dy)) + 'px';
    }
    function up() { bar.removeEventListener('pointermove', mv); bar.removeEventListener('pointerup', up); }
    bar.setPointerCapture(e.pointerId);
    bar.addEventListener('pointermove', mv);
    bar.addEventListener('pointerup', up);
  });

  const list = win.querySelector('#fm-list');

  async function loadFiles() {
    const files = await api('/files');
    if (!files) {
      list.innerHTML = '<div class="fm-empty">Failed to load files. Please refresh or check your connection.</div>';
      notify('error', 'File load failed', 'Could not retrieve your files from the server.');
      return;
    }
    list.innerHTML = '';
    if (!files.length) {
      list.innerHTML = '<div class="fm-empty">No files yet. Upload or create one.</div>';
      return;
    }
    files.forEach(f => {
      const row = document.createElement('div');
      row.className = 'fm-item';
      const kb = f.size > 1024 ? (f.size / 1024).toFixed(1) + ' KB' : f.size + ' B';
      row.innerHTML = `${uiIcon('file', 'fm-icon')}<span class="fm-name">${escapeHtml(f.name)}</span>
        <span class="fm-size">${kb}</span><span class="fm-date">${new Date(f.modified).toLocaleDateString()}</span>
        <span class="fm-actions"><button data-a="dl">Download</button><button data-a="del">Delete</button></span>`;
      row.querySelector('[data-a="dl"]').onclick = () => {
        const a = document.createElement('a');
        a.href = `${API}/files/download/${encodeURIComponent(f.name)}`;
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      };
      row.querySelector('[data-a="del"]').onclick = async () => {
        if (!confirm(`Delete ${f.name}? This action cannot be undone.`)) return;
        const res = await api(`/files/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
        if (res && res.ok) {
          notify('success', 'File deleted', f.name);
          loadFiles();
        } else {
          notify('error', 'Delete failed', `Could not delete ${f.name}. You may not have permission.`);
        }
      };
      list.appendChild(row);
    });
  }

  win.querySelector('#fm-refresh').onclick = loadFiles;
  win.querySelector('#fm-newfile').onclick = async () => {
    const name = prompt('File name:', 'notes.txt');
    if (!name) return;
    const content = prompt('Initial content:', '') || '';
    await api('/files/create', { method: 'POST', body: { name, content } });
    loadFiles();
  };

  const uploadInput = win.querySelector('#fm-upload-input');
  win.querySelector('#fm-upload').onclick = () => uploadInput.click();
  uploadInput.onchange = () => { if (uploadInput.files[0]) uploadFile(uploadInput.files[0]); };

  async function uploadFile(file) {
    const uploadNotif = notify('info', 'Uploading...', file.name + ' — please wait');

    const formData = new FormData();
    formData.append('file', file, file.name);

    // [CHANGED] was: await getCsrfToken(); fetch(`${API}/files/upload?...`, { headers: {'X-CSRF-Token': csrfToken}, ... })
    const res = await withCsrf(`/files/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: formData
    });

    if (res.ok) {
      dismissNotif(uploadNotif);
      notify('success', 'Uploaded', file.name);
      loadFiles();
    } else {
      let errorMsg = 'Upload failed';
      try {
        const errBody = await res.json();
        errorMsg = errBody.error || errorMsg;
      } catch (e) { }
      dismissNotif(uploadNotif);
      notify('error', 'Upload failed', errorMsg);
    }
  }

  const drop = win.querySelector('#fm-dropzone');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  });

  desktop.appendChild(win);
  addTaskButton(FILE_MANAGER, win, FILE_MANAGER.url);

  win.querySelector('[data-act="close"]').onclick = () => closeWindow(FILE_MANAGER.url);
  win.querySelector('[data-act="min"]').onclick = () => minimizeWin(FILE_MANAGER.url);

  loadFiles();
}

// ================= NOTIFICATIONS =================
let notifCount = 0;
const notifContainer = document.getElementById('notif-container');
const notifBadge = document.getElementById('notif-badge');

function notify(type, title, msg) {
  const n = document.createElement('div');
  n.className = 'notification ' + type;
  n.innerHTML = `
    <div class="notif-body">
      <div class="notif-title">${escapeHtml(title)}</div>
      <div class="notif-msg">${escapeHtml(msg || '')}</div>
    </div>
    <button class="notif-close">×</button>`;
  notifContainer.appendChild(n);
  updateNotifBadge();
  setTimeout(() => dismissNotif(n), 5000);
  n.querySelector('.notif-close').onclick = () => dismissNotif(n);
  return n;
}

function dismissNotif(el) {
  el.classList.add('hiding');
  setTimeout(() => { el.remove(); updateNotifBadge(); }, 300);
}

function updateNotifBadge() {
  const count = notifContainer.children.length;
  notifCount = count;
  if (count > 0) {
    notifBadge.textContent = count;
    notifBadge.style.display = 'flex';
  } else {
    notifBadge.style.display = 'none';
  }
}

document.getElementById('btn-notifications').addEventListener('click', () => {
  if (!notifCount) notify('info', 'No new notifications', 'You are all caught up.');
});

// ================= START MENU =================
const startMenu = document.getElementById('start-menu');
const startAppsList = document.getElementById('start-apps-list');
const startSearchInput = document.getElementById('start-search-input');

const BUILT_IN_APPS = [
  { id: 'filemanager', name: 'File Manager', cat: 'System', icon: 'folder' },
  { id: 'docker', name: 'Docker Monitor', cat: 'System', icon: 'docker' },
  { id: 'wallpaper', name: 'Change Wallpaper', cat: 'Settings', icon: 'image' },
];

function toggleStartMenu() {
  const isOpen = startMenu.classList.toggle('open');
  if (isOpen) renderStartApps();
}

function closeStartMenu() {
  startMenu.classList.remove('open');
  document.querySelectorAll('.flyout-open').forEach(f => f.classList.remove('flyout-open'));
}

function renderStartApps(filter = '') {
  document.querySelectorAll('.start-folder-body').forEach(el => el.remove());
  startAppsList.innerHTML = '';
  const lowerFilter = filter.toLowerCase();

  const groups = {};
  const addItem = (cat, item) => {
    (groups[cat] = groups[cat] || []).push(item);
  };

  BUILT_IN_APPS.forEach(app => {
    if (app.id === 'docker' && !userIsAdmin()) return;      // NEW
    if (lowerFilter && !app.name.toLowerCase().includes(lowerFilter)) return;
    addItem(app.cat, {
      type: 'app',
      name: app.name,
      icon: uiIcon(app.icon, 'app-icon'),
      onclick: () => {
        closeStartMenu();
        if (app.id === 'filemanager') openFileManager();
        if (app.id === 'wallpaper') document.getElementById('btn-wallpaper').click();
        if (app.id === 'docker') openDockerMonitor();        // NEW
      }
    });
  });

  state.sharedLinks.forEach(link => {
    if (lowerFilter && !link.title.toLowerCase().includes(lowerFilter)) return;
    const resolved = resolveIcon(link) || FALLBACK_ICON;
    addItem(link.category || 'Web', {
      type: 'link',
      linkId: link.id,
      name: link.title,
      sub: link.url,
      icon: `<img class="start-app-icon" data-src="${escapeHtml(resolved)}" alt="${escapeHtml(link.title)}">`,
    });
  });

  Object.keys(groups).sort().forEach(cat => {
    const items = groups[cat];
    const folder = document.createElement('div');
    folder.className = 'start-folder';

    const header = document.createElement('div');
    header.className = 'start-folder-header';
    header.innerHTML = `
    ${uiIcon('folder-open', 'folder-icon')}
    <span class="folder-name">${escapeHtml(cat)}</span>
    <span class="folder-count">${items.length}</span>
    <span class="folder-caret">▶</span>
  `;

    // Build the flyout panel and append to body so it escapes all overflow clipping
    const body = document.createElement('div');
    body.className = 'start-folder-body';
    document.body.appendChild(body);

    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'start-app-item';
      if (item.linkId != null) row.dataset.linkId = item.linkId;
      row.innerHTML = `${item.icon}<div class="app-info">
      <div class="app-name">${escapeHtml(item.name)}</div>
      ${item.sub ? `<div class="app-cat">${escapeHtml(item.sub)}</div>` : ''}
    </div>`;

      if (item.type === 'link') {
        const pin = document.createElement('button');
        const sync = () => {
          const on = isOnDesktop(item.linkId);
          pin.classList.toggle('on', on);
          pin.title = on ? 'Remove from desktop' : 'Show on desktop';
        };
        pin.className = 'start-pin';
        pin.innerHTML = uiIcon('pin', 'pin-icon');
        sync();
        pin.onclick = async e => {
          e.stopPropagation();
          const link = getLinkById(item.linkId);
          if (!link) return;
          if (isOnDesktop(link.id)) await removeFromDesktop(link);
          else await addToDesktop(link);
          sync();
        };
        row.appendChild(pin);
      }
      const img = row.querySelector('img.start-app-icon');
      if (img) {
        img.src = img.dataset.src;
        img.onerror = function () { this.onerror = null; this.src = FALLBACK_ICON; };
      }

      row.onclick = () => {
        closeStartMenu();
        if (item.type !== 'link') { item.onclick?.(); return; }
        const link = getLinkById(item.linkId);
        if (link) openWindow(link);
      };

      row.oncontextmenu = e => {
        e.preventDefault(); e.stopPropagation();
        if (item.type !== 'link') return;
        const link = getLinkById(item.linkId);
        if (!link) return;
        ctxTarget = link;
        ctxPos = { x: e.clientX, y: e.clientY };
        showMenu(e.clientX, e.clientY, true);
      };

      body.appendChild(row);
    });

    const setOpen = (on) => {
      folder.classList.toggle('flyout-open', on);
      body.classList.toggle('flyout-open', on);
    };

    header.addEventListener('mouseenter', () => {
      if (lowerFilter) return;               // search mode shows everything inline
      document.querySelectorAll('.start-folder.flyout-open, .start-folder-body.flyout-open')
        .forEach(el => { if (el !== folder && el !== body) el.classList.remove('flyout-open'); });

      const rect = header.getBoundingClientRect();
      const estH = items.length * 44 + 12;
      let top = rect.top;
      if (top + estH > window.innerHeight - 8) top = Math.max(8, window.innerHeight - estH - 8);
      body.style.top = top + 'px';
      body.style.left = (rect.right + 6) + 'px';
      setOpen(true);
    });

    body.addEventListener('mouseenter', () => { if (!lowerFilter) setOpen(true); });

    const closeFlyout = () => {
      if (lowerFilter) return;               // otherwise search results vanish on mouseleave
      setTimeout(() => {
        if (!body.matches(':hover') && !header.matches(':hover')) setOpen(false);
      }, 80);
    };
    header.addEventListener('mouseleave', closeFlyout);
    body.addEventListener('mouseleave', closeFlyout);

    if (lowerFilter) {
      body.style.cssText = `
      position: static; opacity: 1; transform: none;
      pointer-events: auto; width: auto; max-height: none;
      box-shadow: none; border: none; background: transparent;
      padding-left: 14px; border-left: 1px solid var(--aui-border);
      margin-left: 16px; backdrop-filter: none;
    `;
      // Re-append inline for search mode
      body.remove();
      folder.appendChild(header);
      folder.appendChild(body);
      folder.classList.add('flyout-open');
    }

    folder.appendChild(header);
    startAppsList.appendChild(folder);
  });
}

document.getElementById('btn-start').addEventListener('click', e => {
  e.stopPropagation();
  toggleStartMenu();
});

document.addEventListener('pointerdown', e => {
  if (startMenu.contains(e.target)) return;
  if (e.target.closest('#btn-start')) return;
  if (e.target.closest('.start-folder-body')) return;   // flyouts live on <body>
  closeStartMenu();
});

startSearchInput.addEventListener('input', e => renderStartApps(e.target.value));

document.getElementById('btn-start-logout').addEventListener('click', logout);
document.getElementById('btn-start-wallpaper').addEventListener('click', () => {
  closeStartMenu();
  document.getElementById('btn-wallpaper').click();
});

// ================= FILE MANAGER LAUNCHER =================
function addFileManagerIcon() {
  if (desktop.querySelector('[data-app="filemanager"]')) return;

  const el = document.createElement('div');
  el.className = 'icon fm-icon';
  el.dataset.app = 'filemanager';

  const saved = localStorage.getItem('fm_icon_pos');
  if (saved) {
    try { state.fmIconPos = JSON.parse(saved); } catch (e) { }
  }
  const fmPos = state.fmIconPos || { x: 24, y: 740 };
  el.style.left = fmPos.x + 'px';
  el.style.top = fmPos.y + 'px';
  el.innerHTML = `${uiIcon('folder')}<span>Files</span>`;

  makeDraggable(el, () => {
    state.fmIconPos = {
      x: parseFloat(el.style.left),
      y: parseFloat(el.style.top)
    };
    localStorage.setItem('fm_icon_pos', JSON.stringify(state.fmIconPos));
  });

  el.addEventListener('dblclick', openFileManager);
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    suppressDesktopCtx = true;
    setTimeout(() => suppressDesktopCtx = false, 0);
    select(el, null);
    ctxTarget = null;
    showMenu(e.clientX, e.clientY, false);
  });

  desktop.appendChild(el);
}

window.addEventListener('load', addFileManagerIcon);

// ================= UPDATE WELCOME TEXT =================
function updateWelcomeText() {
  const h = document.getElementById('start-welcome');
  const p = document.getElementById('start-subtitle');
  if (state.user) {
    h.textContent = `Hello, ${state.user.name || state.user.email}`;
    p.textContent = 'Ready when you are';
  } else {
    h.textContent = 'Guest Mode';
    p.textContent = 'Login to sync your layout';
  }
}

// ================= Windows =================
function safeHttpUrl(raw) {
  try {
    const u = new URL(raw, location.origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch { return null; }
}
function openWindow(link) {
  const url = safeHttpUrl(link.url);
  if (!url) { notify('error', 'Blocked link', 'Only http(s) links can be opened.'); return; }

  if (link.mode === 'tab') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  const winKey = link.url + '__' + link.id;  // unique per link
  if (openWins.has(winKey)) { restoreWin(winKey); return; }

  const n = openWins.size;
  const win = document.createElement('div');
  win.className = 'window';
  win.style.width = '640px';
  win.style.height = '440px';
  win.style.left = Math.max(0, innerWidth / 2 - 320 + n * 28) + 'px';
  win.style.top = Math.max(0, innerHeight / 2 - 240 + n * 28) + 'px';
  win.style.zIndex = ++zTop;

  win.innerHTML = `
    <div class="titlebar">
      <span class="title">${escapeHtml(link.title)} — ${escapeHtml(link.url)}</span>
      <button data-act="min" title="Minimize">–</button>
      <button data-act="close" title="Close">✕</button>
    </div>
    <div style="position:relative; flex:1; overflow:hidden;">
      <iframe src="${escapeHtml(link.url)}" sandbox="allow-scripts allow-forms" style="position:absolute; inset:0; width:100%; height:100%; border:0;"></iframe>
    </div>
    <div class="resize-handle resize-n"></div>
    <div class="resize-handle resize-s"></div>
    <div class="resize-handle resize-e"></div>
    <div class="resize-handle resize-w"></div>
    <div class="resize-handle resize-ne"></div>
    <div class="resize-handle resize-nw"></div>
    <div class="resize-handle resize-se"></div>
    <div class="resize-handle resize-sw"></div>
  `;

  const bar = win.querySelector('.titlebar');
  const TITLEBAR_H = 34;
  const BOTTOM_BAR_HEIGHT = 28;

  bar.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'BUTTON') return;
    const sx = e.clientX, sy = e.clientY;
    const ox = parseFloat(win.style.left), oy = parseFloat(win.style.top);
    const winW = win.offsetWidth;
    const winH = win.offsetHeight;

    function mv(ev) {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      const maxY = Math.max(TITLEBAR_H, innerHeight - BOTTOM_BAR_HEIGHT - winH);
      win.style.left = Math.max(0, ox + dx) + 'px';
      win.style.top = Math.max(0, Math.min(maxY, oy + dy)) + 'px';
    }
    function up() {
      bar.removeEventListener('pointermove', mv);
      bar.removeEventListener('pointerup', up);
    }

    bar.setPointerCapture(e.pointerId);
    bar.addEventListener('pointermove', mv);
    bar.addEventListener('pointerup', up);
  });

  win.addEventListener('pointerdown', () => { win.style.zIndex = ++zTop; setActive(winKey); });
  win.querySelector('[data-act="close"]').onclick = () => closeWindow(winKey);
  win.querySelector('[data-act="min"]').onclick = () => minimizeWin(winKey);

  makeResizable(win);

  desktop.appendChild(win);
  addTaskButton(link, win, winKey);
}

// ================= Resize Logic =================
function makeResizable(win) {
  const BOTTOM_BAR_HEIGHT = 28;
  const TITLEBAR_H = 34;
  const handles = win.querySelectorAll('.resize-handle');

  handles.forEach(handle => {
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();

      const sx = e.clientX, sy = e.clientY;
      const ow = win.offsetWidth, oh = win.offsetHeight;
      const ox = win.offsetLeft, oy = win.offsetTop;

      const dir = handle.className.split(' ')[1];
      const isNorth = dir.includes('n');
      const isSouth = dir.includes('s');
      const isEast = dir.includes('e');
      const isWest = dir.includes('w');

      handle.setPointerCapture(e.pointerId);

      function mv(ev) {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;

        let newW = ow, newH = oh, newLeft = ox, newTop = oy;

        if (isEast) newW = Math.max(320, ow + dx);
        if (isWest) { newW = Math.max(320, ow - dx); newLeft = ox + dx; }
        if (isSouth) newH = Math.max(200, oh + dy);
        if (isNorth) { newH = Math.max(200, oh - dy); newTop = oy + dy; }

        const maxY = Math.max(TITLEBAR_H, innerHeight - BOTTOM_BAR_HEIGHT - newH);
        newLeft = Math.max(0, newLeft);
        newTop = Math.max(0, Math.min(maxY, newTop));

        win.style.width = newW + 'px';
        win.style.height = newH + 'px';
        win.style.left = newLeft + 'px';
        win.style.top = newTop + 'px';
      }

      function up() {
        handle.removeEventListener('pointermove', mv);
        handle.removeEventListener('pointerup', up);
        handle.releasePointerCapture(e.pointerId);
      }

      handle.addEventListener('pointermove', mv);
      handle.addEventListener('pointerup', up);
    });
  });
}

function addTaskButton(link, win, winKey) {
  const btn = document.createElement('button');
  btn.className = 'taskbtn active';
  btn.textContent = link.title;
  btn.onclick = () => {
    if (win.classList.contains('minimized')) restoreWin(winKey);
    else if (parseInt(win.style.zIndex) === zTop) minimizeWin(winKey);
    else { win.style.zIndex = ++zTop; setActive(winKey); }
  };
  openWins.set(winKey, { win, btn });
  const items = document.getElementById('taskbar-items');
  items.appendChild(btn);
}

function minimizeWin(winKey) {
  const w = openWins.get(winKey);
  if (!w) return;
  w.win.classList.add('minimized');
  w.btn.classList.remove('active');
}

function restoreWin(winKey) {
  const w = openWins.get(winKey);
  if (!w) return;
  w.win.classList.remove('minimized');
  w.win.style.zIndex = ++zTop;
  setActive(winKey);
}

function closeWindow(winKey) {
  const w = openWins.get(winKey);
  if (!w) return;
  w.onClose?.();
  w.win.remove();
  w.btn.remove();
  openWins.delete(winKey);
}

function setActive(winKey) {
  openWins.forEach((v, k) => v.btn.classList.toggle('active', k === winKey));
}

// ================= Context Menu =================
desktop.addEventListener('contextmenu', e => {
  if (suppressDesktopCtx) return;
  e.preventDefault();
  ctxTarget = null;
  ctxPos = { x: e.clientX, y: e.clientY };
  showMenu(e.clientX, e.clientY, false);
});

function showMenu(x, y, onIcon) {
  const admin = userIsAdmin();
  const hasOverride = ctxTarget ? !!getLayoutItem(ctxTarget.id)?.icon : false;
  const onDesk = ctxTarget ? isOnDesktop(ctxTarget.id) : false;

  if (onIcon) {
    ctxmenu.innerHTML = `
      <div data-act="open">${uiIcon('folder-open', 'ctx-icon')}<span class="ctx-label">Open</span></div>
      ${admin ? `<div data-act="edit">${uiIcon('edit', 'ctx-icon')}<span class="ctx-label">Edit…</span></div>` : ''}
      ${hasOverride ? `<div data-act="reset-icon">${uiIcon('image', 'ctx-icon')}<span class="ctx-label">Reset my icon</span></div>` : ''}
      <div class="sep"></div>
      <div data-act="open-newtab">${uiIcon('link', 'ctx-icon')}<span class="ctx-label">Open in new tab</span></div>
      <div data-act="open-newwindow">${uiIcon('window', 'ctx-icon')}<span class="ctx-label">Open in new window</span></div>
      <div class="sep"></div>
      ${onDesk ? `<div data-act="remove">${uiIcon('trash', 'ctx-icon')}<span class="ctx-label">Remove from desktop</span></div>` : `<div data-act="add-desktop">${uiIcon('pin', 'ctx-icon')}<span class="ctx-label">Add to desktop</span></div>`}
      <div class="sep"></div>
      ${state.user ? `<div data-act="add">${uiIcon('plus', 'ctx-icon')}<span class="ctx-label">Add link…</span></div><div class="sep"></div>` : ''}
      <div data-act="reset">${uiIcon('reset', 'ctx-icon')}<span class="ctx-label">Reset icon positions</span></div>
      ${admin ? `<div data-act="reset-links" style="color:#ef4444">${uiIcon('refresh', 'ctx-icon')}<span class="ctx-label">Reset links to defaults</span></div>` : ''}
    `;
  } else {
    ctxmenu.innerHTML = `
      ${state.user ? `<div data-act="add">${uiIcon('plus', 'ctx-icon')}<span class="ctx-label">Add link…</span></div><div class="sep"></div>` : ''}
      <div data-act="reset">${uiIcon('reset', 'ctx-icon')}<span class="ctx-label">Reset layout</span></div>
      ${admin ? `<div data-act="reset-links" style="color:#ef4444">${uiIcon('refresh', 'ctx-icon')}<span class="ctx-label">Reset links to defaults</span></div>` : ''}
    `;
  }

  // Position near cursor FIRST, then measure — avoids rendering at (0,0)
  ctxmenu.style.left = x + 'px';
  ctxmenu.style.top = y + 'px';
  ctxmenu.style.visibility = 'hidden';
  ctxmenu.style.display = 'block';

  const rect = ctxmenu.getBoundingClientRect();
  const MARGIN = 8;
  const TOP_BAR = 28, BOTTOM_BAR = 28;

  let left = x + 4;
  let top = y + 4;

  if (left + rect.width > innerWidth - MARGIN) left = x - rect.width - 4;
  if (top + rect.height > innerHeight - MARGIN) top = y - rect.height - 4;

  left = Math.max(MARGIN, Math.min(left, innerWidth - rect.width - MARGIN));
  top = Math.max(TOP_BAR + MARGIN, Math.min(top, innerHeight - BOTTOM_BAR - rect.height - MARGIN));

  ctxmenu.style.left = left + 'px';
  ctxmenu.style.top = top + 'px';
  ctxmenu.style.visibility = '';
}

function hideMenu() { ctxmenu.style.display = 'none'; }

ctxmenu.addEventListener('click', async e => {
  const act = e.target.dataset.act;
  if (!act) return;

  if (act === 'open' && ctxTarget) openWindow(ctxTarget);
  if (act === 'edit' && ctxTarget) openEditModal(ctxTarget);
  if (act === 'remove' && ctxTarget) await removeFromDesktop(ctxTarget);
  if (act === 'add-desktop' && ctxTarget) await addToDesktop(ctxTarget);
  if (act === 'add') openModal();

  if (act === 'open-newtab' && ctxTarget) {
    const url = safeHttpUrl(ctxTarget.url);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  if (act === 'open-newwindow' && ctxTarget) {
    const url = safeHttpUrl(ctxTarget.url);
    if (url) window.open(url, '_blank', 'width=1280,height=800,noopener,noreferrer');
  }


  if (act === 'reset-icon' && ctxTarget) {
    await setLocalIcon(ctxTarget, '');
    notify('info', 'Icon reset', `"${ctxTarget.title}" uses the shared icon again.`);
  }

  if (act === 'reset') {
    if (!confirm('Re-arrange desktop icons?')) { hideMenu(); return; }
    const ids = state.myLayout.filter(i => Number.isFinite(i.x)).map(i => i.linkId);
    ids.forEach(id => { const it = getLayoutItem(id); delete it.x; delete it.y; });
    ids.forEach(id => { const p = getNextPosition(); const it = getLayoutItem(id); it.x = p.x; it.y = p.y; });
    debouncedSaveLayout();
    await renderIcons();
  }

  if (act === 'reset-links') {
    if (!confirm('Restore original shared links and reset all icons?')) { hideMenu(); return; }
    const res = await api('/links/reset', { method: 'POST' });
    if (res && res.links) {
      state.sharedLinks = res.links;
    } else {
      await loadSharedLinks();
    }
    state.myLayout = [];
    state.hiddenLinks = [];
    state.sharedLinks.forEach(l => { const p = getNextPosition(); state.myLayout.push({ linkId: l.id, x: p.x, y: p.y }); });
    debouncedSaveLayout();
    await renderIcons();
    hideMenu();
  }

  hideMenu();
});

document.addEventListener('pointerdown', e => {
  if (!ctxmenu.contains(e.target)) hideMenu();
}, true);

// ================= Add Link Modal =================
function openModal() {
  modalBg.style.display = 'flex';
  document.getElementById('in-title').focus();
}

function closeModal() {
  modalBg.style.display = 'none';
  ['in-title', 'in-url', 'in-icon', 'in-category'].forEach(id => document.getElementById(id).value = '');
  const sel = document.getElementById('in-mode');
  if (sel) sel.value = 'window';
}

document.getElementById('m-cancel').addEventListener('click', closeModal);
modalBg.addEventListener('pointerdown', e => { if (e.target === modalBg) closeModal(); });

document.getElementById('m-add').addEventListener('click', async () => {
  const title = document.getElementById('in-title').value.trim();
  let url = document.getElementById('in-url').value.trim();
  const icon = document.getElementById('in-icon').value.trim();
  const category = document.getElementById('in-category').value.trim() || 'General';
  const mode = document.getElementById('in-mode').value;

  if (!title || !url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const newLink = await api('/links', { method: 'POST', body: { title, url, icon, category, mode } });
  if (newLink && newLink.ok) {
    await loadSharedLinks();
    const link = state.sharedLinks.find(l => l.id === newLink.id);
    if (link) {
      const ICON_W = state.iconSize + 36;
      const ICON_H = state.iconSize + 12;
      const TOP_BAR = 28;
      const BOTTOM_BAR = 28;

      let posX, posY;
      if (ctxPos.x && ctxPos.y) {
        posX = Math.max(0, Math.min(ctxPos.x, innerWidth - ICON_W));
        posY = Math.max(TOP_BAR, Math.min(ctxPos.y, innerHeight - TOP_BAR - BOTTOM_BAR - ICON_H));
      } else {
        const free = getNextPosition();
        posX = free.x;
        posY = free.y;
      }

      await addToDesktop(link, { x: posX, y: posY });
    }
    closeModal();
  }
});

['in-title', 'in-url', 'in-icon', 'in-category'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('m-add').click();
    if (e.key === 'Escape') closeModal();
  });
});

// ================= Edit Link Modal =================
const editModalBg = document.getElementById('edit-modal-bg');
let editingLink = null;

function openEditModal(link) {
  editingLink = link;
  const admin = userIsAdmin();
  const editEl = document.getElementById('edit-modal');

  editModalBg.style.display = 'flex';

  // --- Populate form ---
  document.getElementById('ed-title').value = link.title;
  document.getElementById('ed-url').value = link.url;
  document.getElementById('ed-icon').value = link.icon || '';
  document.getElementById('ed-category').value = link.category || 'General';
  document.getElementById('ed-mode').value = link.mode === 'tab' ? 'tab' : 'window';
  document.getElementById('ed-local-icon').value = getLayoutItem(link.id)?.icon || '';

  ['ed-title', 'ed-url', 'ed-icon', 'ed-category', 'ed-mode'].forEach(id => {
    document.getElementById(id).disabled = !admin;
  });
  document.getElementById('ed-delete').style.display = admin ? '' : 'none';
  document.querySelector('#edit-modal-bg .hint').textContent = admin
    ? 'Editing the shared fields changes this link for every user.'
    : 'You can only change your personal icon.';

  document.getElementById(admin ? 'ed-title' : 'ed-local-icon').focus();
}

function closeEditModal() {
  editModalBg.style.display = 'none';
  editingLink = null;
}

document.getElementById('ed-cancel').addEventListener('click', closeEditModal);
editModalBg.addEventListener('pointerdown', e => {
  if (e.target === editModalBg) closeEditModal();
});

document.getElementById('ed-save').addEventListener('click', async () => {
  if (!editingLink) return;

  const localIcon = document.getElementById('ed-local-icon').value.trim();
  // Personal icon only — no server write needed
  if (!userIsAdmin()) {
    await setLocalIcon(editingLink, localIcon);
    notify('success', 'Icon updated', `"${editingLink.title}" uses your icon.`);
    closeEditModal();
    return;
  }

  const title = document.getElementById('ed-title').value.trim();
  let url = document.getElementById('ed-url').value.trim();
  const icon = document.getElementById('ed-icon').value.trim();
  const category = document.getElementById('ed-category').value.trim() || 'General';
  const mode = document.getElementById('ed-mode').value === 'tab' ? 'tab' : 'window';

  if (!title || !url) return notify('error', 'Missing fields', 'Title and URL are required.');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const res = await api(`/links/${editingLink.id}`, {
    method: 'PUT', body: { title, url, icon, category, mode }
  });

  if (!res || !res.ok) {
    return notify('error', 'Update failed', 'Server rejected the change.');
  }

  Object.assign(editingLink, res.link);
  await loadSharedLinks();
  await setLocalIcon(editingLink, localIcon);
  notify('success', 'Link updated', title);
  closeEditModal();
});

document.getElementById('ed-delete').addEventListener('click', async () => {
  if (!editingLink || !confirm(`Delete "${editingLink.title}" for ALL users?`)) return;
  const target = editingLink;
  const res = await api(`/links/${target.id}`, { method: 'DELETE' });
  if (res && res.ok) {
    closeWindow(target.url + '__' + target.id);
    state.myLayout = state.myLayout.filter(i => i.linkId !== target.id);
    await loadSharedLinks();
    await saveLayoutWithStatus();
    await renderIcons();
    notify('success', 'Link deleted', target.title);
    closeEditModal();
  } else {
    notify('error', 'Delete failed', 'Admin permission required.');
  }
});

['ed-title', 'ed-url', 'ed-icon', 'ed-category', 'ed-local-icon'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('ed-save').click();
    if (e.key === 'Escape') closeEditModal();
  });
});

// ================= Clock =================
function tickClock() {
  clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(tickClock, 1000);
tickClock();

// ================= Init =================
document.getElementById('btn-login').addEventListener('click', login);
document.getElementById('btn-logout').addEventListener('click', logout);

async function init() {
  try {
    await loadSharedLinks();
    await loadUser();
    loadWallpaper();
    if (state.user) {
      await loadLayout();
      await syncGuestLayoutToServer();
      await renderIcons();
      setStatus('Synced', false);
    } else {
      await renderIcons();
      setStatus('Guest mode — changes not synced', false);
    }
  } catch (e) {
    setStatus('Connection error — some features may be unavailable', true);
    notify('error', 'Connection error', 'Could not connect to the server. Please check your internet connection.');
  }
}
init();