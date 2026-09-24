import { parseKernResults, isEntity } from './kernRecorderParse';

// Kern County Recorder — public "Search by Document Class" index.
// Returns document number, recording date, class and party names. No APN/address.
export const BASE = 'https://recorderonline.co.kern.ca.us';
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

export async function get(url, init = {}) {
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

const notTrustee = (n) => !(isEntity(n) && /\bTR$/.test(n)) && !TRUSTEE_WORDS.test(n);
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
  const seen = new Set();
  for (const cls of KERN_CLASSES) {
    const rows = await fetchKernClass(cls, from, to);
    for (const r of rows) {
      if (seen.has(r.document_number)) continue; // one document can carry several classes
      const who = peopleFor(cls, r.parties);
      if (!who) continue;
      seen.add(r.document_number);
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
      });
    }
  }
  return out;
}
