'use server';
import { redirect } from 'next/navigation';
import { runCollector, enrichDossiers, COLLECTORS } from '@/lib/ingest';
import { tidyQueue, fillMissingAddresses } from '@/lib/parcelFill';

export async function pullNow(fd) {
  const source = String(fd.get('source') || '');
  const days = Math.min(60, Math.max(1, Number(fd.get('days')) || 10));
  let msg = null, err = null;
  try {
    if (!COLLECTORS[source]) throw new Error('Unknown source');
    const s = await runCollector(source, { trigger: 'manual', lookbackDays: days });
    msg = `Pulled ${s.fetched} filings · ${s.inserted} new · ${s.matched} attached to tracked properties · ${s.needs_match} need a parcel match · ${s.histories} owner histories built (${s.histories_remaining} waiting) · ${s.taxMatched} matched on the tax list · ${s.skipped} auto-skipped · ${s.addresses} addresses filled`;
  } catch (e) { err = e.message; }
  redirect(`/sources?${err ? 'error' : 'ok'}=${encodeURIComponent(err || msg)}`);
}

export async function buildHistories(fd) {
  const source = String(fd.get('source') || '');
  let msg = null, err = null;
  try {
    if (!COLLECTORS[source]) throw new Error('Unknown source');
    const r = await enrichDossiers(source, { limit: 80, deadline: Date.now() + 230000 });
    const t = await tidyQueue();
    msg = `Built ${r.built} owner histories${r.failed ? ` · ${r.failed} failed` : ''} · ${r.remaining} still waiting · ${t.taxMatched} matched on the tax list · ${t.skipped} dead filings auto-skipped`;
  } catch (e) { err = e.message; }
  redirect(`/sources?${err ? 'error' : 'ok'}=${encodeURIComponent(err || msg)}`);
}

export async function fillAddresses() {
  let msg = null, err = null;
  try {
    const r = await fillMissingAddresses({ limit: 200, deadline: Date.now() + 240000 });
    msg = `Filled ${r.filled} street addresses from the county parcel map · ${r.none} parcels have no street address (land) · ${r.remaining} still to do${r.failed ? ` · ${r.failed} lookups failed` : ''}`;
  } catch (e) { err = e.message; }
  redirect(`/sources?${err ? 'error' : 'ok'}=${encodeURIComponent(err || msg)}`);
}
