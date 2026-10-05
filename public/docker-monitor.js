// docker-monitor.js — renders the Docker panel. All Docker-supplied text goes in via textContent.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function fmtBytes(n) {
  if (n == null) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
const fmtPct = n => (n == null ? '–' : `${n.toFixed(1)}%`);

function bar(pct) {
  const wrap = el('div', 'dkr-bar');
  const fill = el('div', 'dkr-fill');
  const p = Math.min(100, Math.max(0, pct || 0));
  fill.style.width = p + '%';
  fill.dataset.level = p >= 85 ? 'high' : p >= 60 ? 'mid' : 'ok';
  wrap.appendChild(fill);
  return wrap;
}

function card(label, value, sub) {
  const c = el('div', 'dkr-card');
  c.appendChild(el('div', 'dkr-card-label', label));
  c.appendChild(el('div', 'dkr-card-value', value));
  if (sub) c.appendChild(el('div', 'dkr-card-sub', sub));
  return c;
}

export function createDockerPanel({ api, intervalMs = 5000, isActive = () => true }) {
  const root = el('div', 'dkr-panel');

  const toolbar = el('div', 'dkr-toolbar');
  const refreshBtn = el('button');
  const refreshIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  refreshIcon.classList.add('ui-icon');
  refreshIcon.setAttribute('aria-hidden', 'true');
  const refreshUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  refreshUse.setAttribute('href', '/icons/ui.svg#refresh');
  refreshIcon.appendChild(refreshUse);
  refreshBtn.append(refreshIcon, document.createTextNode(' Refresh'));
  const updated = el('span', 'dkr-updated', 'Loading…');
  toolbar.append(refreshBtn, updated);

  const cards = el('div', 'dkr-cards');
  const error = el('div', 'dkr-error');
  error.hidden = true;

  const scroller = el('div', 'dkr-scroll');
  const table = el('table', 'dkr-table');
  const head = el('thead');
  const headRow = el('tr');
  ['Container', 'Status', 'CPU', 'Memory', 'Net ↓ / ↑', 'PIDs']
    .forEach(h => headRow.appendChild(el('th', null, h)));
  head.appendChild(headRow);
  const body = el('tbody');
  table.append(head, body);
  scroller.appendChild(table);

  root.append(toolbar, error, cards, scroller);

  function render(data) {
    error.hidden = true;
    const { host, containers } = data;

    const totalCpu = containers.reduce((s, c) => s + (c.cpu || 0), 0);
    const totalMem = containers.reduce((s, c) => s + (c.memUsage || 0), 0);

    cards.replaceChildren(
      card('Running', `${host.running}`, `${host.total} total · ${host.images} images`),
      card('Container CPU', fmtPct(totalCpu / (host.cpus || 1)), `${host.cpus} cores · ${fmtPct(totalCpu)} summed`),
      card('Container RAM', fmtBytes(totalMem), `of ${fmtBytes(host.memTotal)}`),
      card('Docker', host.version || '?', host.os || '')
    );

    body.replaceChildren();
    if (!containers.length) {
      const tr = el('tr');
      const td = el('td', 'dkr-empty', 'No running containers.');
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
    }

    [...containers].sort((a, b) => (b.cpu || 0) - (a.cpu || 0)).forEach(c => {
      const tr = el('tr');

      const name = el('td', 'dkr-name');
      name.appendChild(el('div', 'dkr-cname', c.name));
      name.appendChild(el('div', 'dkr-sub', c.image));

      const status = el('td');
      const badge = el('span', 'dkr-badge', c.state);
      badge.dataset.state = c.state;
      status.append(badge, el('div', 'dkr-sub', c.status));

      const cpu = el('td');
      cpu.append(el('div', null, fmtPct(c.cpu)), bar(c.cpu));

      const mem = el('td');
      mem.append(
        el('div', null, `${fmtBytes(c.memUsage)} / ${fmtBytes(c.memLimit)}`),
        bar(c.memPct)
      );

      const net = el('td', null, `${fmtBytes(c.netRx)} / ${fmtBytes(c.netTx)}`);
      const pids = el('td', null, c.pids == null ? '–' : String(c.pids));

      tr.append(name, status, cpu, mem, net, pids);
      body.appendChild(tr);
    });

    if (data.truncated) {
      const tr = el('tr');
      const td = el('td', 'dkr-empty', 'Showing the first containers only (limit reached).');
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
    }

    updated.textContent = `Updated ${new Date(data.at).toLocaleTimeString()}`;
  }

  let timer = null;
  let inflight = false;

  async function refresh() {
    if (inflight) return;
    inflight = true;
    refreshBtn.disabled = true;
    try {
      const data = await api('/docker/summary');
      if (data) render(data);
      else {
        error.textContent = api._lastError || 'Could not load Docker data.';
        error.hidden = false;
        updated.textContent = 'Update failed';
      }
    } finally {
      inflight = false;
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', refresh);

  return {
    el: root,
    refresh,
    start() {
      refresh();
      timer = setInterval(() => {
        if (document.hidden || !isActive()) return;   // don't poll when nobody is looking
        refresh();
      }, intervalMs);
    },
    stop() { clearInterval(timer); timer = null; },
  };
}