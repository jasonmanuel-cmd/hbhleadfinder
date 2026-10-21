# Harbison Buys Homes — Lead Finder

Distressed-property lead intelligence: pre-foreclosure, probate, tax-default and other motivated-seller
signals are ingested, deduplicated to one canonical property, scored, and worked from a private dashboard.

Built multi-state from day one: state law and county sources live in data (`state_rules`, `jurisdictions`,
`lead_sources`), not in code.

## Stack
- **Supabase Postgres** — schema, matching, scoring, queue and compliance guards (`supabase/migrations`)
- **Next.js 16 on Vercel** — dashboard (this repo root)

## How a lead flows
1. Record lands in `raw_lead_intake` (CSV import, single add, or a source connector). Raw payloads are never overwritten.
2. `process_raw_property_lead()` matches by **APN first, then normalized address**. Conflicts and ambiguous
   matches go to the Review queue — nothing is auto-merged.
3. `distress_events` keeps every signal's history; `recalculate_lead_score()` writes a 0–100 score and tier:
   Urgency 40 · Equity 25 · Condition 10 · Authority 10 · Exit 15 · minus Risk.
4. Paid enrichment is gated: valuation only for real distress, contact data only for Tier A/B.
5. Enrichment is queued, not assumed: a valuation arrives from a provider, and until it does the score uses the
   recorded owner history as a **provisional** equity.

## Compliance enforced in the database
- **Equity-purchase statutes** (e.g. Cal. Civ. Code §1695): owner-occupied 1–4 unit homes in active
  foreclosure are flagged, and deals **cannot** move to `offer_sent` / `under_contract` / `closed` until
  `compliance_reviewed` is set after attorney review.
- **Opt-outs**: logging `opted_out` marks the person do-not-contact; later outbound touches are rejected.
  Channel-level DNC / SMS / email opt-outs are enforced the same way.

## Automatic feed: Kern County Recorder (free)
A daily Vercel Cron (`vercel.json`, 8am Pacific / 7am during Pacific standard time) calls `/api/cron/kern_recorder` with `Authorization: Bearer $CRON_SECRET`.
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

### Provisional equity (so the feed can fill Tier A on its own)
A property with no valuation and no loan balance scored **0 for equity**, and equity is worth 25 points — so a
lead straight off the recorder feed could never reach Tier A (≥70). It topped out at 50, in Tier B.
The recorded owner history already says how much equity a property probably has, so the scorer now reads it:
a `high` hint counts 20 points, a `moderate` hint 10 — the bottom of the band the hint implies, because a
recorded history is weaker evidence than a valuation.

- A **truncated** dossier is not counted: it was cut short because the county had more documents than we read.
- The score records `equity_source` = `underwritten` | `recorded_history` | `unknown`, and `lead_scores.equity_provisional`.
  The dashboard marks a provisional equity as provisional, so a guess is never presented as a valuation.
- A real valuation replaces it: once value and balance arrive, the equity is underwritten and the provisional flag clears.

| Lead | Before | After |
|---|---|---|
| Feed lead, strong recorded history | 50 · Tier B | **70 · Tier A** |
| Feed lead, moderate recorded history | 50 · Tier B | 60 · Tier B |
| Feed lead, no history | 50 · Tier B | 50 · Tier B |
| Feed lead, truncated history | 50 · Tier B | 50 · Tier B |
| Underwritten (400k value / 200k balance) | 75 · Tier A | 75 · Tier A |

## Enrichment worker
The database has always enqueued enrichment jobs (one per new lead) and had the whole queue lifecycle in SQL —
claim, back off, fail, release stale locks. **Nothing consumed them.** The jobs piled up, one per lead, and the
score never got the value and balance it needs.

`lib/enrichment/index.js` is that consumer. It claims jobs type by type, hands each one to a provider, writes
only the columns on its allow-list, and lets the database re-score the property. Failures back off
(15m → 2h → 1d, four attempts) instead of disappearing; a job nobody can service yet is **skipped**, not failed.

```bash
# the daily run (same CRON_SECRET as the other feeds)
curl -H "Authorization: Bearer $CRON_SECRET" "https://your-app/api/cron/enrichment?types=valuation,parcel&limit=10"
```

There is also a **Work the queue** button on the Sources page that runs it on demand.

| Provider | Cost | What it fills |
|---|---|---|
| `assessor` | free | Assessed value, sqft, year built, units, beds/baths — from the county's own parcel layer |
| `webhook` | paid | Whatever your vendor returns — the loan balance, the contact data, the title facts |

The paid adapter posts the job to `ENRICHMENT_PROVIDER_URL` with `Authorization: Bearer $ENRICHMENT_PROVIDER_KEY`
and reads the JSON reply; a reply of `{"skipped": "..."}` means "not now". The `attom_id` / `regrid_id` columns
are already on `properties` for the vendors that use them.

**The assessor provider never turns an assessed value into a market value.** In California the assessed value is
the Proposition 13 figure — a floor, not the market — and using it as one would quietly sink good properties in the
ranking. Set `MARKET_VALUE_FROM_ASSESSED=1.15` if you want that approximation; it is recorded as an estimate
(`data_confidence = 'assessor_estimate'`).

The free county can give parcel facts but **not money**: the grantor/grantee index carries document numbers, dates
and names, never dollar amounts. The loan balance — the other half of equity — needs a paid provider.

### Timeline and follow-ups
`estimated_sale_date()` gives the earliest likely sale: scheduled auction → NTS + 21 days → NOD + 111 days.
New leads get an automatic first follow-up: NTS 1 day, NOD 2 days, letters 14 days, deaths 30 days (letter only).

"Pull now" and "Build histories" on the Sources page run the same jobs on demand; runs are logged in `source_runs`.

## Pulling the feed from the command line

```bash
npm run pull            # the last 10 days, into the database
npm run pull -- --days 30
npm run pull:check      # no database, no writes: is the county reachable and does the parser still fit?
```

`pull:check` is the canary. When the pipeline goes quiet, run it: it prints what each document
class returned and tells you whether the county changed its pages or you simply had no filings.

**If this machine cannot reach the county site** — a firewall, a sandbox, a laptop offline at the
time — the feed can still be brought in by hand, because the county's index is public:

1. Open the county's *Search by Document Class* in your own browser and run the search.
2. Save the **results** page (the list of documents) as HTML.
3. Drop it on **Sources → Import a saved county results page**, or
   `npm run pull -- --file /path/to/page.html`.

It goes through the same parser, the same class rules and the same ingest pipeline as the live
feed, so it is the same data — it just arrived by a different road. The document class is worked
out from the page itself; you do not have to say which one it is.

## When the feed cannot run

The live feed reads the county's public site over the network. If the server cannot reach it,
the pull fails, the failure is recorded in `source_runs`, and **the dashboard says so** — a red
banner on Today, a red banner on Sources, and the last run's status under each feed. "fetch failed"
is never shown on its own; it is turned into something actionable:

> the county site could not be reached from this server — The server has no outbound network
> access to it. Check the firewall, the proxy, or the allow-list.

The banner also says plainly that what you are looking at is the **last data that came in**, not
today's. A feed that goes quiet is the failure mode nobody notices.

**The dashboard still works when the feed cannot.** Two ways in, both local:

- **Save the county's results page** and import it (see above). Real county filings.
- **Import a CSV** on [Add / Import](/add). The path is entirely local — it goes through the
  database, not the network — and it deduplicates on the source and record id, so re-importing
  the same file is safe. Column list is under *Dashboard* above.

## Demo data is labelled as demo data

`npm run db:seed:demo` seeds a book of practice business — seven Kern leads with made-up owners
and addresses, six letters, a follow-up history. Every seeded property is marked
`data_confidence = 'demo'`, and the dashboard **says so**: a banner on Today and on Sources tells
you how many of the properties on screen are sample data, and a **Clear the demo properties**
button removes them and everything hanging off them (scores, events, letters, touches).

It only ever deletes rows marked `demo`, so on a database with real leads it is a no-op. Nobody
should ever mail a letter to a made-up owner by accident.

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

## Run it locally (one command)

```bash
npm install
npm run dev:local
```

That is the whole thing. It downloads a real PostgreSQL 18 the first time, starts it in `./.localdb`,
applies every migration, seeds a book of demo leads, and starts the dashboard against it:

**http://localhost:3000** — sign in with the password `lead-desk` (override with `DASHBOARD_PASSWORD`).

No account, no Docker, no Supabase, no API keys. The database is the same engine you run in production
(Postgres 18 with plpgsql, RLS and triggers), so what you see locally is what you get.

The individual pieces, if you want them separately:

```bash
npm run db:local        # just the database; prints the DATABASE_URL to use
npm run db:migrate      # apply the migrations to any Postgres (DATABASE_URL)
npm run db:migrate -- --status
npm run db:seed:demo    # fill a database with demo leads
npm run dev             # the dashboard on its own
```

## Deploy to production

1. Create a Postgres database (Supabase is the easiest). Apply the schema to it:
   ```bash
   DATABASE_URL="postgresql://..." npm run db:migrate
   ```
   This is safe to re-run — it keeps a `schema_migrations` ledger and skips what is already applied.
   It creates the `anon` / `authenticated` / `service_role` roles first if they are missing, so it works
   on a plain Postgres as well as on Supabase.
2. Give the dashboard role a login (never commit this):
   `alter role hbh_dashboard with login password '<secret>';`
3. Set the env vars from `.env.example` in Vercel (plus `CRON_SECRET` for scheduled feeds):
   `DATABASE_URL`, `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `CRON_SECRET`.
4. `npm run build` and deploy.

The dashboard connects as `hbh_dashboard`, a least-privilege role with RLS policies — never the service-role key.
Database connections use `prepare: false` and `max_pipeline: 0`; Supabase's transaction pooler hangs on pipelined queries.

## Development
```bash
npm run dev:local      # database + dashboard together (the one command above)
npm run dev            # dashboard on :3000
npm test               # database contract tests + collector unit tests
npm run build          # production build
```

`npm test` needs no database and no Docker: it applies every migration to a real Postgres engine
(PGlite — Postgres compiled to WASM) and then checks the rules the business depends on — matching,
scoring, the equity-purchaser compliance guard, do-not-contact enforcement, and the letter queue.
`test/db.test.mjs` covers the database; `test/collectors.test.mjs` covers the county HTML parser,
the name formatter and the CSV reader; `test/enrichment.test.mjs` covers the enrichment worker and
the provisional-equity rule.

Auth lives in `proxy.js` (Next 16's name for the old `middleware.js`). Every page and API route
requires the session cookie; `/api/cron/*` authenticates with `CRON_SECRET` instead.

## Adding a market
```sql
insert into state_rules (state, foreclosure_type, equity_purchase_law, equity_purchase_statute, rescission_business_days)
values ('AZ', 'nonjudicial', false, null, null);   -- research the state's rules first
insert into jurisdictions (state, county, fips, active) values ('AZ', 'Maricopa', '04013', true);
```
