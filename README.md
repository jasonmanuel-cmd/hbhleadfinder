# Harbison Buys Homes — Lead Finder

Distressed-property lead intelligence: pre-foreclosure, probate, tax-default and other motivated-seller
signals are ingested, deduplicated to one canonical property, scored, and worked from a private dashboard.

Built multi-state from day one: state law and county sources live in data (`state_rules`, `jurisdictions`,
`lead_sources`), not in code.

## Stack
- **Supabase Postgres** — schema, matching, scoring, queue and compliance guards (`supabase/migrations`)
- **Next.js 15 on Vercel** — dashboard (this repo root)

## How a lead flows
1. Record lands in `raw_lead_intake` (CSV import, single add, or a source connector). Raw payloads are never overwritten.
2. `process_raw_property_lead()` matches by **APN first, then normalized address**. Conflicts and ambiguous
   matches go to the Review queue — nothing is auto-merged.
3. `distress_events` keeps every signal's history; `recalculate_lead_score()` writes a 0–100 score and tier:
   Urgency 40 · Equity 25 · Condition 10 · Authority 10 · Exit 15 · minus Risk.
4. Paid enrichment is gated: valuation only for real distress, contact data only for Tier A/B.

## Compliance enforced in the database
- **Equity-purchase statutes** (e.g. Cal. Civ. Code §1695): owner-occupied 1–4 unit homes in active
  foreclosure are flagged, and deals **cannot** move to `offer_sent` / `under_contract` / `closed` until
  `compliance_reviewed` is set after attorney review.
- **Opt-outs**: logging `opted_out` marks the person do-not-contact; later outbound touches are rejected.
  Channel-level DNC / SMS / email opt-outs are enforced the same way.

## Dashboard
| Page | Purpose |
|---|---|
| Today | Tier A/B action list, follow-ups due, auctions in 30 days |
| Leads | Search / filter every property |
| Lead detail | Score breakdown, underwriting (70% rule), people with authority, touch log, deal + compliance |
| Add / Import | Single lead or CSV (idempotent re-imports) |
| Review | Records the matcher refused to guess on |
| Sources | Source → contract funnel, enrichment queue, jurisdictions |

CSV columns: `source,signal,state,county,apn,address,city,zip,owner,party_role,event_date,recorded_date,document_number,case_number,auction_date,amount_owed,source_record_id,source_url`
(required: source, signal, state, county, and apn or address).

## Setup
1. Apply `supabase/migrations/*.sql` in order.
2. Give the dashboard role a login (never commit this):
   `alter role hbh_dashboard with login password '<secret>';`
3. Set the env vars from `.env.example` in Vercel.
4. `npm install && npm run build`.

The dashboard connects as `hbh_dashboard`, a least-privilege role with RLS policies — never the service-role key.
Database connections use `prepare: false` and `max_pipeline: 0`; Supabase's transaction pooler hangs on pipelined queries.

## Adding a market
```sql
insert into state_rules (state, foreclosure_type, equity_purchase_law, equity_purchase_statute, rescission_business_days)
values ('AZ', 'nonjudicial', false, null, null);   -- research the state's rules first
insert into jurisdictions (state, county, fips, active) values ('AZ', 'Maricopa', '04013', true);
```
