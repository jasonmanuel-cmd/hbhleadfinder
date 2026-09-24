-- 008: auto-skip dead filings, tax-default cross-match, letter batches, stage history / funnel, daily briefing

-- ---------------------------------------------------------------------------------
-- 1. Auto-skip filings the recorded history says are dead or not worth a look-up
-- ---------------------------------------------------------------------------------
create or replace function auto_skip_dead_filings(p_min_priority int default 15) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update raw_lead_intake i
     set processing_status = 'ignored',
         processing_error = 'Auto-skipped: ' || d.reason
    from (select intake_id,
                 case when coalesce((signals ->> 'foreclosed')::boolean, false) then 'foreclosure deed already recorded'
                      when coalesce((signals ->> 'transferred_out')::boolean, false) then 'owner deeded the property away'
                      else format('priority %s is below %s', priority, p_min_priority) end as reason
            from borrower_dossiers
           where error is null
             and (coalesce((signals ->> 'foreclosed')::boolean, false)
                  or coalesce((signals ->> 'transferred_out')::boolean, false)
                  or priority < p_min_priority)) d
   where d.intake_id = i.id
     and i.processing_status = 'needs_property_match'
     and coalesce(i.processing_error, '') not like 'Restored by hand%';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace view v_auto_skipped with (security_invoker = true) as
select i.id, i.source_type, i.raw_county, i.raw_state, i.raw_owner_name,
       coalesce(i.raw_payload -> 'people', '[]'::jsonb) as people,
       i.raw_payload ->> 'document_number' as document_number,
       coalesce(i.event_date, nullif(i.raw_payload ->> 'recorded_date', '')::date) as recorded_date,
       i.processing_error, d.priority, d.summary
  from raw_lead_intake i
  left join borrower_dossiers d on d.intake_id = i.id
 where i.processing_status = 'ignored' and i.processing_error like 'Auto-skipped:%'
   and coalesce(i.event_date, i.received_at::date) > current_date - 60
 order by coalesce(i.event_date, i.received_at::date) desc;

-- ---------------------------------------------------------------------------------
-- 2. Tax-defaulted roll: APN + assessee name. The one free public list that ties
--    owner names to parcels. Loaded from the county's list (CSV), matched by name.
-- ---------------------------------------------------------------------------------
create or replace function name_tokens(p text) returns text[]
language sql immutable set search_path = public as $$
  select coalesce(array(
    select t from unnest(string_to_array(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9 ]', ' ', 'g'), ' ')) t
     where t <> '' and t not in ('TR','TRS','TRUSTEE','TRUSTEES','ETAL','ET','AL','EST','ESTATE','DECD','THE','AND','OF',
                                'LIV','REV','FAM','FAMILY','TRUST','LIVING','REVOCABLE','JR','SR','II','III','IV')), '{}')
$$;

create table if not exists tax_defaults (
  id            uuid primary key default gen_random_uuid(),
  state         char(2) not null,
  county        text not null,
  apn           text not null,
  apn_key       text not null,
  assessee      text not null,
  tokens        text[] generated always as (name_tokens(assessee)) stored,
  amount_due    numeric,
  default_year  integer,
  situs         text,
  source        text not null default 'kern_tax_default',
  imported_at   timestamptz not null default now()
);
create unique index if not exists tax_defaults_unique on tax_defaults (state, county, apn_key, coalesce(default_year, 0));
create index if not exists tax_defaults_tokens_idx on tax_defaults using gin (tokens);
alter table tax_defaults enable row level security;

-- Mark tracked properties that sit on the defaulted roll
create or replace function apply_tax_default_events() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; r record;
begin
  for r in
    select p.id as property_id, td.apn_key, td.default_year, td.amount_due, td.assessee
      from tax_defaults td
      join properties p on p.state = td.state and p.county = td.county and p.apn_key = td.apn_key
     where not exists (select 1 from distress_events de
                        where de.property_id = p.id and de.event_type = 'tax_default')
  loop
    insert into distress_events (property_id, event_type, event_date, document_number, amount_owed, source_name, raw_data)
    values (r.property_id, 'tax_default', make_date(coalesce(r.default_year, extract(year from now())::int), 7, 1),
            'TD-' || r.apn_key || '-' || coalesce(r.default_year, 0), r.amount_due, 'kern_tax_default',
            jsonb_build_object('assessee', r.assessee))
    on conflict do nothing;
    perform recalculate_lead_score(r.property_id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Give name-only recorder filings an APN when exactly one defaulted parcel carries the same name.
-- The decedent counts too: the assessee on a death filing is usually the person who died.
create or replace function match_tax_defaults(p_limit int default 1000) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; v_apns text[]; v_matched int := 0; v_multi int := 0; v_res jsonb;
begin
  for r in
    select i.id, i.raw_state, i.raw_county, i.raw_payload
      from raw_lead_intake i
      left join borrower_dossiers bd on bd.intake_id = i.id
     where i.processing_status = 'needs_property_match' and i.raw_apn is null
       and not coalesce(bd.truncated, false)          -- common names match strangers' parcels
     order by i.received_at desc limit p_limit
  loop
    select array_agg(distinct td.apn order by td.apn) into v_apns
      from tax_defaults td
      join lateral (
        select (name_tokens(x ->> 'name'))[1:2] as core
          from jsonb_array_elements(coalesce(r.raw_payload -> 'people', '[]'::jsonb)) x
      ) pp on cardinality(pp.core) = 2 and pp.core <@ td.tokens
     where td.state = r.raw_state and td.county = r.raw_county;

    if cardinality(v_apns) = 1 then
      update raw_lead_intake set raw_apn = v_apns[1], processing_status = 'pending', processing_error = null where id = r.id;
      v_res := process_raw_property_lead(r.id);
      if v_res ->> 'status' = 'processed' then
        v_matched := v_matched + 1;
        update properties
           set data_confidence = coalesce(data_confidence, 'Parcel matched by owner name on the tax-default list — confirm it is the property in the filing'),
               source_metadata = source_metadata || jsonb_build_object('apn_from', 'tax_default_name_match')
         where id = (v_res ->> 'property_id')::uuid;
      end if;
    elsif cardinality(v_apns) > 1 then
      v_multi := v_multi + 1;
      update raw_lead_intake
         set processing_error = format('Tax-default list has %s parcels under this name: %s', cardinality(v_apns),
                                       array_to_string(v_apns[1:6], ', '))
       where id = r.id;
    end if;
  end loop;
  perform apply_tax_default_events();
  return jsonb_build_object('matched', v_matched, 'several', v_multi);
end $$;

-- ---------------------------------------------------------------------------------
-- 3. Letters: sender settings + the queue of properties ready for a letter
-- ---------------------------------------------------------------------------------
create table if not exists org_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);
alter table org_settings enable row level security;
insert into org_settings (key, value) values
  ('letter_company', 'Harbison Buys Homes'), ('letter_sender', null), ('letter_phone', null),
  ('letter_email', null), ('letter_return_address', null), ('letter_city_line', null)
on conflict (key) do nothing;

create or replace view v_letter_queue with (security_invoker = true) as
with ev as (
  select de.property_id,
         (array_agg(de.event_type order by
            case de.event_type when 'notice_of_trustee_sale' then 1 when 'notice_of_default' then 2
              when 'letters_testamentary' then 3 when 'probate_opened' then 3 when 'tod_affidavit' then 4
              when 'death_joint_tenant' then 4 when 'tax_default' then 5 when 'power_to_sell' then 5 else 9 end,
            coalesce(de.event_date, de.recorded_date) desc))[1] as primary_signal,
         max(coalesce(de.event_date, de.recorded_date)) filter (
           where de.event_type in ('death_joint_tenant','tod_affidavit','letters_testamentary','probate_opened')) as death_date,
         bool_or(de.event_type in ('trustee_sale_cancelled','notice_of_rescission','foreclosure_sold')) as resolved
    from distress_events de group by de.property_id
), lt as (
  select property_id, count(*) filter (where channel = 'letter') as letters_sent,
         max(attempted_at) filter (where channel = 'letter') as last_letter,
         bool_or(status in ('reached','appointment_set','not_interested','opted_out') or direction = 'inbound') as engaged
    from outreach group by property_id
), who as (
  select po.property_id,
         (array_agg(o.full_name order by po.is_decision_maker desc, o.created_at)
            filter (where po.ownership_role <> 'decedent' and not o.do_not_contact)) as recipients,
         (array_agg(o.id order by po.is_decision_maker desc, o.created_at)
            filter (where po.ownership_role <> 'decedent' and not o.do_not_contact)) as recipient_ids,
         (array_agg(po.ownership_role order by po.is_decision_maker desc, o.created_at)
            filter (where po.ownership_role <> 'decedent' and not o.do_not_contact)) as recipient_roles,
         (array_agg(o.full_name) filter (where po.ownership_role = 'decedent'))[1] as decedent,
         bool_or(o.do_not_contact) as any_dnc
    from property_owners po join owners o on o.id = po.owner_id
   group by po.property_id
)
select p.id as property_id, p.address_line_1, p.city, p.state, p.zip, p.apn,
       ev.primary_signal, ev.death_date, coalesce(lt.letters_sent, 0)::int as letters_sent, lt.last_letter,
       who.recipients, who.recipient_ids, who.recipient_roles, who.decedent,
       ls.lead_tier, ls.total_score, d.stage,
       case when ev.death_date is not null and ev.death_date > current_date - 30 then ev.death_date + 30 end as hold_until
  from properties p
  join ev on ev.property_id = p.id
  join who on who.property_id = p.id
  left join lt on lt.property_id = p.id
  left join lead_scores ls on ls.property_id = p.id
  left join deals d on d.property_id = p.id
 where p.address_line_1 is not null
   and coalesce(d.stage, 'new') in ('new','researching','contacted','nurture')
   and not coalesce(ev.resolved, false)
   and not coalesce(lt.engaged, false)
   and coalesce(lt.letters_sent, 0) < 3
   and (lt.last_letter is null or lt.last_letter < now() - interval '21 days')
   and (cardinality(who.recipients) > 0 or who.decedent is not null)
   and not coalesce(who.any_dnc, false)
 order by (ev.death_date is not null and ev.death_date > current_date - 30),
          case ev.primary_signal when 'notice_of_trustee_sale' then 1 when 'notice_of_default' then 2 else 3 end,
          ls.total_score desc nulls last;

-- ---------------------------------------------------------------------------------
-- 4. Stage history, so the funnel counts how far each lead got (not only where it is now)
-- ---------------------------------------------------------------------------------
create table if not exists deal_stage_events (
  id           bigint generated always as identity primary key,
  property_id  uuid not null references properties(id) on delete cascade,
  stage        text not null,
  changed_at   timestamptz not null default now()
);
create index if not exists deal_stage_events_property_idx on deal_stage_events (property_id, changed_at);
alter table deal_stage_events enable row level security;

create or replace function log_deal_stage() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    insert into deal_stage_events (property_id, stage) values (new.property_id, new.stage);
  end if;
  return new;
end $$;
revoke execute on function log_deal_stage() from public, anon, authenticated;
drop trigger if exists deals_stage_log on deals;
create trigger deals_stage_log after insert or update of stage on deals for each row execute function log_deal_stage();

insert into deal_stage_events (property_id, stage, changed_at)
select d.property_id, d.stage, d.updated_at from deals d
 where not exists (select 1 from deal_stage_events e where e.property_id = d.property_id);

-- Funnel for filings recorded in the last N days: how many reached each step
create or replace function funnel(p_days int default 90) returns jsonb
language sql stable security invoker set search_path = public as $$
  with f as (
    select i.id, i.property_id
      from raw_lead_intake i
     where i.source_type in ('notice_of_default','notice_of_trustee_sale','tod_affidavit','death_joint_tenant',
                             'letters_testamentary','probate_opened','inbound_seller_request','co_owner_referral')
       and coalesce(i.event_date, i.received_at::date) > current_date - p_days
  ), p as (select distinct property_id from f where property_id is not null),
  reached as (
    select p.property_id,
           exists (select 1 from outreach o where o.property_id = p.property_id and o.channel = 'letter') as mailed,
           exists (select 1 from outreach o where o.property_id = p.property_id) as touched,
           exists (select 1 from outreach o where o.property_id = p.property_id
                     and (o.status in ('reached','appointment_set','not_interested') or o.direction = 'inbound'))
             or exists (select 1 from deal_stage_events e where e.property_id = p.property_id
                          and e.stage in ('conversation','appointment','offer_sent','under_contract','closed')) as talked,
           exists (select 1 from deal_stage_events e where e.property_id = p.property_id
                     and e.stage in ('appointment','offer_sent','under_contract','closed'))
             or exists (select 1 from outreach o where o.property_id = p.property_id and o.status = 'appointment_set') as appointment,
           exists (select 1 from deal_stage_events e where e.property_id = p.property_id
                     and e.stage in ('under_contract','closed')) as contract,
           exists (select 1 from deal_stage_events e where e.property_id = p.property_id and e.stage = 'closed') as closed
      from p
  )
  select jsonb_build_object(
    'days', p_days,
    'filings', (select count(*) from f),
    'matched', (select count(*) from p),
    'mailed', (select count(*) from reached where mailed),
    'touched', (select count(*) from reached where touched),
    'talked', (select count(*) from reached where talked),
    'appointment', (select count(*) from reached where appointment),
    'contract', (select count(*) from reached where contract),
    'closed', (select count(*) from reached where closed))
$$;

-- ---------------------------------------------------------------------------------
-- 5. Daily briefing (read by the morning scheduled task)
-- ---------------------------------------------------------------------------------
create or replace function daily_briefing() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'date', current_date,
    'sales_next_21d', coalesce((
      select jsonb_agg(x order by x ->> 'sale') from (
        select jsonb_build_object('property_id', p.id, 'address', coalesce(p.address_line_1, p.apn), 'city', p.city,
                 'sale', coalesce((select min(de.auction_date) from distress_events de
                                    where de.property_id = p.id and de.auction_date >= current_date), ls.est_sale_date),
                 'estimated', (select min(de.auction_date) from distress_events de
                                 where de.property_id = p.id and de.auction_date >= current_date) is null,
                 'tier', ls.lead_tier, 'stage', d.stage) as x
          from properties p join lead_scores ls on ls.property_id = p.id left join deals d on d.property_id = p.id
         where coalesce(d.stage, 'new') not in ('closed','lost','dead')
           and coalesce((select min(de.auction_date) from distress_events de
                          where de.property_id = p.id and de.auction_date >= current_date), ls.est_sale_date)
               between current_date and current_date + 21) s), '[]'::jsonb),
    'new_top_leads_24h', coalesce((
      select jsonb_agg(jsonb_build_object('property_id', p.id, 'address', coalesce(p.address_line_1, p.apn), 'city', p.city,
                                          'tier', ls.lead_tier, 'score', ls.total_score))
        from properties p join lead_scores ls on ls.property_id = p.id
       where ls.lead_tier in ('A','B') and p.created_at > now() - interval '24 hours'), '[]'::jsonb),
    'followups_due', (select count(*) from deals where next_follow_up_at <= now() + interval '12 hours'
                        and stage not in ('closed','lost','dead')),
    'filings_to_match', (select count(*) from raw_lead_intake where processing_status = 'needs_property_match'),
    'top_filings_to_match', coalesce((
      select jsonb_agg(jsonb_build_object('signal', source_type, 'name', raw_owner_name, 'priority', priority,
                                          'recorded', recorded_date))
        from (select * from v_needs_match where priority is not null limit 5) m), '[]'::jsonb),
    'letters_ready', (select count(*) from v_letter_queue where hold_until is null),
    'auto_skipped_3d', (select count(*) from raw_lead_intake where processing_error like 'Auto-skipped:%'
                           and received_at > now() - interval '3 days'),
    'last_pull', (select jsonb_build_object('status', status, 'finished', finished_at, 'fetched', fetched,
                                            'needs_match', needs_match, 'note', note)
                    from source_runs order by started_at desc limit 1),
    'funnel_90d', funnel(90))
$$;

-- ---------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------
revoke execute on function auto_skip_dead_filings(int), apply_tax_default_events(), match_tax_defaults(int)
  from public, anon, authenticated;
grant execute on function auto_skip_dead_filings(int), apply_tax_default_events(), match_tax_defaults(int),
  funnel(int), daily_briefing(), name_tokens(text) to hbh_dashboard, service_role;
grant select, insert, update, delete on tax_defaults to hbh_dashboard;
grant select, insert, update on org_settings to hbh_dashboard;
grant select on deal_stage_events to hbh_dashboard;
grant select on v_auto_skipped, v_letter_queue to hbh_dashboard;
create policy dashboard_all on tax_defaults for all to hbh_dashboard using (true) with check (true);
create policy dashboard_all on org_settings for all to hbh_dashboard using (true) with check (true);
create policy dashboard_all on deal_stage_events for all to hbh_dashboard using (true) with check (true);
