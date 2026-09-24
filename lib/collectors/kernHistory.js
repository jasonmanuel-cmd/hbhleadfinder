import { parseKernResults } from './kernRecorderParse';
import { BASE, get } from './kernRecorder';

// Recorded-document history for a person, from the county's free grantor/grantee index.
// Turns a name-only filing into loan age, open loans, prior defaults, solar/tax/judgment liens,
// deaths and transfers — enough to decide which filings deserve a human's time.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
const years = (a, b) => (a && b ? (new Date(b) - new Date(a)) / (365.25 * 86400000) : null);

const SOLAR = /\b(TESLA|SOLARCITY|SUNRUN|VIVINT SOLAR|SUNNOVA|SUNPOWER|GOODLEAP|LOANPAL|MOSAIC|DIVIDEND|SUNLIGHT FIN|EVERBRIGHT|SUNSTRONG|FREEDOM FOREVER|SUNGEVITY|SOLAR)\b/i;

export async function fetchNameHistory(name, { maxPages = 6, to = new Date() } = {}) {
  const t = to;
  const url = `${BASE}/cgi-bin/oresultg01.MBR/docdetail?&Official=N&Birth=N&Death=N&Marriage=N&Maps=N&Fbn=N&V_Date=&TYPE=B`
    + `&oresultg_name=${encodeURIComponent(name)}&USERKEY=&F_Month=00&F_Day=00&F_Year=0000`
    + `&T_Month=${String(t.getUTCMonth() + 1).padStart(2, '0')}&T_Day=${String(t.getUTCDate()).padStart(2, '0')}&T_Year=${t.getUTCFullYear()}`;
  let page = parseKernResults(await get(url));
  const rows = [...page.rows];
  let pages = 1;
  while (page.next && pages < maxPages) {
    await sleep(250);
    page = parseKernResults(await get(page.next));
    rows.push(...page.rows);
    pages++;
  }
  return { rows, truncated: Boolean(page.next) };
}

const has = (r, re) => r.descriptions.some((d) => re.test(d));
const roleOf = (r, names) => {
  const p = r.parties.find((x) => names.has(key(x.name.replace(/\s+(DECD|EST|TR|EXTR|ADMR)$/i, ''))));
  return p ? p.role : null;
};

// filing: { signal, date, document_number }
export function buildDossier(filing, names, rows, truncated) {
  const nameSet = new Set(names.map(key));
  const byDoc = new Map();
  for (const r of rows) if (!byDoc.has(r.document_number)) byDoc.set(r.document_number, r);
  const docs = [...byDoc.values()].sort((a, b) => (a.recorded_date < b.recorded_date ? 1 : -1));
  const fdate = filing.date;
  const before = (r) => r.recorded_date < fdate;
  const after = (r) => r.recorded_date > fdate;

  const dots = docs.filter((r) => has(r, /Deed of Trust|Trust Deed/i) && !has(r, /Assignment|Substitution|Reconvey|Modif|Amend|Correct/i)
    && roleOf(r, nameSet) === 'grantor');
  const recons = docs.filter((r) => has(r, /Reconveyance/i));
  const mods = docs.filter((r) => has(r, /Modification of Deed of Trust|Mod Trust Deed|Mod & Supplement/i));
  const buys = docs.filter((r) => has(r, /^(Deed|Grant Deed|Deed - (Grant|Interspousal|Quitclaim)|Deed - Transfer on Death)/i)
    && !has(r, /Trust|Trustee|Tax/i) && roleOf(r, nameSet) === 'grantee');
  const sells = docs.filter((r) => has(r, /^(Deed|Grant Deed|Deed - (Grant|Quitclaim))/i) && !has(r, /Trust|Trustee/i)
    && roleOf(r, nameSet) === 'grantor');
  const nods = docs.filter((r) => has(r, /^Default Notice$/i));
  const cancels = docs.filter((r) => has(r, /Cancel Default Notice/i));
  const trusteeDeeds = docs.filter((r) => has(r, /Trustee\/Foreclosure Deed/i));
  const liens = docs.filter((r) => has(r, /Tax Lien|Abstract Judgment|^Judgment$|^Lien$|Notice of Lien|Lien - County/i));
  const releases = docs.filter((r) => has(r, /Release|Withdrawal|Discharge|Satisfaction/i) && has(r, /Lien|Judgment/i));
  const solar = docs.some((r) => has(r, /UCC/i) && r.parties.some((p) => SOLAR.test(p.name)))
    || docs.some((r) => r.parties.some((p) => SOLAR.test(p.name) && p.role === 'grantee'));
  const deceased = docs.some((r) => has(r, /Affidavit - Joint Tenants|Affidavit - TOD|Letters|Death/i)
    && r.parties.some((p) => /\b(DECD|EST)$/.test(p.name) && nameSet.has(key(p.name.replace(/\s+(DECD|EST)$/, '')))));

  const latestDot = dots[0]?.recorded_date || null;
  const lastBuy = buys.filter(before)[0]?.recorded_date || null;
  const loanAge = years(latestDot, fdate);
  const ownedYears = years(lastBuy, fdate);
  const openLoans = Math.max(0, dots.length - recons.length);
  const openLiens = Math.max(0, liens.length - releases.length);
  // An earlier default episode = a default notice recorded more than a year before this filing
  // (a trustee's sale notice normally follows its own default notice by 3-12 months).
  const yearBefore = new Date(new Date(fdate).getTime() - 365 * 86400000).toISOString().slice(0, 10);
  const priorDefaults = nods.filter((r) => r.document_number !== filing.document_number && r.recorded_date < yearBefore).length;
  const foreclosed = trusteeDeeds.some((r) => r.recorded_date >= fdate);
  const transferredOut = sells.some(after);

  let equityHint = 'unknown';
  if (openLoans === 0 && dots.length > 0) equityHint = 'high';            // every recorded loan was paid off
  else if (ownedYears != null && ownedYears >= 15 && (loanAge == null || loanAge >= 10)) equityHint = 'high';
  else if (ownedYears != null && ownedYears >= 8 && loanAge != null && loanAge >= 5) equityHint = 'moderate';
  else if (ownedYears != null && ownedYears >= 10 && openLoans <= 1) equityHint = 'moderate';   // long hold, one loan
  if ((loanAge != null && loanAge < 3 && (ownedYears == null || ownedYears < 5)) || openLoans >= 3) equityHint = 'thin';

  const base = { notice_of_trustee_sale: 40, notice_of_default: 30, tod_affidavit: 35, letters_testamentary: 35,
    death_joint_tenant: 20 }[filing.signal] ?? 20;
  let priority = base
    + ({ high: 25, moderate: 12, thin: -10 }[equityHint] || 0)
    + (priorDefaults > 0 ? 5 : 0)
    + (ownedYears != null && ownedYears >= 10 ? 5 : 0)
    + (openLiens > 0 ? 5 : 0)
    - (solar ? 5 : 0);
  if (foreclosed || transferredOut) priority = 0;
  priority = Math.max(0, Math.min(100, priority));

  const summary = [];
  if (foreclosed) summary.push('Foreclosure deed already recorded — likely lost');
  if (transferredOut) summary.push('Owner deeded property away after filing');
  if (lastBuy) summary.push(`Owned since ${lastBuy.slice(0, 4)}${ownedYears != null ? ` (~${Math.round(ownedYears)} yrs)` : ''}`);
  if (latestDot) summary.push(`Last loan ${latestDot.slice(0, 4)}${loanAge != null ? ` (~${Math.round(loanAge)} yrs old)` : ''}`);
  if (dots.length) summary.push(`${openLoans} of ${dots.length} recorded loans not reconveyed`);
  if (mods.length) summary.push(`${mods.length} loan modification${mods.length > 1 ? 's' : ''}`);
  const priorCures = cancels.filter((r) => r.recorded_date < fdate).length;
  if (priorDefaults) summary.push(`${priorDefaults} earlier default${priorDefaults > 1 ? 's' : ''}${priorCures ? ` (${priorCures} cured)` : ''}`);
  if (solar) summary.push('Solar lien/lease on record');
  if (openLiens) summary.push(`${openLiens} tax lien/judgment${openLiens > 1 ? 's' : ''} not released`);
  if (deceased) summary.push('Death recorded for this owner');
  if (truncated) summary.push('Common name — history may include other people');
  summary.unshift(`Equity: ${equityHint}`);

  return {
    doc_count: docs.length,
    truncated,
    priority,
    signals: {
      equity_hint: equityHint, owned_years: ownedYears && Math.round(ownedYears * 10) / 10,
      loan_age_years: loanAge && Math.round(loanAge * 10) / 10, latest_loan_date: latestDot, last_purchase_date: lastBuy,
      recorded_loans: dots.length, reconveyances: recons.length, open_loans: openLoans, loan_modifications: mods.length,
      prior_defaults: priorDefaults, cured_defaults: priorCures, open_liens: openLiens, solar, deceased,
      foreclosed, transferred_out: transferredOut, common_name: truncated,
    },
    summary,
    docs: docs.slice(0, 60).map((r) => ({ doc: r.document_number, date: r.recorded_date, type: r.descriptions.join(' / '),
      parties: r.parties.map((p) => `${p.name} (${p.role === 'grantor' ? 'R' : 'E'})`) })),
  };
}

export async function kernDossier(filing, names) {
  const rows = [];
  let truncated = false;
  for (const n of names.slice(0, 2)) {
    const h = await fetchNameHistory(n);
    rows.push(...h.rows);
    truncated = truncated || h.truncated;
    await sleep(250);
  }
  return buildDossier(filing, names, rows, truncated);
}
