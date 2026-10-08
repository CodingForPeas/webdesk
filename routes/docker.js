// routes/docker.js
import express from 'express';
import http from 'http';
import { getUser, requireAdmin } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';

export const dockerRouter = express.Router();

const MAX_CONTAINERS = 40;
const MAX_BYTES = 5 * 1024 * 1024;
const CACHE_MS = 2000;

// Talk to the socket by default, or to a socket proxy via DS_HOST=tcp://host:2375
const TARGET = process.env.DS_HOST
  ? (() => {
      const u = new URL(process.env.DS_HOST.replace(/^tcp:/, 'http:'));
      return { host: u.hostname, port: Number(u.port) || 2375 };
    })()
  : { socketPath: process.env.DOCKER_SOCK || '/var/run/docker.sock' };

  /*
function requireAdmin(req, _res, next) {
  // Adjust if your admin flag lives somewhere else on req.user
  if (!req.user?.isAdmin) throw new HttpError(403, 'Admin permission required.');
  next();
}*/

function dockerGet(path) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { ...TARGET, path, method: 'GET', headers: { Host: 'docker' }, timeout: 8000 },
      res => {
        const chunks = [];
        let size = 0;
        res.on('data', c => {
          size += c.length;
          if (size > MAX_BYTES) return r.destroy(new Error('Docker response too large'));
          chunks.push(c);
        });
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`Docker API returned ${res.statusCode}`));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error('Bad response from Docker')); }
        });
      }
    );
    r.on('timeout', () => r.destroy(new Error('Docker API timed out')));
    r.on('error', reject);
    r.end();
  });
}

function summariseStats(st, fallbackCpus) {
  const cpuDelta = (st.cpu_stats?.cpu_usage?.total_usage ?? 0) - (st.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (st.cpu_stats?.system_cpu_usage ?? 0) - (st.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = st.cpu_stats?.online_cpus || st.cpu_stats?.cpu_usage?.percpu_usage?.length || fallbackCpus || 1;
  const cpu = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;

  const ms = st.memory_stats ?? {};
  const cache = ms.stats?.inactive_file ?? ms.stats?.total_inactive_file ?? ms.stats?.cache ?? 0;
  const memUsage = Math.max(0, (ms.usage ?? 0) - cache);
  const memLimit = ms.limit ?? 0;

  let netRx = 0, netTx = 0;
  for (const n of Object.values(st.networks ?? {})) {
    netRx += n.rx_bytes ?? 0;
    netTx += n.tx_bytes ?? 0;
  }

  return {
    cpu,
    memUsage,
    memLimit,
    memPct: memLimit ? (memUsage / memLimit) * 100 : 0,
    netRx,
    netTx,
    pids: st.pids_stats?.current ?? null,
  };
}

const cache = { at: 0, data: null, pending: null };

async function buildSummary() {
  const [info, list] = await Promise.all([
    dockerGet('/info'),
    dockerGet('/containers/json'),            // running containers only
  ]);

  const shown = list.slice(0, MAX_CONTAINERS);
  const stats = await Promise.allSettled(
    shown.map(c => dockerGet(`/containers/${c.Id}/stats?stream=false`))
  );

  const containers = shown.map((c, i) => ({
    id: c.Id.slice(0, 12),
    name: (c.Names?.[0] || c.Id).replace(/^\//, ''),
    image: c.Image,
    state: c.State,
    status: c.Status,
    ...(stats[i].status === 'fulfilled'
      ? summariseStats(stats[i].value, info.NCPU)
      : { cpu: null, memUsage: null, memLimit: null, memPct: null, netRx: null, netTx: null, pids: null }),
  }));

  return {
    host: {
      version: info.ServerVersion,
      os: info.OperatingSystem,
      cpus: info.NCPU,
      memTotal: info.MemTotal,
      running: info.ContainersRunning,
      total: info.Containers,
      images: info.Images,
    },
    truncated: list.length > shown.length,
    containers,
    at: Date.now(),
  };
}

// Shared by the Docker window and the system widget.
// maxAgeMs lets callers that poll often accept slightly older data.
export function getDockerSummary(maxAgeMs = CACHE_MS) {
  if (cache.data && Date.now() - cache.at < maxAgeMs) return Promise.resolve(cache.data);
  cache.pending ??= buildSummary()
    .then(d => { cache.data = d; cache.at = Date.now(); return d; })
    .finally(() => { cache.pending = null; });
  return cache.pending;
}

dockerRouter.get('/summary', getUser, requireAdmin, async (_req, res) => {
  try {
    res.json(await getDockerSummary());
  } catch (e) {
    console.error('Docker query failed:', e.message);
    throw new HttpError(503, 'Could not reach Docker. Is the socket mounted and readable?');
  }
});

/*
const cache = { at: 0, data: null, pending: null };

async function buildSummary() {
  const [info, list] = await Promise.all([
    dockerGet('/info'),
    dockerGet('/containers/json'),            // running containers only
  ]);

  const shown = list.slice(0, MAX_CONTAINERS);
  const stats = await Promise.allSettled(
    shown.map(c => dockerGet(`/containers/${c.Id}/stats?stream=false`))
  );

  const containers = shown.map((c, i) => ({
    id: c.Id.slice(0, 12),
    name: (c.Names?.[0] || c.Id).replace(/^\//, ''),
    image: c.Image,
    state: c.State,
    status: c.Status,
    ...(stats[i].status === 'fulfilled'
      ? summariseStats(stats[i].value, info.NCPU)
      : { cpu: null, memUsage: null, memLimit: null, memPct: null, netRx: null, netTx: null, pids: null }),
  }));

  return {
    host: {
      version: info.ServerVersion,
      os: info.OperatingSystem,
      cpus: info.NCPU,
      memTotal: info.MemTotal,
      running: info.ContainersRunning,
      total: info.Containers,
      images: info.Images,
    },
    truncated: list.length > shown.length,
    containers,
    at: Date.now(),
  };
}

dockerRouter.get('/summary', getUser, requireAdmin, async (_req, res) => {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return res.json(cache.data);

  cache.pending ??= buildSummary().finally(() => { cache.pending = null; });
  try {
    cache.data = await cache.pending;
    cache.at = Date.now();
    res.json(cache.data);
  } catch (e) {
    console.error('Docker query failed:', e.message);
    throw new HttpError(503, 'Could not reach Docker. Is the socket mounted and readable?');
  }
});*/