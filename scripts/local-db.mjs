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
// The Postgres binary is installed into ./.tools, isolated from the app's own
// dependencies, so fetching it can never disturb the tree npm manages.
const TOOLS_DIR = path.join(ROOT, '.tools');

async function loadEmbeddedPostgres() {
  try {
    return (await import('embedded-postgres')).default;
  } catch { /* not installed here */ }
  try {
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const req = createRequire(path.join(TOOLS_DIR, 'package.json'));
    const mod = await import(pathToFileURL(req.resolve('embedded-postgres')).href);
    return mod.default;
  } catch { /* not installed in .tools either */ }
  return null;
}

let EmbeddedPostgres = await loadEmbeddedPostgres();
if (!EmbeddedPostgres) {
  console.log('First run: fetching a local PostgreSQL binary (one time, ~60 MB)...');
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TOOLS_DIR, 'package.json'),
    JSON.stringify({ name: 'hbh-local-tools', private: true, version: '1.0.0' }, null, 2) + '\n',
  );
  const r = spawnSync('npm', ['install', '--prefix', TOOLS_DIR, '--no-save', '--no-audit', '--no-fund', 'embedded-postgres'],
    { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('\nCould not install embedded-postgres. Install it manually:');
    console.error('  npm i -D embedded-postgres');
    process.exit(1);
  }
  EmbeddedPostgres = await loadEmbeddedPostgres();
  if (!EmbeddedPostgres) {
    console.error('embedded-postgres installed but could not be loaded.');
    process.exit(1);
  }
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

// A previous run may still have Postgres on the port. Reuse it rather than crashing
// with a port conflict.
let started = false;
if (await portInUse(PORT)) {
  if (await canConnect(URL)) {
    console.log(`Reusing the Postgres already listening on ${PORT}.`);
    started = true;
  } else {
    console.error(`Port ${PORT} is in use by something that is not this database.`);
    console.error(`Stop it, or pick another port: LOCAL_PG_PORT=54330 npm run dev:local`);
    process.exit(1);
  }
}
if (!started) {
  if (fresh) await pg.initialise();
  await pg.start();
  console.log(`Postgres ${fresh ? '18' : ''} is up on 127.0.0.1:${PORT}`);
}

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
  try { if (started) await pg.stop(); } catch { /* already gone */ }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function portInUse(port) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
}

async function canConnect(url) {
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, ssl: false, prepare: false });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}
