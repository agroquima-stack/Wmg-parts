import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { pool } from '../db.js';

export async function migrate() {
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
