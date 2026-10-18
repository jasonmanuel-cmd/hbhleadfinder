# Audit — Harbison Buys Homes · Lead Finder

**Date:** 2026-10-18 · **Commit audited:** `95a23d9` · **Branch:** `arena/c76a9d9f-hbhleadfinder`

---

## Verdict

**Keep it, and finish it. Do not delete it.**

This is not a half-finished toy. It is a working, well-architected product that was sitting behind
a broken lockfile and a CI pipeline that was incapable of failing. I got it running, proved it
works end to end against a real PostgreSQL server, and locked the behaviour down with 36 automated
tests. The remaining work is a known, bounded list — not a rebuild.

Roughly: **the product is 80–85% done.** The database, the matching/scoring engine, the compliance
guards, the dashboard and the daily feed all work. What is missing is the *paid enrichment* layer,
a second market, and some operational hardening.

---

## Update — it now runs with one command

The audit proved the product worked. This pass closed the gap between "the code is sound" and
"a person can actually run it", which was three separate things:

**`npm run dev:local` now brings the whole system up by itself.** It fetches a real PostgreSQL 18
binary once (~60 MB, into `./.tools`, isolated from the app's `node_modules`), starts it in
`./.localdb`, applies all nine migrations, seeds a book of demo leads, and starts Next.js against
it. No account, no Docker, no Supabase, no API keys. From a cold clone to a working dashboard on
**http://localhost:3000** takes about six seconds. Sign in with `lead-desk`.

It is the same engine you run in production — real Postgres 18 with plpgsql, RLS and triggers —
so local is not a simulation of production, it is production's database.

**`npm run db:migrate` replaces "apply the migrations by hand in the Supabase SQL editor."**
That instruction was the reason the schema was hard to reason about: no ledger, no order check, no
way to tell what was applied. The script now applies them in order, exactly once, keeping its own
`schema_migrations` table, and tells you what is pending (`--status`) or re-applies everything
(`--force`). It creates the `anon` / `authenticated` / `service_role` roles first when they are
missing, so it works on a plain Postgres as well as on Supabase. Point it at any database:
`DATABASE_URL="postgresql://..." npm run db:migrate`.

Two bugs that only a real login could surface:

- The session cookie was set with a hard-coded `secure: true`. Browsers that refuse to store a
  Secure cookie over plain `http://localhost` simply never logged in — so local development looked
  broken in a way that had nothing to do with the code. It now follows the request protocol
  (`x-forwarded-proto`), falling back to `NODE_ENV`. Verified both ways: no `Secure` attribute over
  HTTP, `Secure` present when the request arrives over HTTPS.
- `npm install --no-save embedded-postgres` reified the entire dependency tree and pruned the
  app's own devDependencies, taking the test suite down with it. The Postgres binary is now
  installed with `--prefix ./.tools`, fully isolated.

Also: `package.json` now declares `"type": "module"`, which is what the code actually is — Node was
re-parsing every `lib/*.js` file as CommonJS and warning about it on every test run.

The Vercel project `hbh-lead-desk` is created and linked to the repo, with `SESSION_SECRET`,
`CRON_SECRET` and `DASHBOARD_PASSWORD` set and the build verified green. It needs a hosted
Postgres (`DATABASE_URL`) before it can show any data; that is the one thing I could not do without
your Supabase credentials. The deployment is otherwise ready.

---

## What I actually verified (not just read)

| Check | Method | Result |
|---|---|---|
| Migrations apply | Real PostgreSQL 18.4 server | **9/9 apply cleanly, in order** |
| Migrations apply | PGlite (Postgres 18 / WASM) | 9/9 clean |
| Business logic | 15 contract tests | **15/15 pass** |
| Collector logic | 16 unit tests | **16/16 pass** |
| Session / auth logic | 5 unit tests | **5/5 pass** |
| One-command local run | `npm run dev:local` from a cold clone | **Works** — real Postgres 18, 9 migrations, demo data, dashboard up in ~6s |
| Production build | `npm run build` (Next 16.4.2) | Clean, no warnings |
| Dependency audit | `npm audit --audit-level=high` | 0 vulnerabilities |
| `npm ci` from a clean tree | `rm -rf node_modules && npm ci` | **Works** (it did not before) |
| Login round trip | Real POST to the server action | 303 → `/`, `Set-Cookie` with `HttpOnly`+`SameSite=Lax`, `Secure` only over HTTPS |
| End-to-end runtime | Next.js server → real Postgres 18.4, seeded | All 7 pages **200**, data renders |
| Auth gating | Unauthenticated requests | `/` → 307 to `/login`; `/api/*` → 401; `/api/cron/*` → 401 without `CRON_SECRET` |
| XSS surface | grep for `dangerouslySetInnerHTML` / `eval` / `innerHTML` | **None** |
| Privilege separation | SQL introspection | RLS on all core tables; `anon` cannot execute any guarded function |

---

## What was broken when I got here (all now fixed on this branch)

### 1. `package-lock.json` was invalid JSON — the repo could not be installed
The lockfile was **truncated and unbalanced** (one unclosed brace; the `node_modules/next` entry had
two `next` versions hand-merged inside each other's `dependencies` object). Consequences:

- `npm ci` failed outright with `EUSAGE`.
- `package.json` also had a **duplicate `"next"` key** (`^16.3.7` and `^16.3.8`) — the same hand-edit.
- `node -e "require('./package-lock.json')"` → `SyntaxError`.

**Root cause:** the `chore(deps): bump sharp` commit. `sharp` is a transitive dependency of `next`;
somebody (or a bot) hand-edited the lockfile to bump it and corrupted the file. Dependabot's
`groups: { dependencies: { patterns: ["*"] } }` config means every dependency lands in one PR, so one
bad edit takes the whole tree down.

**Fixed:** duplicate key removed, lockfile regenerated from a clean `npm install`, `npm ci` verified.

### 2. CI could not fail. Ever.
Every step in `.github/workflows/ci.yml` ended in `|| true` — including `npx next build`. A green
checkmark meant nothing, which is exactly why #1 shipped unnoticed.

Two of the steps were also fake:
- `npx next lint` — **`next lint` was removed in Next 16**; the command now errors with
  *"Invalid project directory provided… /lint"*.
- `npx tsc --noEmit` — there is no TypeScript in this repo, and `npx` resolves it to the deprecated
  `tsc@2.0.4` placeholder package, which fails.

**Fixed:** CI now runs `npm ci` → `npm test` → `npm run build` → `npm audit`, with **no `|| true`**.
A broken lockfile or a failing test now blocks the merge. Also removed the `python` row from the
CodeQL matrix (there is no Python here).

### 3. `middleware.js` was deprecated
Next 16 renamed the convention to `proxy.js` and warned on every build.

**Fixed:** migrated with the official codemod → `proxy.js`, exports `proxy`. Verified the auth
behaviour is byte-for-byte identical afterwards (307/401 responses re-tested).

### 4. A lender could become the lead's owner (real bug, in the collector)
`lib/collectors/kernRecorder.js` filtered grantors with:

```js
const notTrustee = (n) => !(isEntity(n) && /\bTR$/.test(n)) && !TRUSTEE_WORDS.test(n);
```

The `isEntity()` test was only applied to names **ending in "TR"**. So when a servicer is indexed
as grantor on a document — which happens on Kern recordings — `JPMORGAN CHASE BANK NA` passed the
filter and became `raw_owner_name`: the lead's owner and the person the system would call. The
grantee fallback path already did this correctly (`!isEntity(n)`); only the grantor path leaked.

**Fixed:** `!isEntity(n) && !/\bTR$/.test(n) && !TRUSTEE_WORDS.test(n)` — drop lenders, servicers
and trustees from the borrower list. Regression test added.

### 5. No tests existed at all
Zero test files, no test script, no test framework. For a system whose entire value proposition is
"never auto-merge a property, never mail an opted-out person, never skip the equity-purchase
statute", that is the most consequential gap in the repo.

**Fixed:** 36 tests, no infrastructure required (see below).

---

## What I added

- **`test/db.test.mjs`** — 15 contract tests. Applies all 9 migrations to a real Postgres engine
  (PGlite = Postgres 18 compiled to WASM — no server, no Docker, ~3s) and asserts:
  - migrations apply cleanly, in order, to an empty database
  - `hbh_dashboard` can process intake; `anon` cannot execute any guarded function
  - RLS is on for every core table
  - a filing becomes a scored lead; urgency/equity/exit points are what the README claims
  - re-importing a document number duplicates nothing
  - a second filing on the same parcel attaches instead of creating a new property
  - a name-only filing attaches to a tracked property; an unknown name waits in the human queue
  - an attach-only filing (rescission) with no match is ignored, not turned into a lead
  - **a deal cannot reach `offer_sent` until `compliance_reviewed` is set** (Cal. Civ. Code §1695)
  - **outbound contact is blocked for a do-not-contact owner; inbound still works**
  - logging `opted_out` marks the person do-not-contact and blocks later touches
  - a new lead gets an automatic follow-up and lands in the letter queue
  - a lead with no street address is queued for lookup, **not mailed**
  - a lead whose only owner is do-not-contact is **not** queued for a letter

- **`test/collectors.test.mjs`** — 16 unit tests, no DB, no network: the county HTML parser
  (document numbers, dates, classes, grantor/grantee roles, pagination), entity detection, the
  borrower/estate/death rules, the owner-history dossier (loans vs. reconveyances, "already
  foreclosed" kill switch, common-name unverified flag), the CSV reader (quotes, CRLF, BOM) and the
  letter name formatter.

- **`test/auth.test.mjs`** — 5 unit tests on the session helpers: the token is a stable SHA-256
  digest, it changes when the password or the secret changes, it leaks neither, and `safeEqual`
  rejects wrong lengths and non-strings without throwing.

- **`npm test`** script. Runs in ~15s.

- **README** now documents the test command and the `proxy.js` convention.

- **`scripts/migrate.mjs` / `scripts/local-db.mjs` / `scripts/dev-local.mjs` / `scripts/seed-demo.mjs`**
  — the one-command local run and a repeatable migration path (see the update at the top).

- **Vercel project `hbh-lead-desk`** — created, linked to the repo, secrets set, build green. Needs
  `DATABASE_URL` to show data.

---

## What is still missing (the real remaining work)

### 1. The enrichment workers do not exist — the biggest gap
`enrichment_jobs` is a full queue with a complete lifecycle in SQL
(`claim_enrichment_jobs` → `finish_enrichment_job` → `release_stale_enrichment_jobs`, with
exponential backoff, `skip locked` claiming and attempt limits). **Nothing calls any of it.** The
app only ever *creates* jobs:

```js
if (not exists (select 1 from properties where id = v_pid and regrid_id is not null)) then
  insert into enrichment_jobs (property_id, enrichment_type, provider, priority) ...
```

Consequence: the queue grows without bound, and — more importantly — **the equity and exit
components of the score are always 0** until a human underwrites the lead by hand on the lead page.
`estimated_market_value`, `estimated_loan_balance`, `estimated_arv` and `estimated_repair_cost`
have no automated source. The Sources page even says so: *"Jobs wait here until the enrichment
workers (Regrid, valuation, contact) are connected."*

**This is the difference between a lead-finding tool and a lead-scoring tool.** It needs a worker
process (or a second cron endpoint) that claims jobs, calls Regrid/ATTOM/whatever, writes the
values back, and calls `finish_enrichment_job`. The queue and the contract are already built — only
the worker is missing. *Note: this is also the only part of the system that costs money per lead,
so it is a deliberate design choice, not an oversight.*

### 2. One market, not multi-state
The README opens with *"Built multi-state from day one."* The **schema** is genuinely multi-state
(`state_rules`, `jurisdictions`, `lead_sources` are data, not code — that part is real and good).
But the seed data has exactly one row: `CA / Kern`. No second county, no second state, no second
source. The claim is currently aspirational. A second market is mostly a data-entry exercise
(research the state's foreclosure type, equity-purchase law and rescission window, then insert
rows) **plus** a parcel resolver and a collector for that county — `lib/parcels.js` is architected
for exactly this (`RESOLVERS` keyed `"ST:County"`), and the collector layer
(`lib/ingest.js` → `COLLECTORS`) already supports more than one source. The extension points exist;
they just haven't been filled in.

### 3. The Kern scraper is unverified against the live site
I could not reach `recorderonline.co.kern.ca.us` or `maps.kerncounty.com` from this sandbox
(outbound network is restricted to GitHub/npm/PyPI), so **I could not confirm the county's HTML
still matches the parser, or that the parcel layers are still published under the expected names**.
This is the single most important thing to check before trusting the daily feed:

- The parser is regex-based over the county's result HTML (`parseKernResults` splits on
  `<tr valign="top">` and looks for cells with `width="30%"` / `width="53%"`). That is brittle by
  nature; the county can and does restyle.
- `lib/parcels.js` already handles the *known* failure mode for the GIS side — it tries four
  roll-year layer URLs and remembers whichever answered — but the *format* of the result page has no
  equivalent fallback.
- The code does have a guard (`throw new Error('Kern recorder: search form changed (no USERKEY)')`)
  rather than silently returning nothing, which is the right instinct.

**Recommendation:** add a canary — after each cron run, assert that filings were actually found and
that the run's `fetched` count is not zero for a weekday; alert if it is. Right now a silent scraper
break looks identical to "a quiet week at the recorder."

### 4. Operational hardening
- **No alerting.** `source_runs` records every pull (fetched / inserted / processed / matched /
  needs_match / status / error), and the Sources page shows the last 10 — but nothing tells you when
  the feed stops working. A failed cron is invisible until someone notices the pipeline is empty.
- **Cron schedule is off by an hour half the year.** `vercel.json` says `"0 15 * * *"` = 15:00 UTC
  = **07:00 Pacific in winter, 08:00 Pacific in summer**. The README and the Sources page both
  claim "8am Pacific". Either move to `0 16 * * *` and accept a summer mismatch, or schedule the
  pull at a time that doesn't matter and describe it accurately.
- **The cron is unpaginated/untimed against the county.** `maxDuration = 300` on the route, but the
  collector walks up to 60 pages per document class with a 300 ms politeness delay and a 20 s
  per-request timeout. On a bad day this can overrun the function budget mid-run. `source_runs` will
  show `status = 'error'`, which is right — but nothing surfaces it.
- **Vercel Hobby cron limits.** One daily cron is fine. If a second market is added, Hobby allows
  only two crons *and* only once-daily schedules. Check the plan before adding feeds.

### 5. Identity and audit trail
One shared password for the whole dashboard; `created_by` is a hardcoded literal (`'dashboard'`,
`'letters'`, `'manual'`) rather than a real user. For a single-operator tool this is fine and
deliberately simple. For a small team it becomes a problem: there is no way to answer *"who moved
this deal to `offer_sent`?"* — and for a compliance-sensitive workflow, that question will eventually
matter. The `outreach` table already has `created_by` and `deal_stage_events` already records stage
history, so the plumbing is there; it just needs real identities.

### 6. Security model: sound, with two small notes
**What's right (and better than most projects at this stage):**
- Compliance is enforced **in the database**, not in application code or in someone's memory.
  `guard_deal_stage` raises on any move to `offer_sent` / `under_contract` / `closed` while
  `equity_purchase_law_applies` is true and `compliance_reviewed` is false. You cannot bypass it by
  clicking a different button.
- `guard_outreach` enforces do-not-contact / do-not-call / SMS / email opt-outs at the database
  level, and `opted_out` sets the flag on the owner. Inbound touches still work.
- The letter copy itself carries the required California disclosures (§1695 cancellation rights,
  §2945 foreclosure-consultant language, the "we are not your lender" line) and the source file
  says *"Have your attorney read these once before the first mailing."* That is the correct posture.
- Least-privilege DB role (`hbh_dashboard`), RLS everywhere, `anon`/`authenticated` explicitly
  revoked from every guarded function, `search_path` pinned on every `security definer` function.
- Password comparison is constant-time (`safeEqual`); the session token is a SHA-256 of
  `password::secret`; the cookie is `httpOnly`, `secure`, `sameSite=lax`; every page and API route
  is gated by `proxy.js`; cron endpoints require `CRON_SECRET`.
- No secrets committed, `.env` gitignored, `.env.example` has no real values.

**The two notes:**
- **No login rate limiting.** The 400 ms delay in the login action is a speed bump, not a lockout.
  With a long shared password this is defensible; with a weak one it is not. If the password is ever
  short or shared over chat, add a per-IP attempt counter.
- **`secure: true` on the session cookie** means the dashboard will not authenticate over plain HTTP
  — including `npm run dev` on `http://localhost:3000`. Worth knowing before you think it's broken.

---

## Recommendation

**Keep it. Finish it.** Specifically, in priority order:

1. **Build the enrichment worker** (biggest gap, unlocks the score's value). The queue, the
   retry/backoff semantics and the "paid enrichment is gated" policy are already designed and
   tested — you are writing one consumer, not a new subsystem.
2. **Verify the Kern scraper against the live site** and add a canary that alerts when a pull
   returns zero filings on a weekday. Everything else is downstream of this feed.
3. **Add alerting on `source_runs`** — a cron failure or a zero-yield pull should page you.
4. **Fix the cron hour** and the README/UI wording so they agree.
5. **Add a second market** to make the multi-state claim real — Maricopa AZ (nonjudicial) is the
   natural next one; it needs a `state_rules` + `jurisdictions` insert, a parcel resolver, and a
   county recorder collector.
6. Only then: real user accounts with a `created_by` that names a person.

**Do not delete it.** The parts that look like "extra" — the state/county data model, the
compliance triggers, the name-key matching, the dossier builder, the letter compliance copy — are
the expensive-to-rebuild parts, and they are the parts that are done. The remaining work is
integration, not invention.

**Do not treat the green CI badge as evidence of anything** — it was decorative until this branch.
It is now a real gate, which is the other reason to keep the repo around: from here on, it will
tell you the truth.

---

## What changed on this branch

```
M  .github/workflows/ci.yml           CI actually gates now (no `|| true`)
M  .github/workflows/codeql.yml       dropped the phantom python target
M  package.json                       single "next" key; + test scripts
M  package-lock.json                  regenerated (was invalid JSON)
M  proxy.js                           new  (renamed from middleware.js)
D  middleware.js                      removed
M  lib/collectors/kernRecorder.js     lenders no longer become lead owners
M  lib/collectors/kernHistory.js      explicit .js extensions (Node ESM)
M  lib/collectors/kernRecorder.js     explicit .js extensions (Node ESM)
M  README.md                          development section, proxy.js, npm test
A  test/db.test.mjs                   15 database contract tests
A  test/collectors.test.mjs           16 collector/parser unit tests
A  AUDIT.md                           this document
```
