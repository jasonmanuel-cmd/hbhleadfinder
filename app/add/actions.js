'use server';
import { redirect } from 'next/navigation';
import { createHash } from 'node:crypto';
import { sql, dbError } from '@/lib/db';
import { parseCsv } from '@/lib/csv';
import { EVENT_TYPES, str } from '@/lib/format';

const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const validDate = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

function toIntake(r, sources) {
  const source = clean(r.source);
  const signal = clean(r.signal || r.event_type || r.source_type);
  const state = (clean(r.state) || '').toUpperCase();
  const county = clean(r.county);
  if (!sources.has(source)) throw new Error(`unknown source "${source ?? ''}"`);
  if (!EVENT_TYPES.includes(signal)) throw new Error(`unknown signal "${signal ?? ''}"`);
  if (!/^[A-Z]{2}$/.test(state)) throw new Error('state must be a 2-letter code');
  if (!county) throw new Error('county is required');
  if (!clean(r.apn) && !clean(r.address)) throw new Error('apn or address is required');

  const payload = {};
  for (const k of ['document_number', 'case_number', 'amount_owed', 'party_role', 'notes']) if (clean(r[k])) payload[k] = clean(r[k]);
  for (const k of ['recorded_date', 'auction_date']) if (validDate(clean(r[k]))) payload[k] = clean(r[k]);

  // Idempotent re-imports: stable id from the record's identity when none supplied
  const recordId = clean(r.source_record_id) || clean(r.document_number) || clean(r.case_number) ||
    createHash('sha1').update([source, signal, state, county, clean(r.apn), clean(r.address)?.toUpperCase(),
      clean(r.event_date)].join('|')).digest('hex').slice(0, 20);

  return {
    source_name: source, source_type: signal, source_record_id: recordId, source_url: clean(r.source_url),
    event_date: validDate(clean(r.event_date)), raw_state: state, raw_county: county, raw_apn: clean(r.apn),
    raw_address: clean(r.address), raw_city: clean(r.city), raw_zip: clean(r.zip), raw_owner_name: clean(r.owner),
    raw_payload: sql.json(payload),
  };
}

async function sourceSet() {
  const rows = await sql`select id from lead_sources where active`;
  return new Set(rows.map((r) => r.id));
}

export async function addLead(fd) {
  let dest = null, err = null;
  try {
    const row = Object.fromEntries(['source', 'signal', 'state', 'county', 'apn', 'address', 'city', 'zip', 'owner',
      'party_role', 'event_date', 'document_number', 'case_number', 'auction_date', 'amount_owed', 'notes', 'source_url']
      .map((k) => [k, str(fd, k)]));
    const rec = toIntake(row, await sourceSet());
    const [ins] = await sql`insert into raw_lead_intake ${sql(rec)} on conflict do nothing returning id`;
    if (!ins) throw new Error('This record was already imported (same source + record id).');
    const [{ res }] = await sql`select process_raw_property_lead(${ins.id}) as res`;
    if (res.status === 'processed') dest = `/leads/${res.property_id}?ok=${encodeURIComponent('Lead added and scored.')}`;
    else dest = `/review?ok=${encodeURIComponent(`Lead saved but needs review: ${res.reason || res.error}`)}`;
  } catch (e) { err = dbError(e); }
  redirect(dest || `/add?error=${encodeURIComponent(err)}`);
}

export async function importCsv(fd) {
  let msg = null, err = null;
  try {
    const file = fd.get('file');
    let text = str(fd, 'csv') || '';
    if (file && typeof file === 'object' && file.size > 0) text = await file.text();
    if (!text.trim()) throw new Error('Choose a CSV file or paste CSV text.');
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('No data rows found.');
    if (rows.length > 2000) throw new Error('Max 2,000 rows per import. Split the file.');

    const sources = await sourceSet();
    const good = [], bad = [];
    rows.forEach((r, i) => {
      try { good.push(toIntake(r, sources)); } catch (e) { bad.push(`row ${i + 2}: ${e.message}`); }
    });
    let inserted = 0;
    if (good.length) {
      const res = await sql`insert into raw_lead_intake ${sql(good)} on conflict do nothing returning id`;
      inserted = res.length;
    }
    let processed = 0, review = 0;
    for (let pass = 0; pass < 50; pass++) {
      const [{ r }] = await sql`select process_pending_intake(100) as r`;
      if (!r.processed) break;
      for (const x of r.results) x.status === 'processed' ? processed++ : review++;
    }
    msg = `${rows.length} rows · ${inserted} new · ${good.length - inserted} duplicates skipped · ${processed} scored · ${review} sent to review`
      + (bad.length ? ` · ${bad.length} rejected (${bad.slice(0, 5).join('; ')}${bad.length > 5 ? '…' : ''})` : '');
  } catch (e) { err = dbError(e); }
  redirect(err ? `/add?error=${encodeURIComponent(err)}` : `/add?ok=${encodeURIComponent(msg)}`);
}
