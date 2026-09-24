import { parseKernResults, isEntity } from './kernRecorderParse';

// Kern County Recorder — public "Search by Document Class" index.
// Returns document number, recording date, class and party names. No APN/address.
const BASE = 'https://recorderonline.co.kern.ca.us';
const UA = 'HarbisonBuysHomes-LeadDesk/1.0 (public records index; low volume)';

export const KERN_CLASSES = [
  { code: '0043', desc: 'Default Notice', signal: 'notice_of_default' },
  { code: '0038', desc: "Notice of Trustee's Sale", signal: 'notice_of_trustee_sale' },
  { code: '0044', desc: 'Cancel Default Notice', signal: 'notice_of_rescission' },
];

const TRUSTEE_WORDS = /\b(RECON|RECONVEYANCE|TRUSTEE|FORECLOSURE|DEFAULT SERVICES|LENDER SOLUTIONS|SERVICES?)\b/i;
const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, ...(init.headers || {}) },
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Kern recorder HTTP ${res.status} for ${url.split('?')[0]}`);
  return res.text();
}

async function userKey() {
  const html = await get(`${BASE}/cgi-bin/Osearchc.mbr/input`);
  const m = html.match(/name="?USERKEY"?[^>]*?value="?([^"\s>]+)/i);
  if (!m) throw new Error('Kern recorder: search form changed (no USERKEY)');
  return m[1];
}

// People who owe on the property: grantors that are not trustee/servicer companies.
export function borrowersFrom(parties) {
  return parties
    .filter((p) => p.role === 'grantor')
    .map((p) => p.name)
    .filter((n) => !(isEntity(n) && /\bTR$/.test(n)) && !TRUSTEE_WORDS.test(n));
}

export async function fetchKernClass(cls, from, to, { maxPages = 60 } = {}) {
  const key = await userKey();
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
    html = await get(page.next);
    page = parseKernResults(html);
    rows.push(...page.rows);
    pages++;
  }
  // Guard against the site silently ignoring our filters
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = to.toISOString().slice(0, 10);
  return rows.filter((r) => r.descriptions.includes(cls.desc)
    && r.recorded_date && r.recorded_date >= fromIso && r.recorded_date <= toIso);
}

// -> raw_lead_intake records
export async function collectKern(from, to) {
  const out = [];
  for (const cls of KERN_CLASSES) {
    const rows = await fetchKernClass(cls, from, to);
    for (const r of rows) {
      const borrowers = borrowersFrom(r.parties);
      if (!borrowers.length) continue; // e.g. HOA/entity-only filings we can't act on
      out.push({
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
        raw_owner_name: borrowers[0],
        raw_payload: {
          document_number: r.document_number,
          recorded_date: r.recorded_date,
          document_classes: r.descriptions,
          borrowers,
          parties: r.parties,
        },
      });
    }
  }
  return out;
}
