import { sql } from '@/lib/db';
import { Flash } from '@/components/ui';
import { ev, date, dateTime } from '@/lib/format';
import { fixAndRetry, ignore } from './actions';

export const dynamic = 'force-dynamic';

const PARCEL_LOOKUP = 'https://www.kerncounty.com/government/departments/assessor-recorder/property/parcelquest-property-search';
const MAP_SEARCH = 'https://www.kerncounty.com/government/departments/assessor-recorder/property/assessor-parcel-map-search';

export default async function Review({ searchParams }) {
  const sp = await searchParams;
  const [match, rows] = await Promise.all([
    sql`select * from v_needs_match limit 200`,
    sql`select * from v_needs_review limit 200`,
  ]);
  return (
    <>
      <h1>Review</h1>
      <p className="sub">Records the machine refused to guess on. Recorder filings list borrower names only — find the parcel,
        enter its APN or address, and the lead is created, scored and flagged.</p>
      <Flash sp={sp} />

      <section className="card table-wrap" style={{ marginBottom: 16 }}>
        <h2>Find the parcel <span className="muted">· {match.length}</span></h2>
        {match.length === 0 ? <div className="empty">Nothing waiting.</div> : (
          <table>
            <thead><tr><th>Filing</th><th>Borrowers</th><th>Look up</th><th>Parcel</th><th></th></tr></thead>
            <tbody>
              {match.map((r) => {
                const names = (r.borrowers?.length ? r.borrowers : [r.raw_owner_name]).filter(Boolean);
                return (
                  <tr key={r.id}>
                    <td className="small">
                      <strong>{ev(r.source_type)}</strong>
                      <div className="muted">Doc {r.document_number} · {date(r.recorded_date)}</div>
                      <div className="muted">{r.raw_county}, {r.raw_state}</div>
                    </td>
                    <td className="small">{names.map((n) => <div key={n}>{n}</div>)}
                      {r.processing_error && <div className="muted">{r.processing_error}</div>}</td>
                    <td className="small">
                      <div><a href={PARCEL_LOOKUP} target="_blank" rel="noreferrer">ParcelQuest</a></div>
                      <div><a href={MAP_SEARCH} target="_blank" rel="noreferrer">Parcel maps</a></div>
                      <div><a href={`https://www.google.com/search?q=${encodeURIComponent(`"${names[0] || ''}" ${r.raw_county} County ${r.raw_state}`)}`} target="_blank" rel="noreferrer">Web search</a></div>
                    </td>
                    <td style={{ minWidth: 340 }}>
                      <form action={fixAndRetry}>
                        <input type="hidden" name="id" value={r.id} />
                        <div className="fields" style={{ marginBottom: 6 }}>
                          <div><label>APN</label><input name="raw_apn" /></div>
                          <div style={{ gridColumn: 'span 2' }}><label>Street address</label><input name="raw_address" /></div>
                          <div><label>ZIP</label><input name="raw_zip" inputMode="numeric" /></div>
                        </div>
                        <button className="btn sm primary">Create lead</button>
                      </form>
                    </td>
                    <td><form action={ignore}><input type="hidden" name="id" value={r.id} /><button className="btn sm danger">Skip</button></form></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card table-wrap">
        <h2>Data problems <span className="muted">· {rows.length}</span></h2>
        {rows.length === 0 ? <div className="empty">Queue is clear.</div> : (
          <table>
            <thead><tr><th>Record</th><th>Problem</th><th>Fix</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="small">
                    <strong>{ev(r.source_type)}</strong><div className="muted">{r.source_name} · {r.raw_county}, {r.raw_state}</div>
                    <div className="muted">{dateTime(r.received_at)}</div>
                  </td>
                  <td className="small" style={{ maxWidth: 260 }}>{r.processing_error}</td>
                  <td style={{ minWidth: 320 }}>
                    <form action={fixAndRetry}>
                      <input type="hidden" name="id" value={r.id} />
                      <div className="fields" style={{ marginBottom: 6 }}>
                        <div><label>APN</label><input name="raw_apn" defaultValue={r.raw_apn || ''} /></div>
                        <div style={{ gridColumn: 'span 2' }}><label>Address</label><input name="raw_address" defaultValue={r.raw_address || ''} /></div>
                      </div>
                      <button className="btn sm primary">Retry</button>
                    </form>
                  </td>
                  <td><form action={ignore}><input type="hidden" name="id" value={r.id} /><button className="btn sm danger">Ignore</button></form></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
