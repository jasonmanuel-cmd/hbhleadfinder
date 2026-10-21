// Tests for the enrichment worker and the provisional-equity scoring rule.
//
// The queue semantics live in SQL; these check that the worker actually consumes the
// queue, that failures back off instead of disappearing, and that the score can be
// built from the recorded owner history when no dollar figures exist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, one, all, pgliteClient } from './helpers/db.mjs';

const runEnrichment = (await import('../lib/enrichment/index.js')).runEnrichment;

const INSERT_PROPERTY = `insert into properties (state, county, address_line_1, city, apn)
  values ('CA','Kern','100 TEST ST','Bakersfield','123-456-09') returning id`;

async function aLead(db) {
  const p = await one(db, INSERT_PROPERTY);
  await one(db, `insert into distress_events (property_id, source_name, event_type, event_date, recorded_date)
                 values ($1,'test','notice_of_trustee_sale',current_date,current_date)`, [p.id]);
  const o = await one(db, `insert into owners (full_name) values ('J DOE') returning id`);
  await one(db, `insert into property_owners (property_id, owner_id, ownership_role, is_decision_maker)
                 values ($1,$2,'owner',true)`, [p.id, o.id]);
  return p;
}

// ---------------------------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------------------------

test('the worker claims a queued job, writes the values and completes it', async () => {
  const db = await freshDb();
  const p = await aLead(db);
  await one(db, `insert into enrichment_jobs (property_id, enrichment_type, provider, priority)
                 values ($1,'valuation','fake',90)`, [p.id]);

  const stats = await runEnrichment({
    types: ['valuation'], limit: 5, db: pgliteClient(db),
    providers: { fake: async () => ({ estimated_market_value: 400000, estimated_loan_balance: 200000 }) },
  });

  assert.equal(stats.claimed, 1);
  assert.equal(stats.completed, 1);
  assert.equal(stats.failed, 0);

  const prop = await one(db, `select estimated_market_value, estimated_loan_balance from properties where id = $1`, [p.id]);
  assert.equal(Number(prop.estimated_market_value), 400000);
  assert.equal(Number(prop.estimated_loan_balance), 200000);

  const job = await one(db, `select status, attempts, last_error from enrichment_jobs where property_id = $1`, [p.id]);
  assert.equal(job.status, 'completed');
  assert.equal(job.attempts, 1);
  assert.equal(job.last_error, null);
});

test('the provider is chosen by job type when the job names no provider', async () => {
  // The claimed row used to come back without its enrichment_type, so the worker
  // could not tell which provider to use and skipped every job. The type the
  // worker asked for is enough on its own.
  const db = await freshDb();
  const p = await aLead(db);
  await one(db, `insert into enrichment_jobs (property_id, enrichment_type, priority)
                 values ($1,'valuation',90)`, [p.id]);

  let called = 0;
  const stats = await runEnrichment({
    types: ['valuation'], limit: 5, db: pgliteClient(db),
    providers: { assessor: async () => { called++; return { assessed_value: 300000 }; } },
  });

  assert.equal(called, 1, 'the type default provider was used');
  assert.equal(stats.completed, 1);
  const prop = await one(db, `select assessed_value from properties where id = $1`, [p.id]);
  assert.equal(Number(prop.assessed_value), 300000);
});

test('a finished job re-scores the property', async () => {
  const db = await freshDb();
  const p = await aLead(db);
  await one(db, `insert into enrichment_jobs (property_id, enrichment_type, provider)
                 values ($1,'valuation','fake')`, [p.id]);

  await runEnrichment({
    types: ['valuation'], limit: 5, db: pgliteClient(db),
    providers: { fake: async () => ({ estimated_market_value: 400000, estimated_loan_balance: 200000 }) },
  });

  const score = await one(db, `select equity_score, total_score, lead_tier, equity_provisional
                               from lead_scores where property_id = $1`, [p.id]);
  assert.equal(score.equity_score, 25, 'a known 50% equity scores the full 25');
  // urgency 40 (a trustee's sale with an imminent sale date) + equity 25 + authority 10
  assert.equal(score.total_score, 75);
  assert.equal(score.lead_tier, 'A');
  assert.equal(score.equity_provisional, false, 'a real valuation is not provisional');
});

test('a provider that throws backs the job off instead of losing it', async () => {
  const db = await freshDb();
  const p = await aLead(db);
  await one(db, `insert into enrichment_jobs (property_id, enrichment_type, provider)
                 values ($1,'valuation','fake')`, [p.id]);

  const stats = await runEnrichment({
    types: ['valuation'], limit: 5, db: pgliteClient(db),
    providers: { fake: async () => { throw new Error('the provider is down'); } },
  });

  assert.equal(stats.failed, 1);
  const job = await one(db, `select status, attempts, last_error, available_at from enrichment_jobs where property_id = $1`, [p.id]);
  assert.equal(job.status, 'queued', 'a failed job goes back in the queue');
  assert.equal(job.attempts, 1);
  assert.match(job.last_error, /the provider is down/);
  assert.ok(new Date(job.available_at) > new Date(), 'it waits before being retried');
});

test('a provider that has nothing to offer parks the job rather than failing it', async () => {
  const db = await freshDb();
  const p = await aLead(db);
  await one(db, `insert into enrichment_jobs (property_id, enrichment_type, provider)
                 values ($1,'valuation','fake')`, [p.id]);

  const stats = await runEnrichment({
    types: ['valuation'], limit: 5, db: pgliteClient(db),
    providers: { fake: async () => ({ skipped: 'the county has no record' }) },
  });

  assert.equal(stats.skipped, 1);
  assert.equal(stats.failed, 0);
  const job = await one(db, `select status, last_error from enrichment_jobs where property_id = $1`, [p.id]);
  assert.equal(job.status, 'skipped');
  assert.match(job.last_error, /no record/);
});

test('a job with no provider at all is skipped, not failed', async () => {
  const db = await freshDb();
  const p = await aLead(db);
  await one(db, `insert into enrichment_jobs (property_id, enrichment_type, provider)
                 values ($1,'mortgage','nobody')`, [p.id]);

  const stats = await runEnrichment({
    types: ['mortgage'], limit: 5, db: pgliteClient(db), providers: {},
  });

  assert.equal(stats.skipped, 1);
  assert.equal(stats.failed, 0);
  const job = await one(db, `select status, attempts, last_error from enrichment_jobs where property_id = $1`, [p.id]);
  assert.equal(job.status, 'skipped');
  assert.match(job.last_error, /No provider is configured/);
  // It is parked, not queued for another go: the job is not going to succeed on a
  // retry, so it must not keep eating its attempts.
  assert.notEqual(job.status, 'queued');
});

test('a provider cannot write columns it is not allowed to', async () => {
  const db = await freshDb();
  const p = await aLead(db);
  await one(db, `insert into enrichment_jobs (property_id, enrichment_type, provider)
                 values ($1,'valuation','fake')`, [p.id]);

  await runEnrichment({
    types: ['valuation'], limit: 5, db: pgliteClient(db),
    providers: { fake: async () => ({ id: '00000000-0000-0000-0000-000000000000', state: 'TX', estimated_market_value: 300000 }) },
  });

  const prop = await one(db, `select id, state, estimated_market_value from properties where id = $1`, [p.id]);
  assert.equal(prop.state, 'CA', 'the provider must not be able to move the property to another state');
  assert.notEqual(prop.id, '00000000-0000-0000-0000-000000000000');
  assert.equal(Number(prop.estimated_market_value), 300000, 'but it can set a value');
});

test('a job whose worker died is put back in the queue', async () => {
  const db = await freshDb();
  const p = await aLead(db);
  await one(db, `insert into enrichment_jobs (property_id, enrichment_type, provider, status, locked_at, locked_by)
                 values ($1,'valuation','fake','processing', now() - interval '40 minutes','dead-worker')`, [p.id]);

  const stats = await runEnrichment({
    types: ['valuation'], limit: 5, db: pgliteClient(db),
    providers: { fake: async () => ({ estimated_market_value: 1 }) },
  });

  assert.ok(stats.released >= 1, 'the stale lock was released');
  const job = await one(db, `select status, locked_by, available_at from enrichment_jobs where property_id = $1`, [p.id]);
  assert.equal(job.status, 'queued', 'the job is back in the queue');
  assert.equal(job.locked_by, null, 'nobody is holding it');
  assert.ok(new Date(job.available_at) > new Date(), 'and it waits a quarter of an hour before being retried');
  assert.equal(stats.completed, 0, 'so it is not picked up again in the same run');
});

// ---------------------------------------------------------------------------------------------
// Provisional equity
// ---------------------------------------------------------------------------------------------

async function leadWithHistory(db, hint, { truncated = false } = {}) {
  const p = await aLead(db);
  const i = await one(db, `insert into raw_lead_intake
    (source_name, source_type, source_record_id, raw_state, raw_county, property_id)
    values ('kern_recorder','notice_of_trustee_sale','DOC-1','CA','Kern',$1) returning id`, [p.id]);
  await one(db, `insert into borrower_dossiers (intake_id, names, signals, priority, truncated)
                 values ($1, array['J DOE'], $2::jsonb, 80, $3)`, [i.id, JSON.stringify({ equity_hint: hint }), truncated]);
  await one(db, `select recalculate_lead_score($1)`, [p.id]);
  return p;
}

test('the recorded owner history counts for equity when there are no dollar figures', async () => {
  const db = await freshDb();
  const p = await leadWithHistory(db, 'high');
  const s = await one(db, `select equity_score, equity_provisional, score_reasoning->>'equity_source' src,
                                  score_reasoning->>'equity_hint' hint, total_score, lead_tier
                             from lead_scores where property_id = $1`, [p.id]);
  assert.equal(s.equity_score, 20, 'a high equity hint counts 20 of the 25 equity points');
  assert.equal(s.equity_provisional, true);
  assert.equal(s.src, 'recorded_history');
  assert.equal(s.hint, 'high');
  // urgency 40 + equity 20 (provisional) + authority 10
  assert.equal(s.total_score, 70);
  assert.equal(s.lead_tier, 'A', 'a lead off the feed with strong recorded equity can now reach Tier A');
});

test('a moderate equity hint counts less, and a thin one counts nothing', async () => {
  const db = await freshDb();
  const p = await leadWithHistory(db, 'moderate');
  const s = await one(db, `select equity_score from lead_scores where property_id = $1`, [p.id]);
  assert.equal(s.equity_score, 10);

  const db2 = await freshDb();
  const p2 = await leadWithHistory(db2, 'thin');
  const s2 = await one(db2, `select equity_score from lead_scores where property_id = $1`, [p2.id]);
  assert.equal(s2.equity_score, 0);
});

test('an unverified or truncated history never counts', async () => {
  const db = await freshDb();
  // unverified: a common name, so the documents may be another person's
  const p = await leadWithHistory(db, 'unverified');
  let s = await one(db, `select equity_score from lead_scores where property_id = $1`, [p.id]);
  assert.equal(s.equity_score, 0);

  const db2 = await freshDb();
  // truncated: the history was cut short, so it is not the whole story
  const p2 = await leadWithHistory(db2, 'high', { truncated: true });
  s = await one(db2, `select equity_score from lead_scores where property_id = $1`, [p2.id]);
  assert.equal(s.equity_score, 0);
});

test('a real valuation replaces the provisional equity', async () => {
  const db = await freshDb();
  const p = await leadWithHistory(db, 'high');
  await one(db, `update properties set estimated_market_value = 400000, estimated_loan_balance = 200000 where id = $1`, [p.id]);
  await one(db, `select recalculate_lead_score($1)`, [p.id]);
  const s = await one(db, `select equity_score, equity_provisional, score_reasoning->>'equity_source' src, lead_tier
                           from lead_scores where property_id = $1`, [p.id]);
  assert.equal(s.equity_score, 25, 'the dollar figure wins');
  assert.equal(s.equity_provisional, false);
  assert.equal(s.src, 'underwritten');
  assert.equal(s.lead_tier, 'A');
});

test('a lead with nothing to go on still scores, and is not provisional', async () => {
  const db = await freshDb();
  const p = await aLead(db);
  await one(db, `select recalculate_lead_score($1)`, [p.id]);
  const s = await one(db, `select equity_score, equity_provisional, score_reasoning->>'equity_source' src
                           from lead_scores where property_id = $1`, [p.id]);
  assert.equal(s.equity_score, 0);
  assert.equal(s.equity_provisional, false, 'no history and no valuation is not "provisional", it is unknown');
  assert.equal(s.src, 'unknown');
});
