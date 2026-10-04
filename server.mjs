// server.mjs
import { app, loadTemplate } from './lib/app.js';
import { initDb, pool } from './lib/db.js';
import { initCsrf, closeRedis } from './lib/csrf.js';
import { FILES_DIR, WALL_DIR } from './lib/config.js';
import fs from 'fs';

fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(WALL_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;
let server;

initCsrf()
  .then(() => initDb())
  .then(() => loadTemplate())
  .then(() => new Promise(resolve => {
    server = app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      resolve();
    });
  }))
  .catch(err => {
    console.error('Startup failed — is DB_URL correct?', err);
    process.exit(1);
  });

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, draining…');
  server?.close();
  await pool.end();
  await closeRedis();
  process.exit(0);
});

process.on('SIGINT', async () => {
  server?.close();
  await pool.end();
  await closeRedis();
  process.exit(0);
});