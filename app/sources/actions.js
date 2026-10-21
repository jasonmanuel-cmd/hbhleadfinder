'use server';
import { redirect } from 'next/navigation';
import { sql, dbError } from '@/lib/db';
import { runCollector, enrichDossiers, COLLECTORS } from '@/lib/ingest';
import { tidyQueue, fillMissingAddresses } from '@/lib/parcelFill';
import { runEnrichment } from '@/lib/enrichment';
import { explainFeedError } from '@/lib/feedHealth';

export async function pullNow(fd) {
  const source = String(fd.get('source') || '');
  const days = Math.min(60, Math.max(1, Number(fd.get('days')) || 10));
  let msg = null, err = null;
  try {
    if (!COLLECTORS[source]) throw new Error('Unknown source');
    const s = await runCollector(source, { trigger: 'manual', lookbackDays: days });
    msg = `Pulled ${s.fetched} filings · ${s.inserted} new · ${s.matched} attached to tracked properties · ${s.needs_match} need a parcel match · ${s.histories} owner histories built (${s.histories_remaining} waiting) · ${s.taxMatched} matched on the tax list · ${s.skipped} auto-skipped · ${s.addresses} addresses filled`;
  } catch (e) { const r = explainFeedError(e.message); err = `${r.what} — ${r.why}`; }
  redirect(`/sources?${err ? 'error' : 'ok'}=${encodeURIComponent(err || msg)}`);
}

export async function buildHistories(fd) {
  const source = String(fd.get('source') || '');
  let msg = null, err = null;
  try {
    if (!COLLECTORS[source]) throw new Error('Unknown source');
    const r = await enrichDossiers(source, { limit: 80, deadline: Date.now() + 230000 });
    const t = await tidyQueue();
    msg = `Built ${r.built} owner histories${r.failed ? ` · ${r.failed} failed` : ''} · ${r.remaining} still waiting · ${t.taxMatched} matched on the tax list · ${t.skipped} dead filings auto-skipped`
      + (r.errored ? ` · ${r.errored} histor${r.errored === 1 ? 'y is' : 'ies are'} in error and will be retried later` : '');
  } catch (e) { const r = explainFeedError(e.message); err = `${r.what} — ${r.why}`; }
  redirect(`/sources?${err ? 'error' : 'ok'}=${encodeURIComponent(err || msg)}`);
}

export async function fillAddresses() {
  let msg = null, err = null;
  try {
    const r = await fillMissingAddresses({ limit: 200, deadline: Date.now() + 240000 });
    msg = `Filled ${r.filled} street addresses from the county parcel map · ${r.none} parcels have no street address (land) · ${r.remaining} still to do${r.failed ? ` · ${r.failed} lookups failed` : ''}`;
  } catch (e) { const r = explainFeedError(e.message); err = `${r.what} — ${r.why}`; }
  redirect(`/sources?${err ? 'error' : 'ok'}=${encodeURIComponent(err || msg)}`);
}

export async function runEnrichmentNow(fd) {
  const types = String(fd.get('types') || 'valuation,parcel')
    .split(',').map((t) => t.trim()).filter(Boolean).slice(0, 6);
  const limit = Math.min(50, Math.max(1, Number(fd.get('limit')) || 10));
  let msg = null, err = null;
  try {
    const r = await runEnrichment({ types, limit, deadline: Date.now() + 230000 });
    msg = `Worked ${r.claimed} enrichment job(s) · ${r.completed} completed · ${r.skipped} skipped · ${r.failed} failed · ${r.released} stale lock(s) released`
      + (r.failed ? ' — failed jobs back off and retry on their own' : '');
  } catch (e) { err = e.message; }
  redirect(`/sources?${err ? 'error' : 'ok'}=${encodeURIComponent(err || msg)}`);
}

export async function clearDemoData() {
  let msg = null, err = null;
  try {
    // Only rows the demo seed marked. A real database has none, so this is a no-op
    // there -- it can never touch a real lead.
    const rows = await sql`select id from properties where data_confidence = 'demo'`;
    if (!rows.length) {
      msg = 'No demo data found — nothing to clear.';
    } else {
      for (const r of rows) await sql`delete from properties where id = ${r.id}`;
      msg = `Cleared ${rows.length} demo propert${rows.length === 1 ? 'y' : 'ies'} and everything hanging off them (scores, events, letters, touches).`;
    }
  } catch (e) { err = dbError(e); }
  redirect(`/sources?${err ? 'error' : 'ok'}=${encodeURIComponent(err || msg)}`);
}

export async function importCountyPage(fd) {
  let msg = null, err = null;
  try {
    const file = fd.get('file');
    if (!file || typeof file !== 'object' || !file.size) throw new Error('Choose the saved county results page.');
    const html = await file.text();
    const { ingestKernHtml } = await import('@/lib/ingest');
    const r = await ingestKernHtml(html, { trigger: 'manual', lookbackDays: 60 });
    msg = `Read ${r.fetched} filing(s) from the saved page · ${r.inserted} new · ${r.processed} scored · ${r.matched} attached to a property you already track · ${r.needs_match} need a parcel match`
      + (r.skipped ? ` · ${r.skipped} filing(s) in a document class this app does not know` : '');
  } catch (e) { err = dbError(e); }
  redirect(`/sources?${err ? 'error' : 'ok'}=${encodeURIComponent(err || msg)}`);
}
