#!/usr/bin/env node
// Apply the schema migrations to any Postgres database, in order, exactly once.
//
//   npm run db:migrate                      # uses DATABASE_URL
//   npm run db:migrate -- --url <url>      # explicit
//   npm run db:migrate -- --status          # what has been applied
//   npm run db:migrate -- --force           # re-apply everything (destructive)
//
// The script keeps its own ledger (schema_migrations) so re-running it is safe and
// a partially-applied migration is visible instead of silently ignored.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'supabase', 'migrations');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const url = opt('url') || process.env.DATABASE_URL;
if (!url) {
  console.error('No DATABASE_URL. Set it, or pass --url <connection string>.');
  process.exit(1);
}

const { default: postgres } = await import('postgres');
const sql = postgres(url, { max: 1, prepare: false, max_pipeline: 0, connect_timeout: 15, onnotice: () => {}, ssl: process.env.PGSSLMODE === 'disable' ? false : undefined });

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const checksum = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

const LEDGER = `
  create table if not exists schema_migrations (
    filename   text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  )`;

try {
  await sql.unsafe(LEDGER);
} catch (e) {
  console.error(`Could not reach the database: ${e.message}`);
  await sql.end();
  process.exit(1);
}

// Supabase provisions these roles; the migrations revoke privileges from them, so a plain
// Postgres needs them to exist first. No-op on Supabase.
try {
  await sql.unsafe(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end $$;`);
} catch (e) {
  console.warn(`Could not create the anon/authenticated/service_role roles (${e.message}).`);
  console.warn('If the migrations fail on those roles, create them as a superuser first.');
}

const applied = new Map(
  (await sql`select filename, checksum from schema_migrations`).map((r) => [r.filename, r.checksum]),
);
const schemaExists = await sql`
  select count(*)::int as n from information_schema.tables
   where table_schema = 'public' and table_name = 'state_rules'`;
const alreadyThere = schemaExists[0].n > 0;

if (flag('status')) {
  console.log(`database: ${url.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@')}`);
  console.log(`migrations: ${files.length} on disk, ${applied.size} recorded\n`);
  for (const f of files) {
    const c = checksum(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const rec = applied.get(f);
    const state = rec === undefined ? 'pending' : rec === c ? 'applied' : 'CHANGED';
    console.log(`  ${state.padEnd(8)} ${f}${rec && rec !== c ? `  (recorded ${rec}, now ${c})` : ''}`);
  }
  await sql.end();
  process.exit(0);
}

if (flag('force')) {
  console.log('--force: re-applying every migration.\n');
  await sql`delete from schema_migrations`;
  applied.clear();
} else if (applied.size === 0 && alreadyThere) {
  // The schema is already in place but the ledger is empty (e.g. the migrations were
  // pasted into the Supabase SQL editor). Record them instead of failing on "already exists".
  console.log('This database already has the schema but no migration ledger.');
  console.log('Recording the existing migrations as applied. Use --force to re-apply them.\n');
  for (const f of files) {
    const c = checksum(fs.readFileSync(path.join(DIR, f), 'utf8'));
    await sql`insert into schema_migrations (filename, checksum) values (${f}, ${c}) on conflict do nothing`;
  }
  console.log(`recorded ${files.length} migrations — nothing to do.`);
  await sql.end();
  process.exit(0);
}

let n = 0;
for (const f of files) {
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  const c = checksum(text);
  if (applied.has(f)) {
    if (applied.get(f) !== c) {
      console.log(`  ~ ${f} — file changed since it was applied (recorded ${applied.get(f)}, now ${c})`);
    }
    continue;
  }
  process.stdout.write(`  → ${f} ... `);
  try {
    await sql.unsafe(text);
    await sql`insert into schema_migrations (filename, checksum) values (${f}, ${c})
               on conflict (filename) do update set checksum = excluded.checksum, applied_at = now()`;
    console.log('ok');
    n++;
  } catch (e) {
    console.log('FAILED');
    console.error(`\n${e.message}\n`);
    console.error(`The database may now be half-migrated. Fix the problem and run this again —`);
    console.error(`migrations already recorded are skipped.`);
    await sql.end();
    process.exit(1);
  }
}

console.log(n ? `\napplied ${n} migration${n === 1 ? '' : 's'}.` : '\nnothing to apply — the schema is up to date.');
await sql.end();
