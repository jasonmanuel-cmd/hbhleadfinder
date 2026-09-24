import { sql } from '@/lib/db';
import { label, dateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function Sources() {
  const [perf, queue, juris] = await Promise.all([
    sql`select * from v_source_performance order by contracts desc, tier_ab desc, records_received desc`,
    sql`select * from v_queue_health`,
    sql`select j.state, j.county, j.active, s.foreclosure_type, s.equity_purchase_statute
          from jurisdictions j join state_rules s on s.state = j.state order by j.active desc, j.state, j.county`,
  ]);
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  return (
    <>
      <h1>Sources</h1>
      <p className="sub">Judge sources by contracts, not record counts. A source with volume and no appointments gets cut.</p>
      <section className="card table-wrap" style={{ marginBottom: 16 }}>
        <h2>Source → contract funnel</h2>
        <table>
          <thead><tr><th>Source</th><th className="num">Records</th><th className="num">Properties</th><th className="num">Tier A/B</th>
            <th className="num">Conversations</th><th className="num">Appts</th><th className="num">Offers</th><th className="num">Contracts</th>
            <th className="num">Closed</th><th className="num">Qualified → contract</th></tr></thead>
          <tbody>
            {perf.map((s) => (
              <tr key={s.source}>
                <td><strong>{s.source}</strong><div className="muted small">{label(s.source_type)}</div></td>
                <td className="num">{s.records_received}</td><td className="num">{s.properties}</td>
                <td className="num">{s.tier_ab} <span className="muted small">{pct(s.tier_ab, s.properties)}</span></td>
                <td className="num">{s.conversations}</td><td className="num">{s.appointments}</td><td className="num">{s.offers}</td>
                <td className="num">{s.contracts}</td><td className="num">{s.closed}</td>
                <td className="num">{s.contract_rate_of_qualified != null ? `${Math.round(s.contract_rate_of_qualified * 100)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <div className="grid two">
        <section className="card table-wrap">
          <h2>Enrichment queue</h2>
          {queue.length === 0 ? <div className="empty">Empty.</div> : (
            <table>
              <thead><tr><th>Type</th><th>Status</th><th className="num">Jobs</th><th className="num">Avg attempts</th><th>Next</th></tr></thead>
              <tbody>{queue.map((q, i) => (
                <tr key={i}><td>{label(q.enrichment_type)}</td><td>{label(q.status)}</td><td className="num">{q.jobs}</td>
                  <td className="num">{q.avg_attempts}</td><td className="small">{dateTime(q.next_available)}</td></tr>
              ))}</tbody>
            </table>
          )}
          <p className="muted small">Jobs wait here until the enrichment workers (Regrid, valuation, contact) are connected.</p>
        </section>
        <section className="card table-wrap">
          <h2>Jurisdictions</h2>
          <table>
            <thead><tr><th>Market</th><th>Foreclosure</th><th>Equity-purchase law</th></tr></thead>
            <tbody>{juris.map((j) => (
              <tr key={j.state + j.county}><td>{j.county}, {j.state} {j.active ? '' : <span className="muted small">(inactive)</span>}</td>
                <td>{j.foreclosure_type}</td><td className="small">{j.equity_purchase_statute || '—'}</td></tr>
            ))}</tbody>
          </table>
        </section>
      </div>
    </>
  );
}
