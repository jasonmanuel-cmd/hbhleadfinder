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
It reads the county's public *Search by Document Class* index for the last 10 days (overlapping re-reads; duplicates
skipped by document number):

| Class | Signal | Kind |
|---|---|---|
| 0043 Default Notice | `notice_of_default` | lead |
| 0038 Notice of Trustee's Sale | `notice_of_trustee_sale` | lead |
| 0703 Affidavit – TOD (decedent marked DECD) | `tod_affidavit` | lead — heir is the decision-maker |
| 0028 Affidavit – Joint Tenants | `death_joint_tenant` | lead — surviving owner |
| 0184 / 0183 Letters Testamentary / Administration | `letters_testamentary` | lead — executor/administrator |
| 0044 Cancel Default Notice | `notice_of_rescission` | attach-only |
| 0059 / 0060 / 0061 Tax liens, 0040 Abstract Judgment | `tax_lien`, `judgment_lien` | attach-only |

The index gives **document number, date and names only — no APN or address.**
- Names that match an owner already tracked in the county attach to that property automatically.
- Attach-only filings (rescissions, liens, judgments) are ignored unless they match a tracked property.
- Everything else lands in **Review → Find the parcel**.

### Owner-history dossiers (free)
For every lead filing the collector searches the county's grantor/grantee index by name and builds a dossier:
loan dates, loans vs. reconveyances, loan modifications, earlier default episodes (last 15 years, >1 year before this filing),
solar UCC filings, unreleased tax liens/judgments, recorded deaths, and transfers or trustee's deeds after the filing.
It yields an equity hint (`high` / `moderate` / `thin` / `unverified` for common names), a 0–100 priority that orders the
Find-the-parcel queue, and feeds the lead score (provisional equity, lien/solar risk, "already gone" kill switch).
Screening only — names collide; confirm with a preliminary title report.

### Timeline and follow-ups
`estimated_sale_date()` gives the earliest likely sale: scheduled auction → NTS + 21 days → NOD + 111 days.
New leads get an automatic first follow-up: NTS 1 day, NOD 2 days, letters 14 days, deaths 30 days (letter only).

"Pull now" and "Build histories" on the Sources page run the same jobs on demand; runs are logged in `source_runs`.

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
