'use server';
import { redirect } from 'next/navigation';
import { runCollector, COLLECTORS } from '@/lib/ingest';

export async function pullNow(fd) {
  const source = String(fd.get('source') || '');
  const days = Math.min(60, Math.max(1, Number(fd.get('days')) || 10));
  let msg = null, err = null;
  try {
    if (!COLLECTORS[source]) throw new Error('Unknown source');
    const s = await runCollector(source, { trigger: 'manual', lookbackDays: days });
    msg = `Pulled ${s.fetched} filings · ${s.inserted} new · ${s.matched} attached to tracked properties · ${s.needs_match} need a parcel match`;
  } catch (e) { err = e.message; }
  redirect(`/sources?${err ? 'error' : 'ok'}=${encodeURIComponent(err || msg)}`);
}
