// Tests for the feed-health module.
//
// The point of this module is that a broken feed is never silent. These cover the
// two things it has to get right: turning a raw error into something a person can
// act on, and reporting the truth about which feed is broken and which never ran.

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, one, all, pgliteClient } from './helpers/db.mjs';

const { explainFeedError, feedStatus, brokenFeeds, feedsNeverRun, demoDataCount } = await import('../lib/feedHealth.js');

// ---------------------------------------------------------------------------------------------
// Turning an error into words
// ---------------------------------------------------------------------------------------------

test('a network failure is explained in plain words, not "fetch failed"', () => {
  const r = explainFeedError('fetch failed');
  assert.match(r.what, /could not be reached/);
  assert.match(r.why, /network access|firewall|allow-list/i);
});

test('a DNS failure reads as a reachability problem too', () => {
  const r = explainFeedError('getaddrinfo ENOTFOUND recorderonline.co.kern.ca.us');
  assert.match(r.what, /could not be reached/);
});

test('a timeout says so', () => {
  const r = explainFeedError('The operation was aborted due to timeout');
  assert.match(r.what, /did not answer in time/);
});

test('a certificate problem is called out as such', () => {
  const r = explainFeedError('unable to verify the first certificate');
  assert.match(r.what, /secure connection/);
});

test('a parse failure is pointed at the collector, not the network', () => {
  const r = explainFeedError('unexpected token in page');
  assert.match(r.what, /format the collector reads/);
});

test('an unknown error is passed through rather than hidden', () => {
  const r = explainFeedError('the widgets were misaligned');
  assert.equal(r.what, 'the widgets were misaligned');
  assert.ok(r.why.length > 0);
});

test('an empty error still says something', () => {
  const r = explainFeedError('');
  assert.match(r.what, /without saying why/);
});

// ---------------------------------------------------------------------------------------------
// Reporting on the feeds
// ---------------------------------------------------------------------------------------------

test('a feed that failed is reported as broken, with the reason', async () => {
  const db = await freshDb();
  await one(db, `insert into source_runs (source_id, trigger, status, error, finished_at)
                 values ('kern_recorder','cron','error','fetch failed', now())`);

  const status = await feedStatus({ db: pgliteClient(db) });
  assert.equal(status.length, 1);
  assert.equal(status[0].source_id, 'kern_recorder');
  assert.equal(status[0].ok, false);
  assert.match(status[0].reason.what, /could not be reached/);

  const broken = await brokenFeeds({ db: pgliteClient(db) });
  assert.equal(broken.length, 1);
  assert.equal(broken[0].source_id, 'kern_recorder');
});

test('a feed that succeeded is not reported as broken', async () => {
  const db = await freshDb();
  await one(db, `insert into source_runs (source_id, trigger, status, fetched, inserted, finished_at)
                 values ('kern_recorder','cron','ok', 12, 3, now())`);

  const broken = await brokenFeeds({ db: pgliteClient(db) });
  assert.equal(broken.length, 0);

  const status = await feedStatus({ db: pgliteClient(db) });
  assert.equal(status[0].ok, true);
  assert.equal(status[0].fetched, 12);
  assert.equal(status[0].inserted, 3);
});

test('only the latest run of each source counts', async () => {
  const db = await freshDb();
  await one(db, `insert into source_runs (source_id, trigger, status, error, started_at, finished_at)
                 values ('kern_recorder','cron','error','fetch failed', now() - interval '2 days', now() - interval '2 days')`);
  await one(db, `insert into source_runs (source_id, trigger, status, started_at, finished_at)
                 values ('kern_recorder','cron','ok', now() - interval '1 hour', now() - interval '1 hour')`);

  const broken = await brokenFeeds({ db: pgliteClient(db) });
  assert.equal(broken.length, 0, 'the old failure was superseded by a good run');
});

test('a feed that has never run is said out loud', async () => {
  const db = await freshDb();
  const never = await feedsNeverRun({ db: pgliteClient(db) });
  assert.ok(never.length > 0, 'the seeded sources have never run');
  assert.ok(never.some((f) => f.id === 'kern_recorder'));

  await one(db, `insert into source_runs (source_id, trigger, status, finished_at)
                 values ('kern_recorder','cron','ok', now())`);
  const after = await feedsNeverRun({ db: pgliteClient(db) });
  assert.equal(after.filter((f) => f.id === 'kern_recorder').length, 0);
});

// ---------------------------------------------------------------------------------------------
// Saying out loud that the data on screen is a sample
// ---------------------------------------------------------------------------------------------

test('demo data is counted separately from real leads', async () => {
  const db = await freshDb();
  const demo = await one(db, `insert into properties (state, county, address_line_1, city, apn, data_confidence)
    values ('CA','Kern','1 DEMO ST','Bakersfield','dh-1','demo') returning id`);
  await one(db, `insert into properties (state, county, address_line_1, city, apn, data_confidence)
                 values ('CA','Kern','2 REAL ST','Bakersfield','dh-2','manual')`);

  const d = await demoDataCount({ db: pgliteClient(db) });
  assert.equal(d.demo, 1);
  assert.equal(d.total, 2);
  assert.equal(d.real, 1);
});

test('a database with no demo data says so plainly', async () => {
  const db = await freshDb();
  const d = await demoDataCount({ db: pgliteClient(db) });
  assert.equal(d.demo, 0);
  assert.equal(d.real, d.total);
});
