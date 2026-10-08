import { Router } from 'express';
import os from 'os';
import fs from 'fs/promises';
import { FILES_DIR } from '../lib/config.js';
import { getUser, requireAdmin } from '../lib/auth.js';
import { getDockerSummary } from './docker.js';

export const systemRouter = Router();

const DOCKER_MAX_AGE = 6000;

/* ---------- CPU (host) ---------- */
const snap = () => {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
};

let lastCpu = snap();
let cpuPct = 0;
setInterval(() => {
  const now = snap();
  const dt = now.total - lastCpu.total;
  cpuPct = dt > 0 ? Math.round((1 - (now.idle - lastCpu.idle) / dt) * 100) : 0;
  lastCpu = now;
}, 2000).unref();

/* ---------- Disk ---------- */
async function disk(p) {
  try {
    const s = await fs.statfs(p);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, used: total - free, pct: total ? Math.round(((total - free) / total) * 100) : 0 };
  } catch { return null; }
}

/* ---------- Docker (reuses routes/docker.js) ---------- */
async function dockerStats() {
  try {
    const d = await getDockerSummary(DOCKER_MAX_AGE);
    const cpuSum = d.containers.reduce((s, c) => s + (c.cpu || 0), 0);   // per-core %, can exceed 100
    const mem = d.containers.reduce((s, c) => s + (c.memUsage || 0), 0);
    return {
      running: d.host.running,
      total: d.host.total,
      cpu: Math.round((cpuSum / (d.host.cpus || 1)) * 10) / 10,          // share of whole host, like your card
      mem,
    };
  } catch {
    return null;   // widget just shows "–" for this row
  }
}

/* ---------- Route ---------- */
systemRouter.get('/', getUser, requireAdmin, async (_req, res) => {
  const total = os.totalmem(), free = os.freemem();
  const [diskInfo, docker] = await Promise.all([disk(FILES_DIR), dockerStats()]);
  res.json({
    cpu: { pct: cpuPct, cores: os.cpus().length, load: os.loadavg()[0] },
    mem: { total, used: total - free, pct: Math.round(((total - free) / total) * 100) },
    disk: diskInfo,
    docker,
  });
});