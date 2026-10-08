import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { pool } from '../db.js';

export async function migrate() {
  const lock = await pool.connect();                     // impede duas instâncias migrando ao mesmo tempo (ex.: Cloud Run subindo 2 containers)
  await lock.query('select pg_advisory_lock(727001)');
  try { await run(); } finally { await lock.query('select pg_advisory_unlock(727001)'); lock.release(); }
}
async function run() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await pool.query('select name from schema_migrations')).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const c = await pool.connect();
    try {
      await c.query('begin'); await c.query(readFileSync(join(dir, f), 'utf8'));
      await c.query('insert into schema_migrations (name) values ($1)', [f]); await c.query('commit');
      console.log('migração aplicada:', f);
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  }
}
if (import.meta.url === `file://${process.argv[1]}`) { await migrate(); await pool.end(); }
