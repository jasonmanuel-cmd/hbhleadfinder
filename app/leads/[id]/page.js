import { notFound } from 'next/navigation';
import { sql } from '@/lib/db';
import { Tier, Flash, Select } from '@/components/ui';
import { money, date, dateTime, daysUntil, isoDate, ev, label,
         STAGES, EXITS, ROLES, CHANNELS, OUTREACH_STATUS } from '@/lib/format';
import { saveUnderwriting, addOwner, updateOwner, logOutreach, saveDeal } from './actions';

export const dynamic = 'force-dynamic';

const yn = (b) => (b === true ? 'yes' : b === false ? 'no' : '');

export default async function LeadPage({ params, searchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [[p]] = await Promise.all([sql`select * from properties where id = ${id}`]);
  if (!p) notFound();

  const [[score], events, owners, touches, [deal], jobs, [rules], dossiers] = await Promise.all([
    sql`select * from lead_scores where property_id = ${id}`,
    sql`select * from distress_events where property_id = ${id}
         order by coalesce(event_date, recorded_date, created_at::date) desc`,
    sql`select o.*, po.ownership_role, po.is_decision_maker from property_owners po
          join owners o on o.id = po.owner_id where po.property_id = ${id}
         order by po.is_decision_maker desc, o.full_name`,
    sql`select t.*, o.full_name from outreach t left join owners o on o.id = t.owner_id
         where t.property_id = ${id} order by t.attempted_at desc limit 50`,
    sql`select * from deals where property_id = ${id}`,
    sql`select enrichment_type, status, attempts, last_error from enrichment_jobs
         where property_id = ${id} order by created_at desc`,
    sql`select * from state_rules where state = ${p.state}`,
    sql`select d.*, i.source_type, i.raw_payload ->> 'document_number' as filing_doc
          from borrower_dossiers d join raw_lead_intake i on i.id = d.intake_id
         where i.property_id = ${id} order by d.fetched_at desc`,
  ]);

  const r = score?.score_reasoning || {};
  const arv = Number(p.estimated_arv ?? p.estimated_market_value) || null;
  const mao = arv && p.estimated_repair_cost != null ? arv * 0.7 - Number(p.estimated_repair_cost) : null;
  const debt = (Number(p.estimated_loan_balance) || 0) + (Number(p.estimated_other_liens) || 0);
  const nextAuction = events.map((e) => e.auction_date).filter((d) => d && daysUntil(d) >= 0).sort((a, b) => a - b)[0];

  return (
    <>
      <p className="small"><a href="/leads">← Leads</a></p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Tier t={score?.lead_tier} />
        <h1>{p.address_line_1 && !/^\s*(APN|ATN)\b/i.test(p.address_line_1) ? p.address_line_1 : `APN ${p.apn}`}</h1>
      </div>
      <p className="sub">
        {[p.city, p.county && `${p.county} County`, p.state, p.zip].filter(Boolean).join(', ')}
        {p.apn && <> · APN {p.apn}</>}
        {p.apn && p.state === 'CA' && p.county === 'Kern' && <> · <a href="https://www.kcttc.co.kern.ca.us/Payment/mainsearch.aspx" target="_blank" rel="noreferrer">Tax bill</a>
          {' '}· <a href={`https://maps.kerncounty.com/H5/index.html?viewer=KCPublic`} target="_blank" rel="noreferrer">Parcel map</a></>}
        {nextAuction && <> · <strong>Auction {date(nextAuction)} ({daysUntil(nextAuction)}d)</strong></>}
        {!nextAuction && score?.est_sale_date && <> · <strong>Est. earliest sale {date(score.est_sale_date)} ({daysUntil(score.est_sale_date)}d)</strong></>}
      </p>
      <Flash sp={sp} />
      {p.source_metadata?.apn_from === 'tax_default_name_match' && p.data_confidence !== 'manual' && (
        <div className="alert warn"><strong>Parcel matched by owner name.</strong> This filing was tied to APN {p.apn} because the same name
          is on the county's delinquent-tax list. Owners can hold more than one parcel — confirm the filing is for this property
          before mailing. Saving the underwriting form marks it confirmed.</div>
      )}

      {score?.equity_purchase_law_applies && (
        <div className="alert warn">
          <strong>Equity-purchase law likely applies.</strong> Owner-occupied (or unknown) home in active foreclosure
          {rules?.equity_purchase_statute ? <> — {rules.equity_purchase_statute}</> : null}
          {rules?.rescission_business_days ? <>, {rules.rescission_business_days}-business-day cancellation right</> : null}.
          Use only the attorney-approved contract. Offers stay blocked until compliance review is checked below.
          {rules?.foreclosure_consultant_statute && <> Don't offer "foreclosure help" services ({rules.foreclosure_consultant_statute}).</>}
        </div>
      )}

      {/* key forces fresh form defaults after every server action */}
      <div className="grid two" key={Date.now()}>
        <div className="stack">
          {/* Score */}
          <section className="card">
            <h2>Score {score ? <span className="muted">· {score.total_score}/100</span> : null}</h2>
            {score ? (
              <>
                <ScoreRow k="Urgency" v={score.urgency_score} max={40} />
                <ScoreRow k="Equity" v={score.equity_score} max={25} />
                <ScoreRow k="Condition" v={score.condition_score} max={10} />
                <ScoreRow k="Authority" v={score.authority_score} max={10} />
                <ScoreRow k="Exit" v={score.exit_score} max={15} />
                {score.risk_score > 0 && <ScoreRow k="Risk" v={-score.risk_score} max={40} neg />}
                <p className="muted small" style={{ marginBottom: 0 }}>
                  Equity: {typeof r.equity_pct === 'number' ? `${Math.round(r.equity_pct * 100)}%`
                    : `unknown — add value + loan balance${r.equity_hint && r.equity_hint !== 'unknown' ? ` (recorded history suggests ${r.equity_hint})` : ''}`}
                  {' · '}Foreclosure active: {r.foreclosure_active ? 'yes' : 'no'}
                  {r.risk_no_cash_margin && ' · No cash margin at 70% rule'}
                  {r.risk_multi_owner_no_decision_maker && ' · Multiple owners, no decision-maker'}
                  {r.risk_auction_imminent_unverified && ' · Auction ≤7 days, title unverified'}
                  {r.risk_bankruptcy && ' · Bankruptcy on record'}
                  {r.risk_solar_lien && ' · Solar lien/lease'}
                  {r.risk_recorded_liens && ` · ${r.risk_recorded_liens} unreleased lien(s)`}
                  {r.risk_already_transferred && ' · Already foreclosed or deeded away'}
                </p>
              </>
            ) : <div className="empty">Not scored yet.</div>}
          </section>

          {/* Underwriting */}
          <section className="card">
            <h2>Underwriting</h2>
            <dl className="kv" style={{ marginBottom: 14 }}>
              <dt>Max offer (70% rule)</dt><dd>{mao != null ? money(mao) : '—'} <span className="muted small">= ARV × 0.70 − repairs</span></dd>
              <dt>Known debt</dt><dd>{p.estimated_loan_balance != null ? money(debt) : '—'}</dd>
              <dt>Spread</dt><dd>{mao != null && p.estimated_loan_balance != null ? money(mao - debt) : '—'}</dd>
            </dl>
            <form action={saveUnderwriting}>
              <input type="hidden" name="property_id" value={p.id} />
              <div className="fields">
                <Field n="estimated_market_value" l="As-is value" v={p.estimated_market_value} />
                <Field n="estimated_arv" l="ARV" v={p.estimated_arv} />
                <Field n="estimated_repair_cost" l="Repairs" v={p.estimated_repair_cost} />
                <Field n="estimated_loan_balance" l="Loan balance" v={p.estimated_loan_balance} />
                <Field n="estimated_other_liens" l="Other liens / taxes" v={p.estimated_other_liens} />
              </div>
              <div className="fields">
                <div><label>Condition (1 good – 5 rough)</label><Select name="condition_rating" options={['1', '2', '3', '4', '5']} value={p.condition_rating?.toString()} blank="—" /></div>
                <div><label>Owner-occupied</label><Select name="owner_occupied" options={['yes', 'no']} value={yn(p.owner_occupied)} blank="Unknown" /></div>
                <div><label>Absentee owner</label><Select name="absentee_owner" options={['yes', 'no']} value={yn(p.absentee_owner)} blank="Unknown" /></div>
                <Field n="units" l="Units" v={p.units} />
                <Field n="property_type" l="Type" v={p.property_type} text />
              </div>
              <div className="toolbar" style={{ marginBottom: 0 }}>
                <label className="check"><input type="checkbox" name="vacant_signal" defaultChecked={p.vacant_signal} /> Vacant</label>
                <label className="check"><input type="checkbox" name="title_verified" defaultChecked={p.title_verified} /> Prelim title reviewed</label>
                <button className="btn primary">Save & rescore</button>
              </div>
            </form>
          </section>

          {/* Outreach */}
          <section className="card">
            <h2>Log a touch</h2>
            <form action={logOutreach}>
              <input type="hidden" name="property_id" value={p.id} />
              <div className="fields">
                <div><label>Contact</label>
                  <select name="owner_id" defaultValue="">
                    <option value="">— none / unknown —</option>
                    {owners.map((o) => <option key={o.id} value={o.id}>{o.full_name}{o.do_not_contact ? ' (DNC)' : ''}</option>)}
                  </select></div>
                <div><label>Channel</label><Select name="channel" options={CHANNELS} value="call" /></div>
                <div><label>Direction</label><Select name="direction" options={['outbound', 'inbound']} value="outbound" /></div>
                <div><label>Result</label><Select name="status" options={OUTREACH_STATUS} value="attempted" /></div>
                <div><label>Who answered</label><Select name="contact_role" options={['owner', 'executor', 'heir', 'attorney', 'tenant', 'wrong_contact']} blank="—" /></div>
                <div><label>Next follow-up</label><input type="date" name="next_follow_up_at" /></div>
              </div>
              <div className="fields" style={{ gridTemplateColumns: '1fr' }}>
                <div><label>Notes — what does the seller actually need?</label><textarea name="notes" /></div>
              </div>
              <button className="btn primary">Log touch</button>
            </form>
            <h2 style={{ marginTop: 20 }}>History</h2>
            {touches.length === 0 ? <div className="empty">No touches yet.</div> : (
              <ul className="timeline">
                {touches.map((t) => (
                  <li key={t.id}>
                    <strong>{label(t.channel)}</strong> · {label(t.status)} {t.full_name && <>· {t.full_name}</>}
                    <span className="muted small"> · {dateTime(t.attempted_at)}</span>
                    {t.notes && <div className="small">{t.notes}</div>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="stack">
          {/* Deal */}
          <section className="card">
            <h2>Deal</h2>
            <form action={saveDeal}>
              <input type="hidden" name="property_id" value={p.id} />
              <div className="fields">
                <div><label>Stage</label><Select name="stage" options={STAGES} value={deal?.stage} /></div>
                <div><label>Best exit</label><Select name="best_exit" options={EXITS} value={deal?.best_exit} blank="—" /></div>
                <Field n="offer_amount" l="Offer" v={deal?.offer_amount} />
                <div><label>Follow-up</label><input type="date" name="next_follow_up_at" defaultValue={isoDate(deal?.next_follow_up_at)} /></div>
                <Field n="assigned_to" l="Assigned to" v={deal?.assigned_to} text />
              </div>
              <div className="fields" style={{ gridTemplateColumns: '1fr' }}>
                <div><label>Seller's goal</label><textarea name="seller_goal" defaultValue={deal?.seller_goal || ''} /></div>
                <div><label>Compliance notes</label><textarea name="compliance_notes" defaultValue={deal?.compliance_notes || ''}
                  placeholder="Attorney, contract version, cancellation notice delivered…" /></div>
              </div>
              <div className="toolbar" style={{ marginBottom: 0 }}>
                <label className="check"><input type="checkbox" name="compliance_reviewed" defaultChecked={deal?.compliance_reviewed} /> Attorney/compliance reviewed</label>
                <button className="btn primary">Save deal</button>
              </div>
            </form>
          </section>

          {/* Signals */}
          <section className="card">
            <h2>Distress signals</h2>
            {events.length === 0 ? <div className="empty">None.</div> : (
              <ul className="timeline">
                {events.map((e) => (
                  <li key={e.id}>
                    <strong>{ev(e.event_type)}</strong> <span className="muted small">· {date(e.event_date || e.recorded_date)} · {e.source_name}</span>
                    <div className="small muted">
                      {[e.document_number && `Doc ${e.document_number}`, e.case_number && `Case ${e.case_number}`,
                        e.auction_date && `Auction ${date(e.auction_date)}`, e.amount_owed && `Owed ${money(e.amount_owed)}`]
                        .filter(Boolean).join(' · ')}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Recorder history */}
          {dossiers.length > 0 && (
            <section className="card">
              <h2>Recorded history <span className="muted small">· county index, by owner name</span></h2>
              {dossiers.map((d) => (
                <div key={d.intake_id} style={{ marginBottom: 10 }}>
                  <div className="muted small">{d.names.join(', ')} · {d.doc_count} documents{d.truncated ? ' (common name — verify)' : ''} · from {ev(d.source_type)} {d.filing_doc}</div>
                  {d.error ? <div className="muted small">Lookup failed: {d.error}</div> : (
                    <>
                      <div style={{ margin: '6px 0' }}>{(d.summary || []).map((x) => <span key={x} className="chip">{x}</span>)}</div>
                      <details>
                        <summary className="small">All {Math.min(d.doc_count, 60)} documents</summary>
                        <table><tbody>
                          {(d.docs || []).map((x) => (
                            <tr key={x.doc}><td className="small">{x.date}</td><td className="small">{x.type}</td>
                              <td className="small muted">{x.parties.join(' · ')}</td></tr>
                          ))}
                        </tbody></table>
                      </details>
                    </>
                  )}
                </div>
              ))}
              <p className="muted small" style={{ marginBottom: 0 }}>Screening only. Names can collide — confirm loans and liens with a preliminary title report before any offer.</p>
            </section>
          )}

          {/* People */}
          <section className="card">
            <h2>People with authority</h2>
            {owners.length === 0 && <div className="empty">No owners linked yet.</div>}
            {owners.map((o) => (
              <details key={o.id} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8, marginBottom: 8 }}>
                <summary>
                  {o.full_name} <span className="muted small">· {label(o.ownership_role)}</span>
                  {o.is_decision_maker && <span className="chip" style={{ marginLeft: 6 }}>Decision-maker</span>}
                  {o.do_not_contact && <span className="badge flag small" style={{ marginLeft: 6 }}>DNC</span>}
                </summary>
                <form action={updateOwner}>
                  <input type="hidden" name="property_id" value={p.id} />
                  <input type="hidden" name="owner_id" value={o.id} />
                  <div className="fields">
                    <div><label>Role</label><Select name="ownership_role" options={ROLES} value={o.ownership_role} /></div>
                    <Field n="phone" l="Phone" v={o.phone} text />
                    <Field n="email" l="Email" v={o.email} text />
                    <Field n="mailing_address" l="Mailing address" v={o.mailing_address} text />
                  </div>
                  <div className="toolbar" style={{ marginBottom: 0 }}>
                    <label className="check"><input type="checkbox" name="is_decision_maker" defaultChecked={o.is_decision_maker} /> Can sign</label>
                    <label className="check"><input type="checkbox" name="do_not_contact" defaultChecked={o.do_not_contact} /> Do not contact</label>
                    <label className="check"><input type="checkbox" name="do_not_call" defaultChecked={o.do_not_call} /> No calls</label>
                    <label className="check"><input type="checkbox" name="sms_opt_out" defaultChecked={o.sms_opt_out} /> No SMS</label>
                    <label className="check"><input type="checkbox" name="email_opt_out" defaultChecked={o.email_opt_out} /> No email</label>
                    <button className="btn sm">Save</button>
                  </div>
                </form>
              </details>
            ))}
            <details>
              <summary>+ Add person</summary>
              <form action={addOwner}>
                <input type="hidden" name="property_id" value={p.id} />
                <div className="fields">
                  <Field n="full_name" l="Full name *" text />
                  <div><label>Role</label><Select name="ownership_role" options={ROLES} value="owner" /></div>
                  <Field n="phone" l="Phone" text />
                  <Field n="email" l="Email" text />
                  <Field n="mailing_address" l="Mailing address" text />
                </div>
                <div className="toolbar" style={{ marginBottom: 0 }}>
                  <label className="check"><input type="checkbox" name="is_decision_maker" /> Can sign</label>
                  <button className="btn sm primary">Add</button>
                </div>
              </form>
            </details>
          </section>

          {jobs.length > 0 && (
            <section className="card">
              <h2>Enrichment queue</h2>
              <table><tbody>
                {jobs.map((j, i) => (
                  <tr key={i}><td>{label(j.enrichment_type)}</td><td>{label(j.status)}</td>
                    <td className="muted small">{j.last_error || ''}</td></tr>
                ))}
              </tbody></table>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function ScoreRow({ k, v, max, neg }) {
  const pct = Math.max(0, Math.min(100, (Math.abs(v) / max) * 100));
  return (
    <div className="score-row">
      <span className="muted">{k}</span>
      <div className="bar"><span style={{ width: `${pct}%`, background: neg ? 'var(--danger)' : undefined }} /></div>
      <span className="num" style={{ textAlign: 'right' }}>{v}</span>
    </div>
  );
}

function Field({ n, l, v, text }) {
  return (
    <div>
      <label>{l}</label>
      <input name={n} defaultValue={v ?? ''} inputMode={text ? undefined : 'decimal'} />
    </div>
  );
}
