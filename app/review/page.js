import { sql } from '@/lib/db';
import { Flash } from '@/components/ui';
import { ev, dateTime } from '@/lib/format';
import { fixAndRetry, ignore } from './actions';

export const dynamic = 'force-dynamic';

export default async function Review({ searchParams }) {
  const sp = await searchParams;
  const rows = await sql`select * from v_needs_review limit 200`;
  return (
    <>
      <h1>Review</h1>
      <p className="sub">Records the machine refused to guess on: missing identifiers, ambiguous addresses, APN conflicts, bad data.
        Fix the APN or address and retry, or ignore.</p>
      <Flash sp={sp} />
      <div className="card table-wrap">
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
      </div>
    </>
  );
}
