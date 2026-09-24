import { sql } from '@/lib/db';
import { Flash, Select } from '@/components/ui';
import { EVENT_TYPES, ev } from '@/lib/format';
import { addLead, importCsv } from './actions';

export const dynamic = 'force-dynamic';

const TEMPLATE = 'source,signal,state,county,apn,address,city,zip,owner,party_role,event_date,recorded_date,document_number,case_number,auction_date,amount_owed,source_record_id,source_url';

export default async function AddPage({ searchParams }) {
  const sp = await searchParams;
  const [sources, jurisdictions] = await Promise.all([
    sql`select id, source_type, notes from lead_sources where active order by id`,
    sql`select state, county from jurisdictions order by active desc, state, county`,
  ]);
  const def = jurisdictions[0] || { state: 'CA', county: 'Kern' };

  return (
    <>
      <h1>Add / Import</h1>
      <p className="sub">Every lead goes into raw intake first, then gets matched by APN or address, deduplicated, scored and queued for enrichment.</p>
      <Flash sp={sp} />
      <div className="grid two">
        <section className="card">
          <h2>Add one lead</h2>
          <form action={addLead}>
            <div className="fields">
              <div><label>Source *</label><Select name="source" options={sources.map((s) => s.id)} value="manual_entry" /></div>
              <div><label>Signal *</label><Select name="signal" options={EVENT_TYPES} value="notice_of_default" labels={ev} /></div>
              <div><label>State *</label><input name="state" defaultValue={def.state} maxLength={2} required /></div>
              <div><label>County *</label><input name="county" defaultValue={def.county} list="counties" required />
                <datalist id="counties">{jurisdictions.map((j) => <option key={j.state + j.county} value={j.county} />)}</datalist></div>
            </div>
            <div className="fields">
              <div style={{ gridColumn: 'span 2' }}><label>Street address</label><input name="address" placeholder="123 Main St" /></div>
              <div><label>City</label><input name="city" /></div>
              <div><label>ZIP</label><input name="zip" inputMode="numeric" /></div>
              <div><label>APN</label><input name="apn" /></div>
            </div>
            <div className="fields">
              <div><label>Owner / party name</label><input name="owner" /></div>
              <div><label>Their role</label><Select name="party_role" options={['owner', 'executor', 'administrator', 'heir', 'trustee', 'decedent', 'co_owner']} value="owner" /></div>
              <div><label>Event date</label><input type="date" name="event_date" /></div>
              <div><label>Auction date</label><input type="date" name="auction_date" /></div>
            </div>
            <div className="fields">
              <div><label>Document #</label><input name="document_number" /></div>
              <div><label>Case #</label><input name="case_number" /></div>
              <div><label>Amount owed</label><input name="amount_owed" inputMode="decimal" /></div>
              <div><label>Source URL</label><input name="source_url" /></div>
            </div>
            <div className="fields" style={{ gridTemplateColumns: '1fr' }}><div><label>Notes</label><textarea name="notes" /></div></div>
            <button className="btn primary">Add lead</button>
          </form>
        </section>

        <div className="stack">
          <section className="card">
            <h2>Import CSV</h2>
            <form action={importCsv}>
              <label>CSV file</label>
              <input type="file" name="file" accept=".csv,text/csv" />
              <p className="muted small">…or paste rows (with header):</p>
              <textarea name="csv" placeholder={TEMPLATE} style={{ minHeight: 120, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
              <div style={{ marginTop: 12 }}><button className="btn primary">Import</button></div>
            </form>
          </section>
          <section className="card small">
            <h2>CSV columns</h2>
            <p style={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>{TEMPLATE}</p>
            <p><strong>Required:</strong> source, signal, state, county, and apn <em>or</em> address. Dates as YYYY-MM-DD.
              Re-importing the same file is safe — duplicates are skipped.</p>
            <p><strong>source</strong> must be one of: {sources.map((s) => <code key={s.id} className="chip">{s.id}</code>)}</p>
            <p><strong>signal</strong> must be one of: {EVENT_TYPES.map((t) => <code key={t} className="chip">{t}</code>)}</p>
          </section>
        </div>
      </div>
    </>
  );
}
