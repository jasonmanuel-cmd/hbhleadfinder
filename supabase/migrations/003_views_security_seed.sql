-- Harbison Buys Homes — 003: dashboard views, lockdown, seed data

-- ---------------------------------------------------------------
-- Views (security_invoker so they respect RLS of the caller)
-- ---------------------------------------------------------------
create view v_action_list with (security_invoker = true) as
select p.id as property_id, p.state, p.county, p.address_line_1, p.city, p.zip, p.apn,
       ls.lead_tier, ls.total_score, ls.urgency_score, ls.equity_score, ls.risk_score,
       ls.equity_purchase_law_applies,
       (select array_agg(distinct de.event_type) from distress_events de where de.property_id = p.id) as signals,
       (select max(coalesce(de.event_date, de.recorded_date)) from distress_events de where de.property_id = p.id) as latest_event,
       (select min(de.auction_date) from distress_events de where de.property_id = p.id and de.auction_date >= current_date) as next_auction,
       d.stage, d.next_follow_up_at,
       (select max(o.attempted_at) from outreach o where o.property_id = p.id) as last_touch
  from properties p
  join lead_scores ls on ls.property_id = p.id
  left join deals d on d.property_id = p.id
 where ls.lead_tier in ('A','B')
   and coalesce(d.stage, 'new') not in ('closed','lost','dead')
   and (d.next_follow_up_at is null or d.next_follow_up_at <= now())
 order by ls.total_score desc, next_auction nulls last;

create view v_source_performance with (security_invoker = true) as
with src as (
  select distinct i.source_name, i.property_id
    from raw_lead_intake i where i.property_id is not null
)
select s.id as source,
       s.source_type,
       (select count(*) from raw_lead_intake i where i.source_name = s.id) as records_received,
       count(distinct src.property_id) as properties,
       count(distinct src.property_id) filter (where ls.lead_tier in ('A','B')) as tier_ab,
       count(distinct src.property_id) filter (where exists
             (select 1 from outreach o where o.property_id = src.property_id and o.status = 'reached')) as conversations,
       count(distinct src.property_id) filter (where d.stage in ('appointment','offer_sent','under_contract','closed')) as appointments,
       count(distinct src.property_id) filter (where d.stage in ('offer_sent','under_contract','closed')) as offers,
       count(distinct src.property_id) filter (where d.stage in ('under_contract','closed')) as contracts,
       count(distinct src.property_id) filter (where d.stage = 'closed') as closed,
       round(count(distinct src.property_id) filter (where d.stage in ('under_contract','closed'))::numeric
             / nullif(count(distinct src.property_id) filter (where ls.lead_tier in ('A','B')), 0), 3)
         as contract_rate_of_qualified
  from lead_sources s
  left join src on src.source_name = s.id
  left join lead_scores ls on ls.property_id = src.property_id
  left join deals d on d.property_id = src.property_id
 group by s.id, s.source_type;

create view v_queue_health with (security_invoker = true) as
select enrichment_type, status, count(*) as jobs, round(avg(attempts), 2) as avg_attempts,
       min(available_at) filter (where status = 'queued') as next_available
  from enrichment_jobs group by enrichment_type, status order by enrichment_type, status;

create view v_needs_review with (security_invoker = true) as
select id, source_name, source_type, raw_state, raw_county, raw_apn, raw_address,
       processing_status, processing_error, received_at
  from raw_lead_intake where processing_status in ('needs_review','failed')
 order by received_at desc;

-- ---------------------------------------------------------------
-- Lockdown: RLS on, no public policies. Only the service role (server side) touches data.
-- ---------------------------------------------------------------
alter table state_rules      enable row level security;
alter table jurisdictions    enable row level security;
alter table lead_sources     enable row level security;
alter table raw_lead_intake  enable row level security;
alter table properties       enable row level security;
alter table owners           enable row level security;
alter table property_owners  enable row level security;
alter table distress_events  enable row level security;
alter table enrichment_jobs  enable row level security;
alter table enrichment_runs  enable row level security;
alter table lead_scores      enable row level security;
alter table deals            enable row level security;
alter table outreach         enable row level security;

revoke execute on function recalculate_lead_score(uuid)                from public, anon, authenticated;
revoke execute on function process_raw_property_lead(uuid)             from public, anon, authenticated;
revoke execute on function process_pending_intake(int)                 from public, anon, authenticated;
revoke execute on function claim_enrichment_jobs(text, text, int)      from public, anon, authenticated;
revoke execute on function finish_enrichment_job(uuid, text, text)     from public, anon, authenticated;
revoke execute on function release_stale_enrichment_jobs()             from public, anon, authenticated;
grant  execute on function recalculate_lead_score(uuid),
                           process_raw_property_lead(uuid),
                           process_pending_intake(int),
                           claim_enrichment_jobs(text, text, int),
                           finish_enrichment_job(uuid, text, text),
                           release_stale_enrichment_jobs()             to service_role;

-- ---------------------------------------------------------------
-- Seed: first jurisdiction. Add states by inserting state_rules + jurisdictions rows, not by editing code.
-- ---------------------------------------------------------------
insert into state_rules (state, foreclosure_type, equity_purchase_law, equity_purchase_statute,
                         rescission_business_days, foreclosure_consultant_statute, notes)
values ('CA', 'nonjudicial', true,
        'Cal. Civ. Code §1695 et seq. (Home Equity Sales Contracts Act)', 5,
        'Cal. Civ. Code §2945 et seq. (Foreclosure Consultant Act)',
        'NOD starts the public clock; NTS follows after ~3 months; sale at least 20+ days after NTS. '
        'Buying an owner-occupied 1-4 unit home in foreclosure requires a statute-compliant contract and cancellation notice.');

insert into jurisdictions (state, county, fips, active) values ('CA', 'Kern', '06029', true);

insert into lead_sources (id, jurisdiction_id, source_type, signal_types, notes)
select v.id, j.id, v.source_type, v.signals, v.notes
  from jurisdictions j,
       (values
         ('kern_recorder',    'public_record', array['notice_of_default','notice_of_trustee_sale','notice_of_rescission'], 'Kern County Recorder recorded-document search'),
         ('kern_probate',     'public_record', array['probate_opened','letters_testamentary'], 'Kern Superior Court probate case search'),
         ('kern_tax_default', 'public_record', array['tax_default','power_to_sell'], 'Kern Treasurer-Tax Collector defaulted / power-to-sell lists')
       ) as v(id, source_type, signals, notes)
 where j.state = 'CA' and j.county = 'Kern';

insert into lead_sources (id, source_type, signal_types, notes) values
  ('manual_entry',     'manual',   '{}', 'Hand-entered leads (drive-for-dollars, tips)'),
  ('referral_partner', 'referral', array['co_owner_referral','probate_opened'], 'Attorneys, mediators, CPAs, estate-sale companies'),
  ('inbound_web',      'inbound',  array['inbound_seller_request'], 'Website / landing-page seller forms');
