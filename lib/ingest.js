import { sql } from '@/lib/db';
import { collectKern } from '@/lib/collectors/kernRecorder';
import { kernDossier } from '@/lib/collectors/kernHistory';
import { tidyQueue, fillMissingAddresses } from '@/lib/parcelFill';

export const COLLECTORS = {
  kern_recorder: {
    label: 'Kern County Recorder — defaults, trustee sales, deaths/TOD, estates, liens',
    run: collectKern,
    dossier: kernDossier,
    lookbackDays: 10,
  },
};

const LEAD_TYPES = ['notice_of_default', 'notice_of_trustee_sale', 'tod_affidavit', 'death_joint_tenant', 'letters_testamentary'];

// Build recorder-history dossiers for filings that don't have one yet, newest and most urgent first.
export async function enrichDossiers(sourceId, { limit = 40, deadline = Date.now() + 90000 } = {}) {
  const c = COLLECTORS[sourceId];
  if (!c?.dossier) return { built: 0, failed: 0, remaining: 0 };
  const todo = await sql`
    select i.id, i.source_type, i.event_date, i.property_id, i.raw_owner_name,
           i.raw_payload -> 'history_names' as history_names, i.raw_payload -> 'borrowers' as borrowers,
           i.raw_payload ->> 'document_number' as document_number
      from raw_lead_intake i
      left join borrower_dossiers d on d.intake_id = i.id
     where i.source_name = ${sourceId}
       and (d.intake_id is null or (d.error is not null and d.fetched_at < now() - interval '6 hours'))
       and i.source_type in ${sql(LEAD_TYPES)}
       and i.processing_status in ('processed','needs_property_match')
     order by case i.source_type when 'notice_of_trustee_sale' then 0 when 'notice_of_default' then 1 else 2 end,
              i.event_date desc nulls last
     limit ${limit}`;
  let built = 0, failed = 0;
  for (const t of todo) {
    if (Date.now() > deadline) break;
    const names = (t.history_names?.length ? t.history_names : t.borrowers?.length ? t.borrowers : [t.raw_owner_name]).filter(Boolean);
    if (!names.length) continue;
    const filing = { signal: t.source_type, date: t.event_date?.toISOString?.().slice(0, 10) ?? String(t.event_date).slice(0, 10),
      document_number: t.document_number };
    try {
      const d = await c.dossier(filing, names);
      await sql`
        insert into borrower_dossiers (intake_id, names, doc_count, truncated, priority, signals, summary, docs)
        values (${t.id}, ${names}, ${d.doc_count}, ${d.truncated}, ${d.priority}, ${sql.json(d.signals)},
                ${d.summary}, ${sql.json(d.docs)})
        on conflict (intake_id) do update set names = excluded.names, doc_count = excluded.doc_count,
          truncated = excluded.truncated, priority = excluded.priority, signals = excluded.signals,
          summary = excluded.summary, docs = excluded.docs, fetched_at = now(), error = null`;
      if (t.property_id) await sql`select recalculate_lead_score(${t.property_id})`;
      built++;
    } catch (e) {
      failed++;
      await sql`insert into borrower_dossiers (intake_id, names, error) values (${t.id}, ${names}, ${String(e.message).slice(0, 300)})
                on conflict (intake_id) do update set error = excluded.error, fetched_at = now()`;
    }
  }
  const [{ n }] = await sql`
    select count(*)::int as n from raw_lead_intake i left join borrower_dossiers d on d.intake_id = i.id
     where i.source_name = ${sourceId} and d.intake_id is null and i.source_type in ${sql(LEAD_TYPES)}
       and i.processing_status in ('processed','needs_property_match')`;
  return { built, failed, remaining: n };
}

export async function runCollector(sourceId, { trigger = 'cron', lookbackDays, budgetMs = 240000 } = {}) {
  const started = Date.now();
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
    // spend what's left of the time budget on recorder histories
    const dossiers = await enrichDossiers(sourceId, { limit: 80, deadline: started + budgetMs - 60000 });
    // tax-list name matches, drop dead filings, then fill addresses with whatever time is left
    const tidy = await tidyQueue();
    const addr = await fillMissingAddresses({ limit: 60, deadline: started + budgetMs });
    const stats = { fetched: records.length, inserted, processed, matched, needs_match: needsMatch, histories: dossiers.built,
      histories_remaining: dossiers.remaining, ...tidy, addresses: addr.filled, addresses_remaining: addr.remaining };
    await sql`update source_runs set status = 'ok', finished_at = now(), fetched = ${stats.fetched},
                inserted = ${inserted}, processed = ${processed}, matched = ${matched}, needs_match = ${needsMatch},
                note = ${`histories built ${dossiers.built}${dossiers.failed ? `, failed ${dossiers.failed}` : ''}, waiting ${dossiers.remaining}`
                  + ` · tax-list matches ${tidy.taxMatched} · auto-skipped ${tidy.skipped} · addresses filled ${addr.filled} (${addr.remaining} to go)`}
              where id = ${run.id}`;
    return stats;
  } catch (e) {
    await sql`update source_runs set status = 'error', finished_at = now(), error = ${String(e.message).slice(0, 500)}
              where id = ${run.id}`;
    throw e;
  }
}
