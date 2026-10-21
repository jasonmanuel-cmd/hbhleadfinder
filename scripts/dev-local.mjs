#!/usr/bin/env node
// One command to run the whole thing locally: a real Postgres with the schema and demo
// data, plus the Next.js dev server pointed at it.
//
//   npm run dev:local
//
// Then open http://localhost:3000 and sign in with the password below.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.LOCAL_PG_PORT || 54329);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'lead-desk';

const children = [];
let shuttingDown = false;

function run(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `[${name}]`;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) out.write(`${tag} ${l}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`${tag} exited with code ${code}`);
      shutdown(code ?? 1);
    }
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => process.exit(code), 400);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// 1. the database
const db = run('db', process.execPath, [path.join(ROOT, 'scripts', 'local-db.mjs')]);

// 2. wait for it to answer, then start the app
const { default: postgres } = await import('postgres');
let up = false;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const probe = postgres(URL, { max: 1, connect_timeout: 2, ssl: false, prepare: false });
  try {
    await probe`select 1`;
    up = true;
    await probe.end();
    break;
  } catch {
    await probe.end().catch(() => {});
  }
}
if (!up) {
  console.error('The local database never came up. See the [db] output above.');
  shutdown(1);
} else {
  console.log(`\n[app] starting Next.js on http://localhost:3000 — sign in with "${PASSWORD}"\n`);
  run('app', 'npx', ['next', 'dev', '-p', process.env.PORT || '3000', '-H', '0.0.0.0'], {
    DATABASE_URL: URL,
    PGSSLMODE: 'disable',
    DASHBOARD_PASSWORD: PASSWORD,
    SESSION_SECRET: process.env.SESSION_SECRET || 'local-dev-secret-not-for-production',
    CRON_SECRET: process.env.CRON_SECRET || 'local-cron-secret',
    // shows the password on the login page, so it never has to be looked up
    SHOW_LOGIN_HINT: '1',
    // the hosted preview renders the app in an iframe on another origin, where the
    // browser treats the session cookie as third-party and drops a SameSite=Lax one
    COOKIE_SAMESITE: 'none',
    // a proxy that rewrites the host would otherwise make Next reject the login
    // action with "Invalid Server Actions request"
    SERVER_ACTIONS_ALLOWED_ORIGINS: '*.e2b.app',
  });
}
