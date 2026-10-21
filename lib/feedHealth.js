// Feed health.
//
// The dashboard is only as good as the feed behind it. A feed that stops working is
// invisible: the pipeline just goes quiet, nobody notices, and the action list slowly
// empties out. The database records every run in `source_runs` -- it always has -- but
// nobody was looking at that table.
//
// This module turns those rows into one honest answer per source: is the last run good,
// and if not, what went wrong in words a person can act on.

import { sql } from './db.js';

// A raw "fetch failed" tells an operator nothing. Say what it almost always means.
const HINTS = [
  {
    match: /fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    what: 'the county site could not be reached from this server',
    why: 'The server has no outbound network access to it. Check the firewall, the proxy, or the allow-list.',
  },
  {
    match: /timeout|ETIMEDOUT|aborted/i,
    what: 'the county site did not answer in time',
    why: 'The site may be slow or refusing connections. It will be retried on the next scheduled run.',
  },
  {
    match: /certificate|SSL|TLS/i,
    what: 'the secure connection to the county site failed',
    why: 'The certificate did not validate. Check the system trust store and the clock.',
  },
  {
    match: /403|forbidden/i,
    what: 'the county site refused the request',
    why: 'It may be blocking the request or asking for a session the scraper does not have.',
  },
  {
    match: /no records|empty|parse|unexpected/i,
    what: 'the county site answered, but not in the format the collector reads',
    why: 'The page probably changed. The collector needs a look.',
  },
];

export function explainFeedError(error) {
  const raw = String(error || '').trim();
  if (!raw) return { what: 'the run failed without saying why', why: 'Check the collector logs.' };
  for (const h of HINTS) {
    if (h.match.test(raw)) return { what: h.what, why: h.why };
  }
  return { what: raw.length > 200 ? `${raw.slice(0, 200)}…` : raw, why: 'Check the collector logs.' };
}

/**
 * The last run of every source that has ever run, newest first per source.
 * Returns [] when nothing has run yet.
 */
export async function feedStatus({ db = sql } = {}) {
  const runs = await db`
    select distinct on (r.source_id)
           r.source_id, s.notes, r.status, r.error, r.started_at, r.finished_at, r.trigger,
           r.fetched, r.inserted, r.processed, r.matched, r.needs_match
      from source_runs r
      left join lead_sources s on s.id = r.source_id
     order by r.source_id, r.started_at desc`;
  return runs.map((r) => ({
    source_id: r.source_id,
    status: r.status,
    error: r.error,
    started_at: r.started_at,
    finished_at: r.finished_at,
    trigger: r.trigger,
    fetched: r.fetched,
    inserted: r.inserted,
    matched: r.matched,
    needs_match: r.needs_match,
    ok: r.status === 'ok',
    ...(r.status === 'error' ? { reason: explainFeedError(r.error) } : {}),
  }));
}

/**
 * The feeds that are currently broken, newest failure first.
 * This is what the dashboard banner shows.
 */
export async function brokenFeeds({ db = sql } = {}) {
  const all = await feedStatus({ db });
  return all.filter((f) => f.status === 'error');
}

/** True when a feed has never run at all -- which is also worth saying out loud. */
export async function feedsNeverRun({ db = sql } = {}) {
  const rows = await db`
    select s.id, s.notes
      from lead_sources s
     where s.active
       and not exists (select 1 from source_runs r where r.source_id = s.id)`;
  return rows;
}

/**
 * How much of what is on screen is sample data rather than real leads.
 *
 * `npm run db:seed:demo` marks everything it creates with data_confidence =
 * 'demo'. A dashboard that mixes sample leads with real ones without saying so
 * is worse than one with nothing on it: somebody mails a letter to a made-up
 * owner. So the count is shown, and the sample can be cleared in one click.
 */
export async function demoDataCount({ db = sql } = {}) {
  const [{ demo, total }] = await db`
    select count(*) filter (where data_confidence = 'demo')::int as demo,
           count(*)::int as total
      from properties`;
  return { demo, total, real: total - demo };
}
