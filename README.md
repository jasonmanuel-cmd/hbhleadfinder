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

## Automatic feed: Kern County Recorder (free)
A daily Vercel Cron (`vercel.json`, 8am Pacific) calls `/api/cron/kern_recorder` with `Authorization: Bearer $CRON_SECRET`.
It reads the county's public *Search by Document Class* index for the last 10 days (re-reads overlap; duplicates are skipped by document number):

| Class | Signal |
|---|---|
| 0043 Default Notice | `notice_of_default` |
| 0038 Notice of Trustee's Sale | `notice_of_trustee_sale` |
| 0044 Cancel Default Notice | `notice_of_rescission` |

The index gives **document number, date and borrower names only — no APN or address.** So:
- If a borrower name matches an owner already tracked in that county, the filing attaches to that property automatically
  (e.g. an NTS following an NOD you already have, or a rescission that ends the foreclosure).
- Otherwise it lands in **Review → Find the parcel**. Look the owner up (ParcelQuest / parcel maps), enter the APN or address,
  and the lead is created, scored, and flagged for the equity-purchase statute.
- Rescissions with no tracked property are ignored.

"Pull now" on the Sources page runs the same collector on demand. Every run is logged in `source_runs`.

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
3. Set the env vars from `.env.example` in Vercel (plus `CRON_SECRET` for scheduled feeds).
4. `npm install && npm run build`.

The dashboard connects as `hbh_dashboard`, a least-privilege role with RLS policies — never the service-role key.
Database connections use `prepare: false` and `max_pipeline: 0`; Supabase's transaction pooler hangs on pipelined queries.

## Adding a market
```sql
insert into state_rules (state, foreclosure_type, equity_purchase_law, equity_purchase_statute, rescission_business_days)
values ('AZ', 'nonjudicial', false, null, null);   -- research the state's rules first
insert into jurisdictions (state, county, fips, active) values ('AZ', 'Maricopa', '04013', true);
```
