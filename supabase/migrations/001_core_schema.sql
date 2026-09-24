-- Harbison Buys Homes — distressed-property intelligence system
-- 001: core schema (jurisdiction-agnostic; nothing hardcoded to Kern/CA)

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------
-- Jurisdiction layer: state law + county sources drive behavior
-- ---------------------------------------------------------------
create table state_rules (
  state                    char(2) primary key,
  foreclosure_type         text not null check (foreclosure_type in ('nonjudicial','judicial','both')),
  -- equity-purchaser / foreclosure-rescue statutes that restrict buying from owners in default
  equity_purchase_law      boolean not null default false,
  equity_purchase_statute  text,
  rescission_business_days integer,
  foreclosure_consultant_statute text,
  notes                    text,
  updated_at               timestamptz not null default now()
);

create table jurisdictions (
  id          uuid primary key default gen_random_uuid(),
  state       char(2) not null references state_rules(state),
  county      text not null,
  fips        text,
  active      boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (state, county)
);

create table lead_sources (
  id            text primary key,                 -- e.g. 'kern_recorder', 'propertyradar_nod'
  jurisdiction_id uuid references jurisdictions(id),
  source_type   text not null,                    -- public_record | vendor | referral | inbound | manual
  signal_types  text[] not null default '{}',
  cost_per_record numeric,
  monthly_cost  numeric,
  active        boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- Intake: immutable raw records
-- ---------------------------------------------------------------
create table raw_lead_intake (
  id                uuid primary key default gen_random_uuid(),
  source_name       text not null references lead_sources(id),
  source_type       text not null,               -- becomes distress_events.event_type
  source_record_id  text,
  source_url        text,
  received_at       timestamptz not null default now(),
  event_date        date,
  raw_state         char(2) not null,
  raw_county        text not null,
  raw_apn           text,
  raw_address       text,
  raw_city          text,
  raw_zip           text,
  raw_owner_name    text,
  raw_payload       jsonb not null default '{}'::jsonb,
  processing_status text not null default 'pending'
    check (processing_status in ('pending','processing','processed','failed','ignored','needs_review')),
  processing_error  text,
  property_id       uuid,
  processed_at      timestamptz
);
create unique index raw_lead_source_record_unique
  on raw_lead_intake (source_name, source_record_id) where source_record_id is not null;
create index raw_lead_pending_idx on raw_lead_intake (received_at) where processing_status = 'pending';

-- ---------------------------------------------------------------
-- Canonical property
-- ---------------------------------------------------------------
create table properties (
  id                     uuid primary key default gen_random_uuid(),
  state                  char(2) not null,
  county                 text not null,
  apn                    text,            -- as printed
  apn_key                text,            -- digits/letters only, for matching
  address_line_1         text,
  city                   text,
  zip                    text,
  address_key            text,            -- normalized street address for matching
  latitude               numeric,
  longitude              numeric,
  property_type          text,
  units                  integer,
  bedrooms               integer,
  bathrooms              numeric,
  living_sqft            integer,
  lot_sqft               integer,
  year_built             integer,
  assessed_value         numeric,
  estimated_market_value numeric,
  estimated_arv          numeric,
  estimated_repair_cost  numeric,
  estimated_loan_balance numeric,
  estimated_other_liens  numeric,
  condition_rating       integer check (condition_rating between 1 and 5), -- 5 = worst
  owner_occupied         boolean,
  absentee_owner         boolean,
  vacant_signal          boolean not null default false,
  title_verified         boolean not null default false,
  regrid_id              text,
  attom_id               text,
  vendor_property_id     text,
  ownership_last_verified_at timestamptz,
  valuation_last_verified_at timestamptz,
  mortgage_last_verified_at  timestamptz,
  data_confidence        text,
  source_metadata        jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index properties_apn_unique
  on properties (state, county, apn_key) where apn_key is not null;
create index properties_address_key_idx on properties (state, county, address_key, zip);

-- ---------------------------------------------------------------
-- People with (possible) authority
-- ---------------------------------------------------------------
create table owners (
  id                        uuid primary key default gen_random_uuid(),
  full_name                 text not null,
  entity_type               text,           -- individual | trust | llc | estate | corp
  mailing_address           text,
  city                      text,
  state                     char(2),
  zip                       text,
  phone                     text,
  email                     text,
  contact_source            text,
  contact_verified_at       timestamptz,
  do_not_contact            boolean not null default false,
  do_not_call               boolean not null default false,
  sms_opt_out               boolean not null default false,
  email_opt_out             boolean not null default false,
  notes                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create table property_owners (
  property_id       uuid not null references properties(id) on delete cascade,
  owner_id          uuid not null references owners(id) on delete cascade,
  ownership_role    text not null default 'owner',  -- owner | co_owner | heir | executor | administrator | trustee | attorney
  ownership_percent numeric,
  is_decision_maker boolean not null default false,
  source            text,
  created_at        timestamptz not null default now(),
  primary key (property_id, owner_id)
);

-- ---------------------------------------------------------------
-- Distress signals (history is never overwritten)
-- ---------------------------------------------------------------
create table distress_events (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references properties(id) on delete cascade,
  intake_id       uuid references raw_lead_intake(id) on delete set null,
  event_type      text not null check (event_type in (
    'notice_of_default','notice_of_trustee_sale','lis_pendens','foreclosure_judgment',
    'trustee_sale_postponed','trustee_sale_cancelled','notice_of_rescission','foreclosure_sold',
    'probate_opened','letters_testamentary','tax_default','power_to_sell',
    'vacancy_signal','code_violation','absentee_owner','fsbo_listing','estate_sale',
    'bankruptcy','co_owner_referral','inbound_seller_request')),
  event_date      date,
  recorded_date   date,
  document_number text,
  case_number     text,
  auction_date    date,
  amount_owed     numeric,
  source_name     text not null,
  source_url      text,
  verified        boolean not null default false,
  raw_data        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create unique index distress_event_document_unique
  on distress_events (source_name, document_number) where document_number is not null;
create index distress_events_property_idx on distress_events (property_id, event_date desc);

-- ---------------------------------------------------------------
-- Enrichment queue + audit
-- ---------------------------------------------------------------
create table enrichment_jobs (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references properties(id) on delete cascade,
  enrichment_type text not null check (enrichment_type in
    ('parcel','valuation','mortgage','foreclosure','ownership','contact','title_review')),
  provider        text,
  priority        integer not null default 50,
  status          text not null default 'queued'
    check (status in ('queued','processing','completed','failed','skipped','cancelled')),
  attempts        integer not null default 0,
  max_attempts    integer not null default 4,
  available_at    timestamptz not null default now(),
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  requested_at    timestamptz not null default now(),
  completed_at    timestamptz,
  created_at      timestamptz not null default now()
);
create unique index one_active_enrichment_job
  on enrichment_jobs (property_id, enrichment_type) where status in ('queued','processing');
create index enrichment_jobs_claim_idx
  on enrichment_jobs (enrichment_type, priority desc, created_at) where status = 'queued';

create table enrichment_runs (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid references enrichment_jobs(id) on delete set null,
  property_id       uuid not null references properties(id) on delete cascade,
  provider          text not null,
  enrichment_type   text not null,
  status            text not null,
  request_reference text,
  response_summary  jsonb not null default '{}'::jsonb,
  raw_response      jsonb,
  credit_cost       numeric default 0,
  executed_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- Scoring output (separate from facts)
-- ---------------------------------------------------------------
create table lead_scores (
  property_id      uuid primary key references properties(id) on delete cascade,
  urgency_score    integer not null default 0,
  equity_score     integer not null default 0,
  condition_score  integer not null default 0,
  authority_score  integer not null default 0,
  exit_score       integer not null default 0,
  risk_score       integer not null default 0,
  total_score      integer not null default 0,
  lead_tier        text not null default 'D' check (lead_tier in ('A','B','C','D')),
  equity_purchase_law_applies boolean not null default false,
  score_reasoning  jsonb not null default '{}'::jsonb,
  calculated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- Pipeline + outreach
-- ---------------------------------------------------------------
create table deals (
  property_id   uuid primary key references properties(id) on delete cascade,
  stage         text not null default 'new' check (stage in
    ('new','researching','contacted','conversation','appointment','offer_sent',
     'under_contract','closed','lost','nurture','dead')),
  best_exit     text,  -- cash | listing | wholesale | novation | seller_finance | pass
  offer_amount  numeric,
  seller_goal   text,
  assigned_to   text,
  next_follow_up_at timestamptz,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create table outreach (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references properties(id) on delete cascade,
  owner_id          uuid references owners(id) on delete set null,
  channel           text not null check (channel in ('call','sms','email','letter','door','referral','other')),
  direction         text not null default 'outbound' check (direction in ('outbound','inbound')),
  status            text not null,  -- attempted | reached | voicemail | wrong_contact | opted_out ...
  contact_role      text,           -- owner | executor | attorney | heir | tenant | wrong_contact
  attempted_at      timestamptz not null default now(),
  next_follow_up_at timestamptz,
  outcome           text,
  notes             text,
  created_by        text,
  created_at        timestamptz not null default now()
);
create index outreach_property_idx on outreach (property_id, attempted_at desc);

-- FK indexes
create index property_owners_owner_idx on property_owners (owner_id);
create index distress_events_intake_idx on distress_events (intake_id);
create index enrichment_runs_property_idx on enrichment_runs (property_id);
create index enrichment_runs_job_idx on enrichment_runs (job_id);
create index outreach_owner_idx on outreach (owner_id);
create index raw_lead_property_idx on raw_lead_intake (property_id);
create index lead_sources_jurisdiction_idx on lead_sources (jurisdiction_id);
