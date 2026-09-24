import { sql } from '@/lib/db';
import { collectKern } from '@/lib/collectors/kernRecorder';

export const COLLECTORS = {
  kern_recorder: { label: 'Kern County Recorder (NOD / NTS / rescissions)', run: collectKern, lookbackDays: 10 },
};

export async function runCollector(sourceId, { trigger = 'cron', lookbackDays } = {}) {
  const c = COLLECTORS[sourceId];
  if (!c) throw new Error(`Unknown collector ${sourceId}`);
  const to = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const from = new Date(to.getTime() - (lookbackDays ?? c.lookbackDays) * 86400000);
  const [run] = await sql`
    insert into source_runs (source_id, trigger, window_from, window_to)
    values (${sourceId}, ${trigger}, ${from.toISOString().slice(0, 10)}, ${to.toISOString().slice(0, 10)})
    returning id`;
  try {
    const records = await c.run(from, to);
    let inserted = 0;
    for (let i = 0; i < records.length; i += 200) {
      const batch = records.slice(i, i + 200).map((r) => ({ ...r, raw_payload: sql.json(r.raw_payload) }));
      const res = await sql`insert into raw_lead_intake ${sql(batch)} on conflict do nothing returning id`;
      inserted += res.length;
    }
    let processed = 0, matched = 0, needsMatch = 0;
    for (let pass = 0; pass < 50; pass++) {
      const [{ r }] = await sql`select process_pending_intake(100) as r`;
      if (!r.processed) break;
      for (const x of r.results) {
        if (x.status === 'processed') { processed++; if (x.matched_by_name) matched++; }
        if (x.status === 'needs_property_match') needsMatch++;
      }
    }
    const stats = { fetched: records.length, inserted, processed, matched, needs_match: needsMatch };
    await sql`update source_runs set status = 'ok', finished_at = now(), fetched = ${stats.fetched},
                inserted = ${inserted}, processed = ${processed}, matched = ${matched}, needs_match = ${needsMatch}
              where id = ${run.id}`;
    return stats;
  } catch (e) {
    await sql`update source_runs set status = 'error', finished_at = now(), error = ${String(e.message).slice(0, 500)}
              where id = ${run.id}`;
    throw e;
  }
}
