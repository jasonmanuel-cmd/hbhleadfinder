import { sql } from '@/lib/db';
import { Flash } from '@/components/ui';
import { ev, date, dateTime, label, DEATH_SIGNALS } from '@/lib/format';
import { fixAndRetry, ignore, restoreSkipped } from './actions';

export const dynamic = 'force-dynamic';

const g = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
const ENTITY = /\b(LLC|INC|CORP|CO|TRUST|TR|BANK|ASSN|LP|LTD|ESTATE|EST|COUNTY|CITY|STATE)\b/;
// Recorder names are "LAST FIRST MIDDLE"; people-search sites want "First Last"
function firstLast(n) {
  const t = String(n || '').replace(/\s+(DECD|EST|EXTR|ADMR|TR)$/i, '').trim().split(/\s+/);
  if (t.length < 2 || ENTITY.test(t.join(' '))) return null;
  const cap = (w) => w.charAt(0) + w.slice(1).toLowerCase();
  return `${cap(t[1])} ${cap(t[0])}`;
}
function lookupLinks(people, signal, county) {
  const links = [];
  const seen = new Set();
  for (const p of people) {
    const fl = firstLast(p.name);
    if (!fl || seen.has(fl)) continue;
    seen.add(fl);
    const where = `${county} County CA`;
    if (p.role === 'decedent') {
      links.push({ who: fl, items: [['Obituary', g(`"${fl}" obituary Bakersfield OR "${county} County"`)],
        ['Old address', `https://www.truepeoplesearch.com/results?${new URLSearchParams({ name: fl, citystatezip: 'CA' })}`]] });
    } else {
      links.push({ who: fl, items: [['Address', `https://www.truepeoplesearch.com/results?${new URLSearchParams({ name: fl, citystatezip: 'CA' })}`],
        ['Alt', `https://www.fastpeoplesearch.com/name/${fl.toLowerCase().replace(/\s+/g, '-')}_ca`],
        ['Web', g(`"${fl}" ${where}`)]] });
    }
    if (links.length >= 3) break;
  }
  return links;
}

export default async function Review({ searchParams }) {
  const sp = await searchParams;
  const [match, rows, skipped] = await Promise.all([
    sql`select * from v_needs_match limit 200`,
    sql`select * from v_needs_review limit 200`,
    sql`select * from v_auto_skipped limit 100`,
  ]);
  return (
    <>
      <h1>Review</h1>
      <p className="sub">Records the machine refused to guess on. Recorder filings list names only. Find the person's address with the look-up links,
        paste it in, and the APN is filled from Kern's parcel map — lead created, scored and flagged.</p>
      <Flash sp={sp} />

      <section className="card table-wrap" style={{ marginBottom: 16 }}>
        <h2>Find the parcel <span className="muted">· {match.length} · best first</span></h2>
        <p className="muted small" style={{ marginTop: -6 }}>Priority comes from each owner's recorded history (loan age, years owned, paid-off loans,
          earlier defaults, liens). Match from the top; skip what scores low.</p>
        {match.length === 0 ? <div className="empty">Nothing waiting.</div> : (
          <table>
            <thead><tr><th className="num">Priority</th><th>Filing</th><th>People · recorded history</th><th>Look up</th><th>Parcel</th><th></th></tr></thead>
            <tbody>
              {match.map((r) => {
                const people = r.people?.length ? r.people
                  : (r.borrowers?.length ? r.borrowers : [r.raw_owner_name]).filter(Boolean).map((n) => ({ name: n, role: 'owner' }));
                const names = people.map((p) => p.name);
                const links = lookupLinks(people, r.source_type, r.raw_county);
                const pr = r.priority;
                return (
                  <tr key={r.id}>
                    <td className="num">{pr == null ? <span className="muted small">{r.history_error ? 'error' : 'pending'}</span>
                      : <span className={`badge tier tier-${pr >= 60 ? 'A' : pr >= 40 ? 'B' : pr >= 20 ? 'C' : 'D'}`} style={{ width: 34 }}>{pr}</span>}</td>
                    <td className="small">
                      <strong>{ev(r.source_type)}</strong>
                      <div className="muted">Doc {r.document_number} · {date(r.recorded_date)}</div>
                      <div className="muted">{r.raw_county}, {r.raw_state}</div>
                      {DEATH_SIGNALS.includes(r.source_type) && <div className="badge flag small" style={{ marginTop: 4 }}>Recent death — letter only, wait 30 days</div>}
                    </td>
                    <td className="small" style={{ maxWidth: 360 }}>
                      {people.map((p) => <div key={p.name}><strong>{p.name}</strong> <span className="muted">{label(p.role)}</span></div>)}
                      <div style={{ marginTop: 6 }}>{(r.summary || []).map((x) => <span key={x} className="chip">{x}</span>)}</div>
                      {r.history_error && <div className="muted">History lookup failed: {r.history_error}</div>}
                      {r.processing_error?.startsWith('Tax-default') && <div className="badge small" style={{ marginTop: 4 }}>{r.processing_error}</div>}
                    </td>
                    <td className="small">
                      {links.length === 0 ? <span className="muted">No person to look up</span> : links.map((l) => (
                        <div key={l.who} style={{ marginBottom: 4 }}>
                          <div className="muted">{l.who}</div>
                          {l.items.map(([t, u]) => <a key={t} href={u} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>{t}</a>)}
                        </div>
                      ))}
                    </td>
                    <td style={{ minWidth: 340 }}>
                      <form action={fixAndRetry}>
                        <input type="hidden" name="id" value={r.id} />
                        <div className="fields" style={{ marginBottom: 6 }}>
                          <div style={{ gridColumn: 'span 2' }}><label>Street address</label><input name="raw_address" placeholder="123 Main St" /></div>
                          <div><label>City or ZIP</label><input name="raw_cityzip" /></div>
                          <div><label>or APN</label><input name="raw_apn" placeholder="000-000-00" /></div>
                        </div>
                        <button className="btn sm primary">Create lead</button>
                        <div className="muted small" style={{ marginTop: 4 }}>Either one works — the other is filled in from the county parcel map.</div>
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

      {skipped.length > 0 && (
        <section className="card table-wrap" style={{ marginBottom: 16 }}>
          <details>
            <summary><strong>Auto-skipped</strong> <span className="muted">· {skipped.length} in the last 60 days · foreclosed, deeded away, or priority under 15</span></summary>
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Filing</th><th>People</th><th>Why</th><th></th></tr></thead>
              <tbody>
                {skipped.map((r) => (
                  <tr key={r.id}>
                    <td className="small"><strong>{ev(r.source_type)}</strong><div className="muted">Doc {r.document_number} · {date(r.recorded_date)}</div></td>
                    <td className="small">{(r.people?.length ? r.people.map((p) => p.name) : [r.raw_owner_name]).filter(Boolean).join(' · ')}</td>
                    <td className="small">{r.processing_error.replace('Auto-skipped: ', '')}
                      <div>{(r.summary || []).slice(0, 3).map((x) => <span key={x} className="chip">{x}</span>)}</div></td>
                    <td><form action={restoreSkipped}><input type="hidden" name="id" value={r.id} /><button className="btn sm">Restore</button></form></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      )}

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
