// A migrated Postgres (PGlite = Postgres 18 compiled to WASM) that tests can share.
// No server, no Docker, no setup.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'supabase', 'migrations');

// Supabase provides these roles; create them so the grants/revokes in the migrations apply.
const BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
`;

// pgcrypto is a Supabase extension; PGlite does not bundle it. gen_random_uuid() has been
// built into core Postgres since 13, so dropping the extension line changes nothing.
const STRIP = /create extension if not exists pgcrypto;/i;

export const DATA_TABLES = [
  'borrower_dossiers', 'deal_stage_events', 'enrichment_runs', 'enrichment_jobs',
  'outreach', 'deals', 'lead_scores', 'distress_events', 'property_owners', 'properties',
  'owners', 'raw_lead_intake', 'source_runs', 'tax_defaults', 'org_settings',
];

export async function migrate(db) {
  await db.exec(BOOTSTRAP);
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').replace(STRIP, '');
    await db.exec(sql);
  }
  return db;
}

let shared = null;

export async function freshDb() {
  if (!shared) shared = await migrate(new PGlite());
  await shared.exec(`truncate ${DATA_TABLES.join(', ')} restart identity cascade`);
  return shared;
}

export const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];
export const all = async (db, sql, params = []) => (await db.query(sql, params)).rows;

/**
 * A postgres.js-shaped client over PGlite, so code written against the `postgres`
 * package can be tested without a server. Supports the tagged-template form and
 * `.unsafe()` with positional parameters.
 */
export function pgliteClient(db) {
  const run = async (text, params) => (await db.query(text, params)).rows;
  const client = (strings, ...values) => {
    let text = strings[0];
    values.forEach((v, i) => { text += `$${i + 1}${strings[i + 1]}`; });
    return run(text, values);
  };
  // postgres.js takes the parameters as one array; PGlite takes them spread.
  client.unsafe = (text, ...params) =>
    run(text, params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
  client.json = (v) => JSON.stringify(v);
  return client;
}
