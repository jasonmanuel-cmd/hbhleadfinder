import { sql } from '@/lib/db';
import { Flash, Tier } from '@/components/ui';
import { ev, date } from '@/lib/format';
import { personName, REQUIRED_SETTINGS, KIND } from '@/lib/letters';
import { saveSettings, markMailed } from './actions';

export const dynamic = 'force-dynamic';

export default async function Letters({ searchParams }) {
  const sp = await searchParams;
  const [settingsRows, queue] = await Promise.all([
    sql`select key, value from org_settings`,
    sql`select * from v_letter_queue limit 500`,
  ]);
  const s = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));
  const missing = REQUIRED_SETTINGS.filter((k) => !s[k]);
  const ready = queue.filter((r) => !r.hold_until);
  const held = queue.filter((r) => r.hold_until);

  return (
    <>
      <h1>Letters</h1>
      <p className="sub">Leads with a street address and a real signal, not written to in 21 days, fewer than 3 letters,
        not opted out. Print, mail, then mark them mailed so follow-ups get scheduled.</p>
      <Flash sp={sp} />

      <section className="card" style={{ marginBottom: 16 }}>
        <details open={missing.length > 0}>
          <summary><strong>Sender details</strong> {missing.length > 0
            ? <span className="badge flag small">Fill these in before printing</span>
            : <span className="muted small">· {s.letter_sender} · {s.letter_phone}</span>}</summary>
          <form action={saveSettings} style={{ marginTop: 12 }}>
            <div className="fields">
              <div><label>Company</label><input name="letter_company" defaultValue={s.letter_company || ''} /></div>
              <div><label>Your name (signs the letter) *</label><input name="letter_sender" defaultValue={s.letter_sender || ''} /></div>
              <div><label>Phone for replies *</label><input name="letter_phone" defaultValue={s.letter_phone || ''} /></div>
              <div><label>Email (optional)</label><input name="letter_email" defaultValue={s.letter_email || ''} /></div>
              <div><label>Return street address *</label><input name="letter_return_address" defaultValue={s.letter_return_address || ''} placeholder="PO Box 1234" /></div>
              <div><label>Return city, state ZIP *</label><input name="letter_city_line" defaultValue={s.letter_city_line || ''} placeholder="Bakersfield, CA 93301" /></div>
            </div>
            <button className="btn primary">Save</button>
            <span className="muted small" style={{ marginLeft: 10 }}>Use a phone you will answer. A PO box keeps your home address off 300 letters a month.</span>
          </form>
        </details>
      </section>

      <section className="card table-wrap" style={{ marginBottom: 16 }}>
        <form method="get" action="/letters/print" target="_blank">
          <div className="toolbar" style={{ marginBottom: 8 }}>
            <div style={{ flex: 2 }}><h2 style={{ margin: 0 }}>Ready to mail <span className="muted">· {ready.length}</span></h2>
              <div className="muted small">Foreclosure letters first. Uncheck anything you don't want in this batch.</div></div>
            <div><button className="btn primary" disabled={missing.length > 0 || !ready.length}>Print letters + labels</button></div>
            <div><button className="btn" formAction={markMailed} formMethod="post" formTarget="_self" disabled={!ready.length}>Mark checked as mailed</button></div>
          </div>
          {ready.length === 0 ? <div className="empty">Nothing ready. Leads need a street address — match filings on <a href="/review">Review</a>, or fill addresses on <a href="/sources">Sources</a>.</div> : (
            <table>
              <thead><tr><th></th><th></th><th>To</th><th>Property</th><th>Letter</th><th className="num">Sent</th></tr></thead>
              <tbody>
                {ready.map((r) => (
                  <tr key={r.property_id}>
                    <td><input type="checkbox" name="id" value={r.property_id} defaultChecked /></td>
                    <td><Tier t={r.lead_tier} /></td>
                    <td className="small">{(r.recipients || []).slice(0, 2).map(personName).join(' & ') || (r.decedent ? `Family of ${personName(r.decedent)}` : 'Current Owner')}</td>
                    <td className="small"><a href={`/leads/${r.property_id}`}>{r.address_line_1}</a><div className="muted">{r.city} {r.zip}</div></td>
                    <td className="small">{ev(r.primary_signal)} <span className="muted">· {KIND[r.primary_signal] || 'general'} letter</span>
                      {r.tax_owed ? <div className="muted">Taxes owed ${Number(r.tax_owed).toLocaleString()}</div> : null}</td>
                    <td className="num">{r.letters_sent}{r.last_letter && <div className="muted small">{date(r.last_letter)}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </form>
      </section>

      {held.length > 0 && (
        <section className="card table-wrap">
          <h2>Waiting out the 30 days after a death <span className="muted">· {held.length}</span></h2>
          <table>
            <thead><tr><th>To</th><th>Property</th><th>Mail after</th></tr></thead>
            <tbody>{held.map((r) => (
              <tr key={r.property_id}>
                <td className="small">{(r.recipients || []).slice(0, 2).map(personName).join(' & ') || 'Family'}</td>
                <td className="small"><a href={`/leads/${r.property_id}`}>{r.address_line_1}</a> <span className="muted">{r.city}</span></td>
                <td className="small">{date(r.hold_until)}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}
    </>
  );
}
