import { sql } from '@/lib/db';
import { buildLetter, REQUIRED_SETTINGS } from '@/lib/letters';
import PrintButton from './PrintButton';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f-]{36}$/i;

export default async function PrintLetters({ searchParams }) {
  const sp = await searchParams;
  const ids = [].concat(sp.id || []).filter((x) => UUID.test(x)).slice(0, 300);
  const [settingsRows, rows] = await Promise.all([
    sql`select key, value from org_settings`,
    ids.length ? sql`select * from v_letter_queue where property_id in ${sql(ids)} and hold_until is null` : [],
  ]);
  const s = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));
  const missing = REQUIRED_SETTINGS.filter((k) => !s[k]);
  if (missing.length) return <div className="card">Fill in the sender details on the Letters page first.</div>;
  if (!rows.length) return <div className="card">No letters selected.</div>;
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
  const letters = rows.map((r) => ({ id: r.property_id, ...buildLetter(r, s) }));

  return (
    <div className="print-root">
      <div className="no-print card" style={{ marginBottom: 16 }}>
        <strong>{letters.length} letters</strong> and {Math.ceil(letters.length / 30)} sheet(s) of Avery 5160 address labels.
        Print on plain paper, then labels on the label sheets. After mailing, go back to Letters and press “Mark checked as mailed”.
        {' '}<PrintButton />
      </div>

      {letters.map((l) => (
        <article key={l.id} className="letter">
          <header className="letter-head">
            <div className="letter-co">{l.company}</div>
            <div>{s.letter_return_address} · {s.letter_city_line} · {s.letter_phone}{s.letter_email ? ` · ${s.letter_email}` : ''}</div>
          </header>
          <p>{today}</p>
          <p className="letter-addr">{l.to}<br />{l.street}<br />{l.place}</p>
          <p>Dear {l.greet},</p>
          {l.body.map((para, i) => <p key={i}>{para}</p>)}
          <p>Sincerely,</p>
          <p className="letter-sig">{l.sender}<br />{l.company}<br />{s.letter_phone}</p>
          <p className="letter-fine">{l.fine}</p>
        </article>
      ))}

      {Array.from({ length: Math.ceil(letters.length / 30) }, (_, sheet) => (
        <section key={sheet} className="labels">
          {letters.slice(sheet * 30, sheet * 30 + 30).map((l) => (
            <div key={l.id} className="label">{l.to}<br />{l.street}<br />{l.place}</div>
          ))}
        </section>
      ))}
    </div>
  );
}
