import { parseKernResults, isEntity, matchesClass } from './kernRecorderParse.js';

// Kern County Recorder — public "Search by Document Class" index.
// Returns document number, recording date, class and party names. No APN/address.
export const BASE = process.env.KERN_RECORDER_BASE_URL || 'https://recorderonline.co.kern.ca.us';
const UA = 'HarbisonBuysHomes-LeadDesk/1.0 (public records index; low volume)';

// kind: 'lead'   -> creates a lead (or waits for a parcel match)
//       'attach' -> only annotates a property we already track; otherwise ignored
export const KERN_CLASSES = [
  { code: '0043', desc: 'Default Notice', signal: 'notice_of_default', kind: 'lead', people: 'borrowers' },
  { code: '0038', desc: "Notice of Trustee's Sale", signal: 'notice_of_trustee_sale', kind: 'lead', people: 'borrowers' },
  { code: '0044', desc: 'Cancel Default Notice', signal: 'notice_of_rescission', kind: 'attach', people: 'borrowers' },
  { code: '0703', desc: 'Affidavit - TOD', signal: 'tod_affidavit', kind: 'lead', people: 'death' },
  { code: '0028', desc: 'Affidavit - Joint Tenants', signal: 'death_joint_tenant', kind: 'lead', people: 'death' },
  { code: '0184', desc: 'Letters Testamentary', signal: 'letters_testamentary', kind: 'lead', people: 'estate' },
  { code: '0183', desc: 'Letters of Administration', signal: 'letters_testamentary', kind: 'lead', people: 'estate' },
  { code: '0061', desc: 'Tax Lien - State Notice', signal: 'tax_lien', kind: 'attach', people: 'debtor' },
  { code: '0060', desc: 'Tax Lien - Federal', signal: 'tax_lien', kind: 'attach', people: 'debtor' },
  { code: '0059', desc: 'Tax Lien - County', signal: 'tax_lien', kind: 'attach', people: 'debtor' },
  { code: '0040', desc: 'Abstract Judgment', signal: 'judgment_lien', kind: 'attach', people: 'debtor' },
];

const TRUSTEE_WORDS = /\b(RECON|RECONVEYANCE|TRUSTEE|FORECLOSURE|DEFAULT SERVICES|LENDER SOLUTIONS|SERVICES?)\b/i;
const DECEASED = /\s+(DECD|DEC'D|DECEASED)$/i;
const ESTATE = /\s+(EST|ESTATE)$/i;
const FIDUCIARY = /\s+(EXTR|EXTX|EXEC|EXECUTOR|EXECUTRIX|ADMR|ADMX|ADMINISTRATOR|ADMINISTRATRIX|PERS REP|PR)$/i;
const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The county's search needs the session it hands out on the form page. Node's fetch
// keeps no cookies between calls, so a session that is set on one request is lost
// on the next -- and the search then comes back empty. Keep the ones that matter.
const jar = new Map();

function rememberCookies(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

export async function get(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': UA,
      ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
      ...(init.headers || {}),
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });
  rememberCookies(res);
  if (!res.ok) throw new Error(`Kern recorder HTTP ${res.status} for ${url.split('?')[0]}`);
  return res.text();
}

// The search key and the session are the same for the whole run. Fetching the form
// once per document class meant eleven extra requests to the county for nothing.
let session = null;

async function userKey() {
  if (session) return session;
  const html = await get(`${BASE}/cgi-bin/Osearchc.mbr/input`);
  const m = html.match(/name="?USERKEY"?[^>]*?value="?([^"\s>]+)/i);
  if (!m) throw new Error(
    'Kern recorder: the search form changed and no longer carries a USERKEY. '
    + 'The county site has probably been redesigned and the collector needs updating.');
  session = { key: m[1] };
  return session;
}

/** The county hands out relative links on the results pages. Resolve them. */
function absolute(url) {
  try {
    return new URL(url, BASE).toString();
  } catch {
    return url;
  }
}

// A borrower is a person. Drop lenders, servicers and trustees: on some documents the
// servicer is indexed as grantor, and a bank must never become the owner we call.
const notTrustee = (n) => !isEntity(n) && !/\bTR$/.test(n) && !TRUSTEE_WORDS.test(n);
const person = (name, role, decision_maker = false) => ({ name, role, decision_maker });

// People who owe on the property. NOD/NTS index them as grantors; cancellations index the
// borrower as grantee, so fall back to grantees when no usable grantor is listed.
export function borrowersFrom(parties) {
  const grantors = parties.filter((p) => p.role === 'grantor').map((p) => p.name).filter(notTrustee);
  if (grantors.length) return grantors;
  return parties.filter((p) => p.role === 'grantee').map((p) => p.name).filter((n) => notTrustee(n) && !isEntity(n));
}

// -> { people: [{name, role, decision_maker}], contact, historyNames } or null when not actionable
export function peopleFor(cls, parties) {
  if (cls.people === 'borrowers') {
    const b = borrowersFrom(parties);
    if (!b.length) return null;
    return { people: b.map((n) => person(n, 'owner')), contact: b[0], historyNames: b.slice(0, 2) };
  }
  if (cls.people === 'death') {
    // Decedent is marked "DECD"; the grantee is the surviving joint tenant / TOD beneficiary.
    const decedents = parties.filter((p) => DECEASED.test(p.name)).map((p) => p.name.replace(DECEASED, '').trim());
    if (!decedents.length) return null; // e.g. TOD deed re-recordings without a death
    const heirs = parties.filter((p) => p.role === 'grantee' && !DECEASED.test(p.name) && !isEntity(p.name)).map((p) => p.name);
    const role = cls.signal === 'tod_affidavit' ? 'heir' : 'owner';
    return {
      people: [...decedents.map((n) => person(n, 'decedent')), ...heirs.map((n) => person(n, role, true))],
      contact: heirs[0] || decedents[0],
      historyNames: decedents.slice(0, 2),
    };
  }
  if (cls.people === 'estate') {
    const est = parties.filter((p) => ESTATE.test(p.name)).map((p) => p.name.replace(ESTATE, '').trim());
    const reps = parties.filter((p) => FIDUCIARY.test(p.name)).map((p) => p.name.replace(FIDUCIARY, '').trim());
    if (!est.length && !reps.length) return null;
    return {
      people: [...est.map((n) => person(n, 'decedent')), ...reps.map((n) => person(n, 'executor', true))],
      contact: reps[0] || est[0],
      historyNames: est.slice(0, 2),
    };
  }
  if (cls.people === 'debtor') {
    const d = parties.filter((p) => p.role === 'grantor' && !isEntity(p.name)).map((p) => p.name);
    if (!d.length) return null; // business liens are noise here
    return { people: d.map((n) => person(n, 'owner')), contact: d[0], historyNames: [] };
  }
  return null;
}

// The rows of one results page that belong to one document class.
//
// Shared by the live collector and by the file importer, so a page brought in by
// hand is filtered by exactly the same rules as one fetched by the bot. If the
// county's wording changes, both paths break the same way -- which is the point.
export function classRows(rows, cls, from, to) {
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = to.toISOString().slice(0, 10);
  return rows.filter((r) => matchesClass(r.descriptions, cls.desc)
    && r.recorded_date && r.recorded_date >= fromIso && r.recorded_date <= toIso);
}

/** Which document class is this page? Matched on the wording, not the code. */
export function detectClass(descriptions) {
  return KERN_CLASSES.find((c) => matchesClass(descriptions, c.desc)) || null;
}

export async function fetchKernClass(cls, from, to, { maxPages = 60 } = {}) {
  const { key } = await userKey();
  const body = new URLSearchParams({
    Order: 'N', Official: 'N', Birth: 'N', Marriage: 'N', Death: 'N', Session: 'XXXXXXXXXXXXXNNNNNNN',
    Maps: 'N', Fbn: 'N',
    F_Month: pad(from.getUTCMonth() + 1), F_Day: pad(from.getUTCDate()), F_Year: String(from.getUTCFullYear()),
    T_Month: pad(to.getUTCMonth() + 1), T_Day: pad(to.getUTCDate()), T_Year: String(to.getUTCFullYear()),
    Class: cls.code, Class_Desc: cls.desc, TYPE: '', B1: 'Search', NEWWIN: '',
  });
  let html = await get(`${BASE}/cgi-bin/oresultc02.mbr/Datedetail?USERKEY=${key}`, {
    method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const rows = [];
  let page = parseKernResults(html);
  rows.push(...page.rows);
  let pages = 1;
  while (page.next && pages < maxPages) {
    await sleep(300); // be polite to the county server
    html = await get(absolute(page.next));
    page = parseKernResults(html);
    rows.push(...page.rows);
    pages++;
  }

  const kept = classRows(rows, cls, from, to);

  // If the page had rows and none of them are the class we asked for, the site
  // changed its wording or the parser broke. Returning nothing here would be a
  // silent empty pipeline: the dashboard would just quietly stop filling.
  if (!kept.length && rows.length) {
    const seen = [...new Set(rows.flatMap((r) => r.descriptions))].slice(0, 4).join(' | ');
    throw new Error(
      `Kern recorder: the page returned ${rows.length} row(s) for class ${cls.code} "${cls.desc}" `
      + `but none matched it, so they were all dropped. The county's wording is probably `
      + `different now — the page said: ${seen || '(no descriptions found)'}`);
  }
  return kept;
}

// One county document -> one raw_lead_intake record
function recordFor(cls, r) {
  const who = peopleFor(cls, r.parties);
  if (!who) return null;
  return {
    source_name: 'kern_recorder',
    source_type: cls.signal,
    source_record_id: r.document_number,
    source_url: `${BASE}/cgi-bin/Osearchc.mbr/input`,
    event_date: r.recorded_date,
    raw_state: 'CA',
    raw_county: 'Kern',
    raw_apn: null,
    raw_address: null,
    raw_city: null,
    raw_zip: null,
    raw_owner_name: who.contact,
    raw_payload: {
      document_number: r.document_number,
      recorded_date: r.recorded_date,
      document_classes: r.descriptions,
      class_code: cls.code,
      kind: cls.kind,
      people: who.people,
      borrowers: who.people.filter((p) => p.role !== 'decedent').map((p) => p.name),
      history_names: who.historyNames,
      parties: r.parties,
    },
  };
}

// -> raw_lead_intake records
export async function collectKern(from, to) {
  const out = [];
  const seen = new Set();
  const problems = [];
  for (const cls of KERN_CLASSES) {
    let rows;
    try {
      rows = await fetchKernClass(cls, from, to);
    } catch (e) {
      // One class going wrong must not throw away the other ten. Remember it and
      // carry on; the run is reported as a partial one at the end.
      problems.push(`${cls.code} ${cls.desc}: ${e.message}`);
      continue;
    }
    for (const r of rows) {
      if (seen.has(r.document_number)) continue; // one document can carry several classes
      const rec = recordFor(cls, r);
      if (!rec) continue;
      seen.add(r.document_number);
      out.push(rec);
    }
  }
  // If every class failed, the run is a failure and must say so. If some worked,
  // the data is good and the broken classes are reported alongside it.
  if (problems.length === KERN_CLASSES.length) {
    throw new Error(`Kern recorder: every document class failed. ${problems[0]}`);
  }
  if (problems.length) {
    out.problems = problems; // the caller decides how loudly to complain
  }
  return out;
}

/**
 * Read a saved county results page and turn it into records.
 *
 * Sometimes the machine running the app cannot reach the county site -- behind a
 * firewall, on a laptop with no internet at that moment, in a sandbox with a
 * locked-down egress. The page is public, so the person using the app can open
 * it in their own browser, save it, and hand it over. It goes through exactly
 * the same parser and the same class rules as the live feed, so it is the same
 * data -- it just arrived by a different road.
 */
export function kernRecordsFromHtml(html, { from, to } = {}) {
  const { rows } = parseKernResults(html);
  if (!rows.length) {
    throw new Error(
      'No filings were found on that page. Save the county\'s *results* page (the one with '
      + 'the list of documents), not the search form, and make sure it is saved as HTML.');
  }
  const out = [];
  const seen = new Set();
  const skipped = [];
  for (const r of rows) {
    const cls = detectClass(r.descriptions);
    if (!cls) {
      skipped.push(`${r.document_number} (${r.descriptions.join(' / ') || 'no description'})`);
      continue;
    }
    if (seen.has(r.document_number)) continue;
    const rec = recordFor(cls, r);
    if (!rec) continue;
    seen.add(r.document_number);
    out.push(rec);
  }
  if (!out.length) {
    throw new Error(
      `That page has ${rows.length} filing(s) but none of them are a document class this app `
      + `knows about. The county's wording may have changed. ${skipped.slice(0, 3).join('; ')}`);
  }
  out.skipped = skipped;
  return out;
}
