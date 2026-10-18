#!/usr/bin/env node
// A real Postgres for local development, with the schema applied and (optionally) demo data.
//
//   npm run db:local            # start it, apply the schema, seed demo data
//   npm run db:local -- --no-seed
//
// It downloads a real PostgreSQL binary the first time (via the embedded-postgres package),
// runs it on 127.0.0.1:54329 out of ./.localdb, and prints the DATABASE_URL to use.
// Nothing leaves the machine and no account is needed.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.localdb');
const PORT = Number(process.env.LOCAL_PG_PORT || 54329);
const USER = 'postgres';
const PASSWORD = 'postgres';
const URL = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/postgres`;

const noSeed = process.argv.includes('--no-seed');

// ---------------------------------------------------------------- embedded postgres
let EmbeddedPostgres;
try {
  ({ default: EmbeddedPostgres } = await import('embedded-postgres'));
} catch {
  console.log('First run: installing a local PostgreSQL binary (embedded-postgres)...');
  const r = spawnSync('npm', ['install', '--no-save', 'embedded-postgres'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('\nCould not install embedded-postgres. Install it manually:');
    console.error('  npm i -D embedded-postgres');
    process.exit(1);
  }
  ({ default: EmbeddedPostgres } = await import('embedded-postgres'));
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
  onLog: () => {},
  onError: (e) => console.error('[postgres]', e),
});

const fresh = !fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'));
console.log(fresh ? 'Initialising a new database...' : 'Starting the existing database...');
if (fresh && fs.readdirSync(DATA_DIR).length) {
  // a previous run died before initdb finished
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (fresh) await pg.initialise();
await pg.start();
console.log(`Postgres ${fresh ? '18' : ''} is up on 127.0.0.1:${PORT}`);

// ---------------------------------------------------------------- schema + demo data
const { default: postgres } = await import('postgres');
const sql = postgres(URL, { max: 1, prepare: false, max_pipeline: 0, ssl: false });

const migrate = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate.mjs'), '--url', URL],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PGSSLMODE: 'disable' } });
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

if (!noSeed) {
  const seed = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-demo.mjs'), '--url', URL],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PGSSLMODE: 'disable' } });
  if (seed.status !== 0) console.log('(demo seeding failed — the dashboard will still run)');
}

await sql.end();

console.log(`
The database is ready.

  DATABASE_URL=${URL}
  PGSSLMODE=disable

Leave this running in one terminal, and in another:

  DATABASE_URL="${URL}" PGSSLMODE=disable npm run dev
`);
console.log('Press Ctrl-C to stop the database.');

const stop = async () => {
  console.log('\nstopping postgres...');
  try { await pg.stop(); } catch { /* already gone */ }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
