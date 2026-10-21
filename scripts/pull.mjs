#!/usr/bin/env node
// Pull the county feed from the command line.
//
//   npm run pull                 # the last 10 days, into the database
//   npm run pull -- --days 30   # a wider window
//   npm run pull -- --check     # do not write anything: just see if the feed works
//
// The dashboard has a "Pull now" button, but a button is no good in a cron job,
// a shell script, or your own head. This is the same code path, with a report.
//
// Exit codes: 0 = the feed worked (or partially worked), 1 = it did not.

import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const days = Math.min(60, Math.max(1, Number(opt('days')) || 10));
const check = args.includes('--check');
const file = opt('file');
const url = opt('url') || process.env.DATABASE_URL;
if (!check && !file && !url) {
  console.error('No DATABASE_URL. Set it, or pass --url <connection string>.');
  process.exit(1);
}

// The check path needs nothing from the app (which uses Next's "@/" alias and so
// cannot be imported by plain Node). The pull path does, so it is imported late.
const { explainFeedError } = await import('../lib/feedHealth.js');
const { BASE } = await import('../lib/collectors/kernRecorder.js');

const say = (s = '') => console.log(s);

say(`Kern recorder — ${BASE}`);
say(check ? 'Checking the feed (nothing will be written)…' : `Pulling the last ${days} day(s)…`);
say();

const to = new Date();
const from = new Date(to.getTime() - days * 86400000);

if (file) {
  // A saved county results page, brought in by hand. Same parser, same rules.
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(file, 'utf8');
  const { ingestKernHtml } = await import('../lib/ingest.js');
  try {
    const s = await ingestKernHtml(html, { trigger: 'manual', lookbackDays: days });
    say(`Read       ${s.fetched} filing(s) from ${file}`);
    say(`New        ${s.inserted} not seen before`);
    say(`Scored     ${s.processed} processed, ${s.matched} attached to a property you already track`);
    say(`To review  ${s.needs_match} could not be matched to a parcel`);
    if (s.skipped) say(`Skipped    ${s.skipped} filing(s) in a document class this app does not know`);
    say();
    say('Open the dashboard to work them: npm run dev:local');
    process.exit(0);
  } catch (e) {
    say();
    say(`That page could not be read: ${e.message}`);
    process.exit(1);
  }
}

if (check) {
  // No database, no writes: just prove the site answers and that the parser still
  // understands what it says. This is the canary -- run it when the pipeline goes
  // quiet and it will tell you whether the county changed its pages or you have
  // simply had no filings.
  const { fetchKernClass, KERN_CLASSES } = await import('../lib/collectors/kernRecorder.js');
  let total = 0;
  let failed = 0;
  for (const cls of KERN_CLASSES) {
    if (cls.kind !== 'lead') continue;
    try {
      const rows = await fetchKernClass(cls, from, to);
      total += rows.length;
      say(`  ${cls.code} ${cls.desc.padEnd(28)} ${String(rows.length).padStart(4)} filing(s)`);
    } catch (e) {
      failed++;
      say(`  ${cls.code} ${cls.desc.padEnd(28)} FAILED — ${e.message}`);
    }
  }
  say();
  if (failed === KERN_CLASSES.filter((c) => c.kind === 'lead').length) {
    say('The feed is not working at all. Nothing above parsed.');
    process.exit(1);
  }
  say(`${total} filing(s) in the last ${days} day(s). ${failed} class(es) failed.`);
  process.exit(failed ? 1 : 0);
}

try {
  const { runCollector } = await import('../lib/ingest.js');
  const s = await runCollector('kern_recorder', { trigger: 'manual', lookbackDays: days });
  say(`Fetched    ${s.fetched} filing(s) from the county`);
  say(`New        ${s.inserted} not seen before`);
  say(`Scored     ${s.processed} processed, ${s.matched} attached to a property you already track`);
  say(`To review  ${s.needs_match} could not be matched to a parcel`);
  say(`Histories  ${s.histories} owner histories built (${s.histories_remaining} still waiting)`);
  say(`Tax list   ${s.taxMatched} matched on the delinquent-tax list, ${s.skipped} dead filings skipped`);
  say(`Addresses  ${s.addresses} street addresses filled (${s.addresses_remaining} to go)`);
  say();
  say('Open the dashboard to work them: npm run dev:local');
  process.exit(0);
} catch (e) {
  const r = explainFeedError(e.message);
  say();
  say(`The pull failed: ${r.what}`);
  say(r.why);
  if (!/fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo|timeout|ETIMEDOUT/i.test(e.message)) {
    say();
    say(`Details: ${e.message}`);
  }
  process.exit(1);
}
