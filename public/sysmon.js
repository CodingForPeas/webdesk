const ROWS = [['cpu', 'CPU'], ['mem', 'MEM'], ['disk', 'DISK'], ['docker', 'DOCKER']];
const HISTORY = 60;
const SPARK_W = 100, SPARK_H = 24;

const fmt = b => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(i > 2 ? 1 : 0) + ' ' + u[i];
};

function sparkPoints(values) {
  const offset = HISTORY - values.length;   // right-align so new data scrolls in from the right
  return values.map((v, i) => {
    const x = ((offset + i) / (HISTORY - 1)) * SPARK_W;
    const y = SPARK_H - 1 - (Math.min(100, Math.max(0, v)) / 100) * (SPARK_H - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
}

export function createSysMon({ api, intervalMs = 3000 }) {
  const el = document.getElementById('sysmon');
  const history = Object.fromEntries(ROWS.map(([k]) => [k, []]));

  el.innerHTML = ROWS.map(([k, label]) => `
    <div class="sm-row" data-k="${k}">
      <div class="sm-head"><span>${label}</span><span class="sm-val">–</span></div>
      <div class="dkr-bar"><div class="dkr-fill"></div></div>
      <svg class="sm-spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true">
        <polygon class="sm-area" points=""></polygon>
        <polyline class="sm-line" points=""></polyline>
      </svg>
      <div class="sm-sub"></div>
    </div>`).join('');

  function set(k, pct, val, sub) {
    const row = el.querySelector(`[data-k="${k}"]`);
    const fill = row.querySelector('.dkr-fill');
    row.querySelector('.sm-val').textContent = val;
    row.querySelector('.sm-sub').textContent = sub || '';
    fill.style.width = Math.min(100, pct) + '%';
    if (pct >= 85) fill.dataset.level = 'high';
    else if (pct >= 60) fill.dataset.level = 'mid';
    else delete fill.dataset.level;

    const h = history[k];
    h.push(pct);
    if (h.length > HISTORY) h.shift();
    const pts = sparkPoints(h);
    row.querySelector('.sm-line').setAttribute('points', pts.join(' '));
    row.querySelector('.sm-area').setAttribute('points',
      `${pts[0].split(',')[0]},${SPARK_H} ${pts.join(' ')} ${SPARK_W},${SPARK_H}`);
  }

  let timer = null, running = false;

  async function tick() {
    if (!running) return;
    if (!document.hidden) {
      const d = await api('/system');
      if (d) {
        set('cpu', d.cpu.pct, d.cpu.pct + '%', `${d.cpu.cores} cores · load ${d.cpu.load.toFixed(2)}`);
        set('mem', d.mem.pct, d.mem.pct + '%', `${fmt(d.mem.used)} / ${fmt(d.mem.total)}`);
        if (d.disk) set('disk', d.disk.pct, d.disk.pct + '%', `${fmt(d.disk.used)} / ${fmt(d.disk.total)}`);
        if (d.docker) {
          set('docker', d.docker.cpu, `${d.docker.running}/${d.docker.total}`,
            `CPU ${d.docker.cpu.toFixed(1)}% · MEM ${fmt(d.docker.mem)}`);
        }
      }
    }
    if (running) timer = setTimeout(tick, intervalMs);
  }

  return {
    start() { if (running) return; running = true; el.hidden = false; tick(); },
    stop() { running = false; clearTimeout(timer); el.hidden = true; },
  };
}