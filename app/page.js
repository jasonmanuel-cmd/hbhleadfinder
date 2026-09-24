import { sql } from '@/lib/db';
import { Tier, Signals } from '@/components/ui';
import { date, dateTime, daysUntil, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function Today() {
  const [[k], actions, auctions, followups] = await Promise.all([
    sql`select
          (select count(*) from lead_scores where lead_tier = 'A')::int as tier_a,
          (select count(*) from lead_scores where lead_tier = 'B')::int as tier_b,
          (select count(*) from deals where next_follow_up_at <= now()
             and stage not in ('closed','lost','dead'))::int as due,
          (select count(*) from raw_lead_intake where processing_status in ('needs_review','failed'))::int as review,
          (select count(*) from raw_lead_intake where processing_status = 'needs_property_match')::int as match,
          (select count(*) from raw_lead_intake where received_at > now() - interval '7 days')::int as new_7d,
          (select count(*) from outreach where attempted_at > now() - interval '7 days')::int as touches_7d`,
    sql`select * from v_action_list limit 25`,
    sql`select p.id, p.address_line_1, p.city, de.auction_date, ls.lead_tier, ls.total_score
          from distress_events de join properties p on p.id = de.property_id
          left join lead_scores ls on ls.property_id = p.id
         where de.auction_date between current_date and current_date + 30
         order by de.auction_date limit 10`,
    sql`select d.property_id, d.stage, d.next_follow_up_at, p.address_line_1, p.city, ls.lead_tier
          from deals d join properties p on p.id = d.property_id
          left join lead_scores ls on ls.property_id = d.property_id
         where d.next_follow_up_at <= now() + interval '1 day'
           and d.stage not in ('closed','lost','dead')
         order by d.next_follow_up_at limit 15`,
  ]);

  return (
    <>
      <h1>Today</h1>
      <p className="sub">Work Tier A first. Verify title, debt and authority before any offer.</p>

      <div className="grid kpis">
        <Kpi v={k.tier_a} label="Tier A leads" />
        <Kpi v={k.tier_b} label="Tier B leads" />
        <Kpi v={k.due} label="Follow-ups due" href="#followups" />
        <Kpi v={k.match} label="Filings to match" href="/review" />
        <Kpi v={k.review} label="Data problems" href="/review" />
        <Kpi v={k.new_7d} label="New records · 7d" />
        <Kpi v={k.touches_7d} label="Touches · 7d" />
      </div>

      <div className="grid two">
        <section className="card">
          <h2>Action list — Tier A / B, not yet worked today</h2>
          {actions.length === 0 ? (
            <div className="empty">No Tier A/B leads yet. <a href="/add">Add or import leads</a>, then underwrite them on the lead page.</div>
          ) : (
            <div className="table-wrap"><table>
              <thead><tr><th></th><th>Property</th><th>Signals</th><th className="num">Score</th><th>Sale</th><th>Stage</th></tr></thead>
              <tbody>
                {actions.map((a) => (
                  <tr key={a.property_id}>
                    <td><Tier t={a.lead_tier} /></td>
                    <td>
                      <a className="rowlink" href={`/leads/${a.property_id}`}>{a.address_line_1 || a.apn}</a>
                      <div className="muted small">{a.city}, {a.state} {a.zip}</div>
                      {a.equity_purchase_law_applies && <span className="badge flag small">Equity-purchase law</span>}
                    </td>
                    <td><Signals list={a.signals} /></td>
                    <td className="num">{a.total_score}</td>
                    <td>{a.next_auction ? <>{date(a.next_auction)}<div className="muted small">{daysUntil(a.next_auction)}d</div></>
                      : a.est_sale_date ? <>~{date(a.est_sale_date)}<div className="muted small">est. {daysUntil(a.est_sale_date)}d</div></> : '—'}</td>
                    <td>{label(a.stage)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </section>

        <div className="stack">
          <section className="card" id="followups">
            <h2>Follow-ups due</h2>
            {followups.length === 0 ? <div className="empty">Nothing due.</div> : (
              <ul className="timeline">
                {followups.map((f) => (
                  <li key={f.property_id}>
                    <Tier t={f.lead_tier} />{' '}
                    <a className="rowlink" href={`/leads/${f.property_id}`}>{f.address_line_1}</a>
                    <div className="muted small">{dateTime(f.next_follow_up_at)} · {label(f.stage)}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card">
            <h2>Auctions in the next 30 days</h2>
            {auctions.length === 0 ? <div className="empty">None scheduled.</div> : (
              <ul className="timeline">
                {auctions.map((a) => (
                  <li key={a.id + a.auction_date}>
                    <Tier t={a.lead_tier} />{' '}
                    <a className="rowlink" href={`/leads/${a.id}`}>{a.address_line_1}</a>
                    <div className="muted small">{date(a.auction_date)} · {daysUntil(a.auction_date)} days</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function Kpi({ v, label, href }) {
  const body = (<><div className="v">{v}</div><div className="k">{label}</div></>);
  return <div className="card kpi">{href ? <a href={href} style={{ textDecoration: 'none' }}>{body}</a> : body}</div>;
}
