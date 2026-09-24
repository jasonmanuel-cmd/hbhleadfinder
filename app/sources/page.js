import { sql } from '@/lib/db';
import { label, dateTime } from '@/lib/format';
import { Flash } from '@/components/ui';
import { COLLECTORS } from '@/lib/ingest';
import { pullNow, buildHistories, fillAddresses } from './actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export default async function Sources({ searchParams }) {
  const sp = await searchParams;
  const [perf, queue, juris, runs, [na]] = await Promise.all([
    sql`select * from v_source_performance order by contracts desc, tier_ab desc, records_received desc`,
    sql`select * from v_queue_health`,
    sql`select j.state, j.county, j.active, s.foreclosure_type, s.equity_purchase_statute
          from jurisdictions j join state_rules s on s.state = j.state order by j.active desc, j.state, j.county`,
    sql`select * from source_runs order by started_at desc limit 10`,
    sql`select (select count(*) from v_needs_address)::int as addr, (select count(*) from tax_defaults)::int as tax`,
  ]);
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  return (
    <>
      <h1>Sources</h1>
      <p className="sub">Judge sources by contracts, not record counts. A source with volume and no appointments gets cut.</p>
      <Flash sp={sp} />
      <section className="card" style={{ marginBottom: 16 }}>
        <h2>Automatic feeds</h2>
        {Object.entries(COLLECTORS).map(([id, c]) => (
          <form key={id} action={pullNow} className="toolbar" style={{ marginBottom: 12 }}>
            <input type="hidden" name="source" value={id} />
            <div style={{ flex: 2 }}><strong>{c.label}</strong>
              <div className="muted small">Runs daily at 8am Pacific · re-reads the last {c.lookbackDays} days so late-indexed filings are caught · duplicates skipped · builds each owner's recorded history</div></div>
            <div style={{ minWidth: 110 }}><label>Days back</label><input name="days" defaultValue={c.lookbackDays} inputMode="numeric" /></div>
            <div style={{ minWidth: 0 }}><button className="btn primary">Pull now</button>{' '}
              <button className="btn" formAction={buildHistories}>Build histories</button></div>
          </form>
        ))}
        <form action={fillAddresses} className="toolbar" style={{ marginBottom: 12 }}>
          <div style={{ flex: 2 }}><strong>Street addresses from APN</strong>
            <div className="muted small">{na.addr} leads with a recorder or court signal have an APN but no street address or ZIP.
              Filled from Kern's parcel map plus the Census geocoder, best leads first, about 200 per click; the daily pull does 60.
              {' '}{na.tax.toLocaleString()} tax-defaulted parcels on file for name matching.</div></div>
          <div><button className="btn">Fill addresses</button></div>
        </form>
        {runs.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Run</th><th>Window</th><th className="num">Filings</th><th className="num">New</th><th className="num">Attached</th><th className="num">Need parcel</th><th>Status</th></tr></thead>
            <tbody>{runs.map((r) => (
              <tr key={r.id}>
                <td className="small">{dateTime(r.started_at)}<div className="muted">{r.source_id} · {r.trigger}</div></td>
                <td className="small">{String(r.window_from?.toISOString?.() ?? r.window_from).slice(0, 10)} → {String(r.window_to?.toISOString?.() ?? r.window_to).slice(0, 10)}</td>
                <td className="num">{r.fetched}</td><td className="num">{r.inserted}</td><td className="num">{r.matched}</td>
                <td className="num">{r.needs_match > 0 ? <a href="/review">{r.needs_match}</a> : 0}</td>
                <td className="small">{r.status === 'error' ? <span className="badge flag">{r.error}</span> : label(r.status)}
                  {r.note && <div className="muted">{r.note}</div>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
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
