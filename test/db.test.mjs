// Database contract tests.
//
// These run the real migrations against a real Postgres engine (PGlite = Postgres 18
// compiled to WASM, so no server and no Docker needed) and then exercise the rules the
// business actually depends on: matching, scoring, the equity-purchaser compliance
// guard, do-not-contact enforcement, and the letter queue.
//
// If a migration breaks, or a guard silently stops firing, `npm test` fails.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

// Supabase provides these roles; create them so the grants/revokes in the migrations apply.
const BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
`;

// pgcrypto is a Supabase extension; PGlite does not bundle it. gen_random_uuid() has been
// built into core Postgres since 13, so dropping the extension line changes nothing.
const STRIP = /create extension if not exists pgcrypto;/i;

async function migrate(db) {
  await db.exec(BOOTSTRAP);
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').replace(STRIP, '');
    await db.exec(sql);
  }
  return db;
}

// One migrated database, shared by every test; data is cleared between tests.
let shared = null;
const DATA_TABLES = ['borrower_dossiers', 'deal_stage_events', 'enrichment_runs', 'enrichment_jobs',
  'outreach', 'deals', 'lead_scores', 'distress_events', 'property_owners', 'properties',
  'owners', 'raw_lead_intake', 'source_runs', 'tax_defaults', 'org_settings'];

async function freshDb() {
  if (!shared) shared = await migrate(new PGlite());
  await shared.exec(`truncate ${DATA_TABLES.join(', ')} restart identity cascade`);
  return shared;
}

const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (db, sql, params = []) => (await db.query(sql, params)).rows;

const INSERT_INTAKE = `insert into raw_lead_intake
  (source_name, source_type, source_record_id, event_date, raw_state, raw_county,
   raw_apn, raw_address, raw_city, raw_zip, raw_owner_name, raw_payload)
  values ($1, $2, $3, current_date, 'CA', 'Kern', $4, $5, $6, $7, $8, $9::jsonb) returning id`;

// ---------------------------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------------------------

test('every migration applies cleanly, in order, to an empty database', async () => {
  const db = await new PGlite();
  await db.exec(BOOTSTRAP);
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 9, 'expected the full migration set');
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').replace(STRIP, '');
    await db.exec(sql); // throws on error
  }
  // shared database: leave it open for the next test
});

test('the dashboard role can read and write but the anonymous role cannot', async () => {
  const db = await freshDb();
  const priv = await one(db, `select
      has_function_privilege('hbh_dashboard', 'process_pending_intake(int)', 'execute')  as dash_run,
      has_function_privilege('anon',            'process_pending_intake(int)', 'execute')  as anon_run,
      has_function_privilege('anon',            'recalculate_lead_score(uuid)', 'execute') as anon_score`);
  assert.equal(priv.dash_run, true, 'hbh_dashboard must be able to process intake');
  assert.equal(priv.anon_run, false, 'anon must not be able to process intake');
  assert.equal(priv.anon_score, false, 'anon must not be able to rescore leads');

  const rls = await all(db, `select relname, relrowsecurity from pg_class
                              where relname in ('properties','owners','outreach','raw_lead_intake','deals')`);
  assert.equal(rls.length, 5);
  for (const t of rls) assert.equal(t.relrowsecurity, true, `${t.relname} must have RLS on`);
  // shared database: leave it open for the next test
});

// ---------------------------------------------------------------------------------------------
// Ingest + matching
// ---------------------------------------------------------------------------------------------

test('a filing becomes a scored lead', async () => {
  const db = await freshDb();
  const id = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_default', 'DOC-1',
    '123-456-09', '123 N Main St', 'Bakersfield', '93301', 'DOE JANE A',
    JSON.stringify({ document_number: 'DOC-1', recorded_date: '2026-10-01' })]);
  const res = await one(db, 'select process_raw_property_lead($1) as r', [id.id]);
  assert.equal(res.r.status, 'processed');

  const score = await one(db, 'select * from lead_scores where property_id = $1', [res.r.property_id]);
  assert.ok(score, 'a score row must exist');
  assert.equal(score.urgency_score, 30, 'a notice of default is worth 30 urgency points');
  assert.ok(['A', 'B', 'C', 'D'].includes(score.lead_tier));

  const prop = await one(db, 'select * from properties where id = $1', [res.r.property_id]);
  assert.equal(prop.apn_key, '12345609');
  assert.equal(prop.address_key, '123 N MAIN ST');
  // shared database: leave it open for the next test
});

test('re-importing the same document number does not duplicate anything', async () => {
  const db = await freshDb();
  const args = ['kern_recorder', 'notice_of_default', 'DOC-1', '123-456-09', '123 N Main St',
    'Bakersfield', '93301', 'DOE JANE A', JSON.stringify({ document_number: 'DOC-1' })];
  await db.query(INSERT_INTAKE, args);
  const again = await db.query(INSERT_INTAKE.replace('returning id', 'on conflict do nothing returning id'), args);
  assert.equal(again.rows.length, 0, 'the second insert must be rejected');

  await db.query('select process_pending_intake(100)');
  const n = await one(db, 'select count(*)::int c from properties');
  assert.equal(n.c, 1);
  // shared database: leave it open for the next test
});

test('a second filing on the same parcel attaches instead of creating a new property', async () => {
  const db = await freshDb();
  const a = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_default', 'DOC-1', '123-456-09',
    '123 N Main St', 'Bakersfield', '93301', 'DOE JANE A', JSON.stringify({ document_number: 'DOC-1' })]);
  const b = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_trustee_sale', 'DOC-2', '123-456-09',
    '123 N Main St', 'Bakersfield', '93301', 'DOE JANE A',
    JSON.stringify({ document_number: 'DOC-2', auction_date: '2026-11-30' })]);
  const ra = await one(db, 'select process_raw_property_lead($1) as r', [a.id]);
  const rb = await one(db, 'select process_raw_property_lead($1) as r', [b.id]);
  assert.equal(rb.r.property_id, ra.r.property_id);

  const n = await one(db, 'select count(*)::int c from properties');
  assert.equal(n.c, 1, 'one property, not two');
  const events = await one(db, 'select count(*)::int c from distress_events where property_id = $1', [ra.r.property_id]);
  assert.equal(events.c, 2, 'both filings are kept in the event history');
  // shared database: leave it open for the next test
});

test('a name-only filing attaches to a tracked property', async () => {
  const db = await freshDb();
  const a = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_default', 'DOC-1', '123-456-09',
    '123 N Main St', 'Bakersfield', '93301', 'DOE JANE A', JSON.stringify({ document_number: 'DOC-1' })]);
  const ra = await one(db, 'select process_raw_property_lead($1) as r', [a.id]);

  const b = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_trustee_sale', 'DOC-3',
    null, null, null, null, 'DOE JANE A', JSON.stringify({ document_number: 'DOC-3' })]);
  const rb = await one(db, 'select process_raw_property_lead($1) as r', [b.id]);
  assert.equal(rb.r.matched_by_name, true);
  assert.equal(rb.r.property_id, ra.r.property_id);
  // shared database: leave it open for the next test
});

test('an unknown name waits in the find-the-parcel queue instead of guessing', async () => {
  const db = await freshDb();
  const id = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_default', 'DOC-4',
    null, null, null, null, 'ZZZ UNKNOWN PERSON', JSON.stringify({ document_number: 'DOC-4' })]);
  const res = await one(db, 'select process_raw_property_lead($1) as r', [id.id]);
  assert.equal(res.r.status, 'needs_property_match');

  const queued = await all(db, 'select * from v_needs_match');
  assert.equal(queued.length, 1, 'it must show up in the human review queue');
  // shared database: leave it open for the next test
});

test('an attach-only filing with no tracked property is ignored, not turned into a lead', async () => {
  const db = await freshDb();
  const id = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_rescission', 'DOC-5',
    null, null, null, null, 'NOBODY HERE', JSON.stringify({ document_number: 'DOC-5' })]);
  const res = await one(db, 'select process_raw_property_lead($1) as r', [id.id]);
  assert.equal(res.r.status, 'ignored');
  const n = await one(db, 'select count(*)::int c from properties');
  assert.equal(n.c, 0, 'a rescission must not create a property');
  // shared database: leave it open for the next test
});

// ---------------------------------------------------------------------------------------------
// Compliance guards
// ---------------------------------------------------------------------------------------------

test('a deal cannot reach offer_sent until an attorney has reviewed the equity-purchase statute', async () => {
  const db = await freshDb();
  const id = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_trustee_sale', 'DOC-1',
    '123-456-09', '123 N Main St', 'Bakersfield', '93301', 'DOE JANE A',
    JSON.stringify({ document_number: 'DOC-1' })]);
  const res = await one(db, 'select process_raw_property_lead($1) as r', [id.id]);
  const pid = res.r.property_id;

  await db.query(`update properties set estimated_market_value = 400000, estimated_loan_balance = 350000,
                         owner_occupied = true, units = 1 where id = $1`, [pid]);
  await db.query('select recalculate_lead_score($1)', [pid]);
  const score = await one(db, 'select equity_purchase_law_applies from lead_scores where property_id = $1', [pid]);
  assert.equal(score.equity_purchase_law_applies, true, 'an occupied 1-4 unit home in foreclosure is flagged');

  await assert.rejects(
    () => db.query(`update deals set stage = 'offer_sent' where property_id = $1`, [pid]),
    /equity-purchaser statute/i,
    'the guard must block the stage change',
  );

  await db.query(`update deals set compliance_reviewed = true where property_id = $1`, [pid]);
  await db.query(`update deals set stage = 'offer_sent' where property_id = $1`, [pid]);
  const deal = await one(db, 'select stage from deals where property_id = $1', [pid]);
  assert.equal(deal.stage, 'offer_sent', 'after review the move is allowed');
  // shared database: leave it open for the next test
});

test('outbound contact is blocked for a do-not-contact owner, inbound still works', async () => {
  const db = await freshDb();
  const id = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_default', 'DOC-1',
    '123-456-09', '123 N Main St', 'Bakersfield', '93301', 'DOE JANE A',
    JSON.stringify({ document_number: 'DOC-1' })]);
  const res = await one(db, 'select process_raw_property_lead($1) as r', [id.id]);
  const pid = res.r.property_id;
  const owner = await one(db, 'select owner_id from property_owners where property_id = $1 limit 1', [pid]);

  await db.query('update owners set do_not_contact = true where id = $1', [owner.owner_id]);
  await assert.rejects(
    () => db.query(`insert into outreach (property_id, owner_id, channel, direction, status)
                    values ($1, $2, 'call', 'outbound', 'attempted')`, [pid, owner.owner_id]),
    /do-not-contact/i,
  );
  await db.query(`insert into outreach (property_id, owner_id, channel, direction, status)
                  values ($1, $2, 'call', 'inbound', 'reached')`, [pid, owner.owner_id]);
  // shared database: leave it open for the next test
});

test('logging opted_out marks the person do-not-contact and blocks later touches', async () => {
  const db = await freshDb();
  const id = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_default', 'DOC-1',
    '123-456-09', '123 N Main St', 'Bakersfield', '93301', 'DOE JANE A',
    JSON.stringify({ document_number: 'DOC-1' })]);
  const res = await one(db, 'select process_raw_property_lead($1) as r', [id.id]);
  const pid = res.r.property_id;
  const owner = await one(db, 'select owner_id from property_owners where property_id = $1 limit 1', [pid]);

  await db.query(`insert into outreach (property_id, owner_id, channel, direction, status)
                  values ($1, $2, 'call', 'outbound', 'opted_out')`, [pid, owner.owner_id]);
  const o = await one(db, 'select do_not_contact from owners where id = $1', [owner.owner_id]);
  assert.equal(o.do_not_contact, true);

  await assert.rejects(
    () => db.query(`insert into outreach (property_id, owner_id, channel, direction, status)
                    values ($1, $2, 'call', 'outbound', 'attempted')`, [pid, owner.owner_id]),
    /do-not-contact/i,
  );
  // shared database: leave it open for the next test
});

// ---------------------------------------------------------------------------------------------
// Scoring + queueing
// ---------------------------------------------------------------------------------------------

test('a new lead gets a first follow-up and lands in the letter queue', async () => {
  const db = await freshDb();
  const id = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_trustee_sale', 'DOC-1',
    '111-222-03', '500 Oak Ave', 'Bakersfield', '93301', 'SMITH JOHN A',
    JSON.stringify({ document_number: 'DOC-1', auction_date: '2026-12-01' })]);
  const res = await one(db, 'select process_raw_property_lead($1) as r', [id.id]);
  const pid = res.r.property_id;

  const deal = await one(db, 'select stage, next_follow_up_at from deals where property_id = $1', [pid]);
  assert.ok(deal.next_follow_up_at, 'a follow-up must be scheduled automatically');

  const letters = await all(db, 'select * from v_letter_queue');
  assert.equal(letters.length, 1);
  assert.equal(letters[0].primary_signal, 'notice_of_trustee_sale');
  assert.deepEqual(letters[0].recipients, ['SMITH JOHN A']);

  const sale = await one(db, 'select estimated_sale_date($1) as d', [pid]);
  assert.ok(sale.d, 'an estimated sale date must be derivable');
  // shared database: leave it open for the next test
});

test('a lead with a missing street address is queued for address lookup, not mailed', async () => {
  const db = await freshDb();
  const id = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_trustee_sale', 'DOC-1',
    '111-222-03', null, null, null, 'SMITH JOHN A', JSON.stringify({ document_number: 'DOC-1' })]);
  const res = await one(db, 'select process_raw_property_lead($1) as r', [id.id]);

  const needs = await all(db, 'select * from v_needs_address');
  assert.equal(needs.length, 1, 'it must be queued for an address lookup');
  const letters = await all(db, 'select * from v_letter_queue');
  assert.equal(letters.length, 0, 'it must not be mailed without an address');
  // shared database: leave it open for the next test
});

test('a lead with no contactable owner is not queued for a letter', async () => {
  const db = await freshDb();
  const id = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_trustee_sale', 'DOC-1',
    '111-222-03', '500 Oak Ave', 'Bakersfield', '93301', 'SMITH JOHN A',
    JSON.stringify({ document_number: 'DOC-1' })]);
  const res = await one(db, 'select process_raw_property_lead($1) as r', [id.id]);
  await db.query('update owners set do_not_contact = true where id in (select owner_id from property_owners where property_id = $1)', [res.r.property_id]);
  const letters = await all(db, 'select * from v_letter_queue');
  assert.equal(letters.length, 0, 'a do-not-contact owner must not be mailed');
  // shared database: leave it open for the next test
});

test('the score reflects urgency, equity and the 70% rule', async () => {
  const db = await freshDb();
  const id = await one(db, INSERT_INTAKE, ['kern_recorder', 'notice_of_trustee_sale', 'DOC-1',
    '111-222-03', '500 Oak Ave', 'Bakersfield', '93301', 'SMITH JOHN A',
    JSON.stringify({ document_number: 'DOC-1' })]);
  const res = await one(db, 'select process_raw_property_lead($1) as r', [id.id]);
  const pid = res.r.property_id;

  // ARV 400k, repairs 40k -> MAO 240k, against 200k of debt: 240k >= 200k * 1.10, so full exit points
  await db.query(`update properties set estimated_market_value = 400000, estimated_arv = 400000,
                         estimated_repair_cost = 40000, estimated_loan_balance = 200000,
                         owner_occupied = true, units = 1, condition_rating = 3 where id = $1`, [pid]);
  const out = await one(db, 'select recalculate_lead_score($1) as s', [pid]);
  assert.equal(out.s.lead_tier, 'A', 'a strong trustee-sale lead is Tier A');
  const s = await one(db, 'select * from lead_scores where property_id = $1', [pid]);
  // 35 for a trustee's sale notice, +5 because the estimated sale falls inside 30 days, capped at 40
  assert.equal(s.urgency_score, 40, 'an imminent trustee sale is worth the maximum 40 urgency points');
  assert.equal(s.equity_score, 25, '50%+ equity earns full equity points');
  assert.equal(s.exit_score, 15, 'MAO at least 10% above debt earns full exit points');
  assert.equal(s.total_score, 40 + 25 + 6 + 4 + 15, 'the total is the sum of the parts');
  assert.equal(s.lead_tier, 'A');
  // shared database: leave it open for the next test
});
