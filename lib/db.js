// lib/db.js
import { Pool } from 'pg';
import { DEFAULT_LINKS } from './config.js';

export const pool = new Pool({
  connectionString: process.env.DB_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => console.error('Unexpected PG pool error:', err));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT,
  name            TEXT,
  wallpaper_kind  TEXT DEFAULT 'gradient',
  wallpaper_ref   TEXT DEFAULT 'classic',
  used_bytes      BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shared_links (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  icon        TEXT,
  mode        TEXT DEFAULT 'window',
  category    TEXT DEFAULT 'General',
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_layouts (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  links       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shared_links_order ON shared_links (category, title);
`;

export async function resetLinks(rows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM shared_links');
    await client.query("SELECT setval(pg_get_serial_sequence('shared_links','id'), 1, false)");
    for (const l of rows) {
      await client.query(
        'INSERT INTO shared_links (title, url, icon, category) VALUES ($1,$2,$3,$4)',
        [l.title, l.url, l.icon, l.category]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function initDb() {
  await pool.query(SCHEMA);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM shared_links');
  if (rows[0].c === 0) await resetLinks(DEFAULT_LINKS);
}

