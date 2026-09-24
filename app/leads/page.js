import { sql } from '@/lib/db';
import { Tier, Signals, Select } from '@/components/ui';
import { STAGES, EVENT_TYPES, ev, label, date } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function Leads({ searchParams }) {
  const sp = await searchParams;
  const tier = ['A', 'B', 'C', 'D'].includes(sp.tier) ? sp.tier : null;
  const stage = STAGES.includes(sp.stage) ? sp.stage : null;
  const signal = EVENT_TYPES.includes(sp.signal) ? sp.signal : null;
  const q = sp.q ? `%${String(sp.q).trim()}%` : null;

  const rows = await sql`
    select p.id, p.address_line_1, p.city, p.state, p.county, p.zip, p.apn,
           ls.lead_tier, ls.total_score, ls.equity_purchase_law_applies, d.stage, d.next_follow_up_at,
           (select array_agg(distinct de.event_type) from distress_events de where de.property_id = p.id) as signals,
           (select max(coalesce(de.event_date, de.recorded_date)) from distress_events de where de.property_id = p.id) as latest,
           (select string_agg(o.full_name, ', ') from property_owners po join owners o on o.id = po.owner_id
             where po.property_id = p.id) as owners
      from properties p
      left join lead_scores ls on ls.property_id = p.id
      left join deals d on d.property_id = p.id
     where (${tier}::text is null or ls.lead_tier = ${tier})
       and (${stage}::text is null or d.stage = ${stage})
       and (${signal}::text is null or exists (select 1 from distress_events de
              where de.property_id = p.id and de.event_type = ${signal}))
       and (${q}::text is null or p.address_line_1 ilike ${q} or p.apn ilike ${q} or p.city ilike ${q}
            or exists (select 1 from property_owners po join owners o on o.id = po.owner_id
                        where po.property_id = p.id and o.full_name ilike ${q}))
     order by ls.total_score desc nulls last, p.created_at desc
     limit 300`;

  return (
    <>
      <h1>Leads</h1>
      <p className="sub">{rows.length} shown{rows.length === 300 ? ' (first 300)' : ''}</p>
      <form className="toolbar card" method="get">
        <div style={{ flex: 2 }}><label>Search</label><input name="q" defaultValue={sp.q || ''} placeholder="Address, APN, city or owner" /></div>
        <div><label>Tier</label><Select name="tier" options={['A', 'B', 'C', 'D']} value={tier} blank="All" /></div>
        <div><label>Stage</label><Select name="stage" options={STAGES} value={stage} blank="All" /></div>
        <div><label>Signal</label><Select name="signal" options={EVENT_TYPES} value={signal} blank="All" labels={ev} /></div>
        <div style={{ minWidth: 0 }}><button className="btn primary">Filter</button> <a className="btn" href="/leads">Reset</a></div>
      </form>
      <div className="card table-wrap">
        {rows.length === 0 ? <div className="empty">No leads match.</div> : (
          <table>
            <thead><tr><th></th><th>Property</th><th>Owner(s)</th><th>Signals</th><th>Latest</th><th>Stage</th><th className="num">Score</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Tier t={r.lead_tier} /></td>
                  <td><a className="rowlink" href={`/leads/${r.id}`}>{r.address_line_1 || `APN ${r.apn}`}</a>
                    <div className="muted small">{r.city || r.county}, {r.state} {r.zip}</div>
                    {r.equity_purchase_law_applies && <span className="badge flag small">Equity-purchase law</span>}</td>
                  <td className="small">{r.owners || '—'}</td>
                  <td><Signals list={r.signals} /></td>
                  <td className="small">{date(r.latest)}</td>
                  <td className="small">{label(r.stage)}</td>
                  <td className="num">{r.total_score ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
