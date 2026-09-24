-- 007: recorder-history dossiers, death/lien signals, sale-date timeline, automatic follow-ups

-- New signal types ----------------------------------------------------------------
alter table distress_events drop constraint distress_events_event_type_check;
alter table distress_events add constraint distress_events_event_type_check check (event_type in (
  'notice_of_default','notice_of_trustee_sale','lis_pendens','foreclosure_judgment',
  'trustee_sale_postponed','trustee_sale_cancelled','notice_of_rescission','foreclosure_sold',
  'probate_opened','letters_testamentary','tax_default','power_to_sell',
  'vacancy_signal','code_violation','absentee_owner','fsbo_listing','estate_sale',
  'bankruptcy','co_owner_referral','inbound_seller_request',
  'death_joint_tenant','tod_affidavit','tax_lien','judgment_lien'));

-- Recorder name-history dossier per filing ---------------------------------------------
create table if not exists borrower_dossiers (
  intake_id   uuid primary key references raw_lead_intake(id) on delete cascade,
  names       text[] not null,
  fetched_at  timestamptz not null default now(),
  doc_count   integer not null default 0,
  truncated   boolean not null default false,
  priority    integer not null default 0,
  signals     jsonb not null default '{}'::jsonb,
  summary     text[] not null default '{}',
  docs        jsonb not null default '[]'::jsonb,
  error       text
);
alter table borrower_dossiers enable row level security;

alter table lead_scores add column if not exists est_sale_date date;
alter table source_runs add column if not exists note text;

-- Estimated earliest sale date (California non-judicial defaults; explicit auction date wins)
create or replace function estimated_sale_date(p_property_id uuid) returns date
language sql stable set search_path = public as $$
  with ev as (
    select event_type, coalesce(event_date, recorded_date, created_at::date) as d, auction_date
      from distress_events where property_id = p_property_id
  ), closed as (
    select max(d) as d from ev where event_type in ('trustee_sale_cancelled','notice_of_rescission','foreclosure_sold')
  ), s as (
    select max(auction_date) filter (where auction_date >= current_date) as auction,
           max(d) filter (where event_type = 'notice_of_trustee_sale') as nts,
           max(d) filter (where event_type = 'notice_of_default') as nod
      from ev
  )
  select case
           when s.auction is not null then s.auction
           when s.nts is not null and (closed.d is null or closed.d < s.nts) then s.nts + 21
           when s.nod is not null and (closed.d is null or closed.d < s.nod) then s.nod + 111
         end
    from s, closed
$$;

-- Scoring v3 ------------------------------------------------------------------------
create or replace function recalculate_lead_score(p_property_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p properties%rowtype;
  v_fc_start date; v_fc_end date; v_fc_active boolean;
  v_urgency int := 0; v_signals int := 0;
  v_equity int := 0; v_condition int := 0; v_authority int := 0; v_exit int := 0; v_risk int := 0;
  v_total int; v_tier text; v_epl boolean := false;
  v_pct numeric; v_arv numeric; v_mao numeric; v_debt numeric;
  v_reason jsonb := '{}'::jsonb;
  v_owner_count int; v_dm boolean;
  v_next_auction date; v_est_sale date;
  v_dos jsonb;
begin
  select * into p from properties where id = p_property_id;
  if not found then return jsonb_build_object('error','property not found'); end if;

  select max(coalesce(event_date, recorded_date, created_at::date)) into v_fc_start
    from distress_events where property_id = p.id
     and event_type in ('notice_of_default','notice_of_trustee_sale','lis_pendens','foreclosure_judgment');
  select max(coalesce(event_date, recorded_date, created_at::date)) into v_fc_end
    from distress_events where property_id = p.id
     and event_type in ('trustee_sale_cancelled','notice_of_rescission','foreclosure_sold');
  v_fc_active := v_fc_start is not null and (v_fc_end is null or v_fc_end < v_fc_start);

  with ev as (
    select event_type,
           coalesce(event_date, recorded_date, created_at::date) as d,
           case event_type
             when 'notice_of_trustee_sale' then 35 when 'foreclosure_judgment' then 35
             when 'notice_of_default' then 30 when 'lis_pendens' then 30
             when 'inbound_seller_request' then 30 when 'tod_affidavit' then 30
             when 'probate_opened' then 25 when 'letters_testamentary' then 25
             when 'power_to_sell' then 25 when 'co_owner_referral' then 25
             when 'death_joint_tenant' then 20
             when 'tax_default' then 20 when 'fsbo_listing' then 20 when 'estate_sale' then 20
             when 'vacancy_signal' then 15 when 'code_violation' then 10 when 'tax_lien' then 10
             when 'judgment_lien' then 5 when 'absentee_owner' then 5 else 0 end as w
      from distress_events
     where property_id = p.id
       and event_type not in ('trustee_sale_cancelled','notice_of_rescission','foreclosure_sold',
                              'trustee_sale_postponed','bankruptcy')
       and (v_fc_active or event_type not in
            ('notice_of_default','notice_of_trustee_sale','lis_pendens','foreclosure_judgment'))
  ), dec as (
    select event_type, case when d < current_date - 365 then 0
                            when d < current_date - 180 then w / 2 else w end as w
      from ev
  )
  select coalesce(max(w), 0), count(distinct event_type) filter (where w > 0)
    into v_urgency, v_signals from dec;
  v_urgency := v_urgency + least(5, greatest(0, v_signals - 1) * 2);

  v_est_sale := estimated_sale_date(p.id);
  if v_fc_active and v_est_sale is not null and v_est_sale <= current_date + 30 then
    v_urgency := v_urgency + 5;
  end if;
  v_urgency := least(40, v_urgency);
  v_reason := v_reason || jsonb_build_object('foreclosure_active', v_fc_active, 'live_signals', v_signals,
                                             'est_sale_date', v_est_sale);

  -- latest recorder-history dossier for any filing on this property
  select d.signals into v_dos
    from borrower_dossiers d join raw_lead_intake i on i.id = d.intake_id
   where i.property_id = p.id and d.error is null
   order by d.fetched_at desc limit 1;

  if coalesce(p.estimated_market_value, 0) > 0 and p.estimated_loan_balance is not null then
    v_pct := (p.estimated_market_value - p.estimated_loan_balance - coalesce(p.estimated_other_liens, 0))
             / p.estimated_market_value;
    v_equity := case when v_pct >= 0.50 then 25 when v_pct >= 0.35 then 20
                     when v_pct >= 0.20 then 10 when v_pct > 0 then 3 else 0 end;
    v_reason := v_reason || jsonb_build_object('equity_pct', round(v_pct, 3));
  else
    -- provisional equity from recorded loan history until real numbers are entered
    v_equity := case v_dos ->> 'equity_hint' when 'high' then 12 when 'moderate' then 6 else 0 end;
    v_reason := v_reason || jsonb_build_object('equity_pct', 'unknown',
                                               'equity_hint', coalesce(v_dos ->> 'equity_hint', 'unknown'));
  end if;

  if p.condition_rating is not null then
    v_condition := p.condition_rating * 2;
  elsif p.vacant_signal or exists (select 1 from distress_events
                                    where property_id = p.id and event_type = 'code_violation') then
    v_condition := 4;
  end if;

  select count(*), coalesce(bool_or(is_decision_maker
           or ownership_role in ('executor','administrator','trustee')), false)
    into v_owner_count, v_dm
    from property_owners where property_id = p.id and ownership_role <> 'decedent';
  v_authority := case when v_dm then 10 when v_owner_count > 0 then 4 else 0 end;

  v_arv  := coalesce(p.estimated_arv, p.estimated_market_value);
  v_debt := coalesce(p.estimated_loan_balance, 0) + coalesce(p.estimated_other_liens, 0);
  if v_arv is not null and p.estimated_repair_cost is not null and p.estimated_loan_balance is not null then
    v_mao := v_arv * 0.70 - p.estimated_repair_cost;
    v_reason := v_reason || jsonb_build_object('mao_70pct', round(v_mao), 'debt', v_debt);
    if v_mao >= v_debt * 1.10 then v_exit := 15;
    elsif v_mao >= v_debt then v_exit := 8;
    else v_exit := 0; v_risk := v_risk + 20;
         v_reason := v_reason || jsonb_build_object('risk_no_cash_margin', true);
    end if;
  end if;

  if exists (select 1 from distress_events where property_id = p.id and event_type = 'bankruptcy'
               and coalesce(event_date, recorded_date, created_at::date) > current_date - 730) then
    v_risk := v_risk + 20; v_reason := v_reason || jsonb_build_object('risk_bankruptcy', true);
  end if;
  select min(auction_date) into v_next_auction from distress_events
   where property_id = p.id and auction_date >= current_date;
  if v_fc_active and v_next_auction is not null and v_next_auction <= current_date + 7 and not p.title_verified then
    v_risk := v_risk + 25; v_reason := v_reason || jsonb_build_object('risk_auction_imminent_unverified', v_next_auction);
  end if;
  if v_owner_count > 1 and not v_dm then
    v_risk := v_risk + 10; v_reason := v_reason || jsonb_build_object('risk_multi_owner_no_decision_maker', true);
  end if;

  if v_dos is not null then
    if coalesce((v_dos ->> 'prior_defaults')::int, 0) > 0 then v_urgency := least(40, v_urgency + 3); end if;
    if coalesce((v_dos ->> 'solar')::boolean, false) then
      v_risk := v_risk + 5; v_reason := v_reason || jsonb_build_object('risk_solar_lien', true);
    end if;
    if coalesce((v_dos ->> 'open_liens')::int, 0) > 0 then
      v_risk := v_risk + 5; v_reason := v_reason || jsonb_build_object('risk_recorded_liens', (v_dos ->> 'open_liens')::int);
    end if;
    if coalesce((v_dos ->> 'foreclosed')::boolean, false) or coalesce((v_dos ->> 'transferred_out')::boolean, false) then
      v_risk := v_risk + 60; v_reason := v_reason || jsonb_build_object('risk_already_transferred', true);
    end if;
  end if;

  v_total := greatest(0, least(100, v_urgency + v_equity + v_condition + v_authority + v_exit - v_risk));
  v_tier  := case when v_total >= 70 then 'A' when v_total >= 50 then 'B' when v_total >= 30 then 'C' else 'D' end;

  select coalesce(sr.equity_purchase_law, false) and v_fc_active
         and coalesce(p.owner_occupied, true) and coalesce(p.units, 1) <= 4
    into v_epl from state_rules sr where sr.state = p.state;
  v_epl := coalesce(v_epl, false);

  insert into lead_scores (property_id, urgency_score, equity_score, condition_score, authority_score,
                           exit_score, risk_score, total_score, lead_tier, equity_purchase_law_applies,
                           est_sale_date, score_reasoning, calculated_at)
  values (p.id, v_urgency, v_equity, v_condition, v_authority, v_exit, v_risk, v_total, v_tier, v_epl,
          v_est_sale, v_reason || jsonb_build_object('rule_version', 'v3'), now())
  on conflict (property_id) do update set
    urgency_score = excluded.urgency_score, equity_score = excluded.equity_score,
    condition_score = excluded.condition_score, authority_score = excluded.authority_score,
    exit_score = excluded.exit_score, risk_score = excluded.risk_score,
    total_score = excluded.total_score, lead_tier = excluded.lead_tier,
    equity_purchase_law_applies = excluded.equity_purchase_law_applies,
    est_sale_date = excluded.est_sale_date,
    score_reasoning = excluded.score_reasoning, calculated_at = now();

  if v_urgency >= 25 and p.valuation_last_verified_at is null then
    insert into enrichment_jobs (property_id, enrichment_type, priority)
    values (p.id, 'valuation', 50 + v_urgency) on conflict do nothing;
  end if;
  if v_tier in ('A','B') and not exists (
       select 1 from property_owners po join owners o on o.id = po.owner_id
        where po.property_id = p.id and (o.phone is not null or o.email is not null)) then
    insert into enrichment_jobs (property_id, enrichment_type, priority)
    values (p.id, 'contact', v_total) on conflict do nothing;
  end if;

  return jsonb_build_object('property_id', p.id, 'total_score', v_total, 'lead_tier', v_tier,
                            'equity_purchase_law_applies', v_epl, 'est_sale_date', v_est_sale);
end $$;

-- Resolver v4: per-person roles (decedent / heir / executor), attach-only lien types,
-- automatic first follow-up date -----------------------------------------------------------
create or replace function process_raw_property_lead(p_intake_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r raw_lead_intake%rowtype;
  v_pid uuid; v_apn text; v_addr text; v_existing_apn text; v_n int;
  v_state char(2); v_county text; v_zip text; v_owner uuid; v_score jsonb;
  v_names text[]; v_matched_by_name boolean := false;
  v_people jsonb; v_person jsonb; v_pname text;
  v_attach_only boolean;
begin
  select * into r from raw_lead_intake where id = p_intake_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if r.processing_status in ('processed','ignored') then
    return jsonb_build_object('status', 'already_' || r.processing_status, 'property_id', r.property_id);
  end if;

  v_attach_only := r.source_type in ('notice_of_rescission','trustee_sale_cancelled','foreclosure_sold',
                                     'trustee_sale_postponed','tax_lien','judgment_lien');

  begin
    v_state  := upper(r.raw_state);
    v_county := initcap(trim(r.raw_county));
    v_apn    := normalize_apn(coalesce(r.raw_apn, r.raw_payload ->> 'apn'));
    v_addr   := normalize_address(r.raw_address);
    v_zip    := nullif(left(regexp_replace(coalesce(r.raw_zip, ''), '[^0-9]', '', 'g'), 5), '');

    -- people on the record: explicit people[] (with roles) or primary + borrowers[]
    if jsonb_typeof(r.raw_payload -> 'people') = 'array' and jsonb_array_length(r.raw_payload -> 'people') > 0 then
      v_people := r.raw_payload -> 'people';
    else
      select coalesce(jsonb_agg(jsonb_build_object('name', n, 'role', coalesce(r.raw_payload ->> 'party_role', 'owner'),
                                                   'decision_maker', false)), '[]'::jsonb)
        into v_people
        from (select distinct n from (
                select trim(r.raw_owner_name) as n where nullif(trim(r.raw_owner_name), '') is not null
                union all
                select trim(x) from jsonb_array_elements_text(coalesce(r.raw_payload -> 'borrowers', '[]'::jsonb)) x
                 where nullif(trim(x), '') is not null) s) t;
    end if;
    select array_agg(distinct x ->> 'name') into v_names from jsonb_array_elements(v_people) x
     where nullif(trim(x ->> 'name'), '') is not null;

    if v_apn is null and v_addr is null then
      select count(distinct po.property_id), min(po.property_id::text)::uuid into v_n, v_pid
        from property_owners po
        join owners o on o.id = po.owner_id
        join properties p on p.id = po.property_id
       where p.state = v_state and p.county = v_county
         and name_key(o.full_name) = any (select name_key(x) from unnest(coalesce(v_names, '{}')) x);

      if v_n = 1 then
        v_matched_by_name := true;
      else
        v_pid := null;
        if v_attach_only then
          update raw_lead_intake set processing_status = 'ignored',
                 processing_error = case when v_n > 1 then 'Name matches several tracked properties'
                                         else 'No tracked property for these names' end
           where id = r.id;
          return jsonb_build_object('status','ignored','reason','no_tracked_property');
        end if;
        update raw_lead_intake set processing_status = case when v_names is null then 'needs_review' else 'needs_property_match' end,
               processing_error = case when v_names is null then 'No APN, address or names'
                                       when v_n > 1 then 'Names match several tracked properties — pick the parcel'
                                       else 'Names only — find the parcel (APN or address)' end
         where id = r.id;
        return jsonb_build_object('status', case when v_names is null then 'needs_review' else 'needs_property_match' end);
      end if;
    end if;

    if not v_matched_by_name then
      if v_apn is not null then
        select id into v_pid from properties
         where state = v_state and county = v_county and apn_key = v_apn;
      end if;

      if v_pid is null and v_addr is not null then
        select count(*) into v_n from properties
         where state = v_state and county = v_county and address_key = v_addr
           and (v_zip is null or zip is null or zip = v_zip);
        if v_n > 1 then
          update raw_lead_intake set processing_status = 'needs_review',
                 processing_error = 'Ambiguous address match' where id = r.id;
          return jsonb_build_object('status','needs_review','reason','ambiguous_address');
        elsif v_n = 1 then
          select id, apn_key into v_pid, v_existing_apn from properties
           where state = v_state and county = v_county and address_key = v_addr
             and (v_zip is null or zip is null or zip = v_zip);
          if v_apn is not null and v_existing_apn is not null and v_existing_apn <> v_apn then
            update raw_lead_intake set processing_status = 'needs_review',
                   processing_error = format('APN conflict: intake %s vs property %s', v_apn, v_existing_apn)
             where id = r.id;
            return jsonb_build_object('status','needs_review','reason','apn_conflict');
          end if;
        end if;
      end if;

      if v_pid is null then
        insert into properties (state, county, apn, apn_key, address_line_1, city, zip, address_key)
        values (v_state, v_county, r.raw_apn, v_apn, split_part(r.raw_address, ',', 1),
                initcap(r.raw_city), v_zip, v_addr)
        returning id into v_pid;
      else
        update properties set
          apn            = coalesce(apn, r.raw_apn),
          apn_key        = coalesce(apn_key, v_apn),
          address_line_1 = coalesce(address_line_1, split_part(r.raw_address, ',', 1)),
          city           = coalesce(city, initcap(r.raw_city)),
          zip            = coalesce(zip, v_zip),
          address_key    = coalesce(address_key, v_addr)
        where id = v_pid;
      end if;
    end if;

    insert into distress_events (property_id, intake_id, event_type, event_date, recorded_date,
                                 document_number, case_number, auction_date, amount_owed,
                                 source_name, source_url, raw_data)
    values (v_pid, r.id, r.source_type, r.event_date,
            nullif(r.raw_payload ->> 'recorded_date', '')::date,
            nullif(r.raw_payload ->> 'document_number', ''),
            nullif(r.raw_payload ->> 'case_number', ''),
            nullif(r.raw_payload ->> 'auction_date', '')::date,
            nullif(r.raw_payload ->> 'amount_owed', '')::numeric,
            r.source_name, r.source_url, r.raw_payload)
    on conflict do nothing;

    -- link people (lien debtors only annotate; they are already owners if matched)
    if not v_attach_only then
      for v_person in select * from jsonb_array_elements(v_people) loop
        v_pname := trim(v_person ->> 'name');
        continue when v_pname is null or v_pname = '';
        if not exists (select 1 from property_owners po join owners o on o.id = po.owner_id
                        where po.property_id = v_pid and name_key(o.full_name) = name_key(v_pname)) then
          insert into owners (full_name, contact_source) values (v_pname, r.source_name) returning id into v_owner;
          insert into property_owners (property_id, owner_id, ownership_role, is_decision_maker, source)
          values (v_pid, v_owner, coalesce(v_person ->> 'role', 'owner'),
                  coalesce((v_person ->> 'decision_maker')::boolean, false), r.source_name);
        end if;
      end loop;
    end if;

    insert into deals (property_id) values (v_pid) on conflict do nothing;

    -- first follow-up: fast for foreclosure clocks, a respectful 30 days after a death
    update deals set next_follow_up_at = now() + case r.source_type
             when 'notice_of_trustee_sale' then interval '1 day'
             when 'notice_of_default' then interval '2 days'
             when 'death_joint_tenant' then interval '30 days'
             when 'tod_affidavit' then interval '30 days'
             when 'letters_testamentary' then interval '14 days'
             else interval '3 days' end
     where property_id = v_pid and next_follow_up_at is null and stage in ('new','researching')
       and not v_attach_only;

    if not exists (select 1 from properties where id = v_pid and regrid_id is not null) then
      insert into enrichment_jobs (property_id, enrichment_type, provider, priority)
      values (v_pid, 'parcel', 'regrid', 100) on conflict do nothing;
    end if;

    update raw_lead_intake set processing_status = 'processed', processing_error = null,
           property_id = v_pid, processed_at = now() where id = r.id;

    v_score := recalculate_lead_score(v_pid);
    return jsonb_build_object('status','processed','property_id', v_pid, 'matched_by_name', v_matched_by_name,
                              'score', v_score);

  exception when others then
    update raw_lead_intake set processing_status = 'failed', processing_error = sqlerrm where id = p_intake_id;
    return jsonb_build_object('status','failed','error', sqlerrm);
  end;
end $$;

-- Views ---------------------------------------------------------------------------------
drop view if exists v_needs_match;
create view v_needs_match with (security_invoker = true) as
select i.id, i.source_name, i.source_type, i.raw_state, i.raw_county, i.raw_owner_name,
       coalesce(i.raw_payload -> 'borrowers', '[]'::jsonb) as borrowers,
       coalesce(i.raw_payload -> 'people', '[]'::jsonb) as people,
       i.raw_payload ->> 'document_number' as document_number,
       coalesce(i.event_date, nullif(i.raw_payload ->> 'recorded_date', '')::date) as recorded_date,
       i.processing_error, i.received_at,
       case when d.error is null then d.priority end as priority, d.summary, d.signals, d.doc_count, d.truncated,
       d.fetched_at as history_at, d.error as history_error
  from raw_lead_intake i
  left join borrower_dossiers d on d.intake_id = i.id
 where i.processing_status = 'needs_property_match'
 order by coalesce(case when d.error is null then d.priority end, -1) desc,
          coalesce(i.event_date, nullif(i.raw_payload ->> 'recorded_date', '')::date) desc;

create or replace view v_action_list with (security_invoker = true) as
select p.id as property_id, p.state, p.county, p.address_line_1, p.city, p.zip, p.apn,
       ls.lead_tier, ls.total_score, ls.urgency_score, ls.equity_score, ls.risk_score,
       ls.equity_purchase_law_applies,
       (select array_agg(distinct de.event_type) from distress_events de where de.property_id = p.id) as signals,
       (select max(coalesce(de.event_date, de.recorded_date)) from distress_events de where de.property_id = p.id) as latest_event,
       (select min(de.auction_date) from distress_events de where de.property_id = p.id and de.auction_date >= current_date) as next_auction,
       d.stage, d.next_follow_up_at,
       (select max(o.attempted_at) from outreach o where o.property_id = p.id) as last_touch,
       ls.est_sale_date
  from properties p
  join lead_scores ls on ls.property_id = p.id
  left join deals d on d.property_id = p.id
 where ls.lead_tier in ('A','B')
   and coalesce(d.stage, 'new') not in ('closed','lost','dead')
   and (d.next_follow_up_at is null or d.next_follow_up_at <= now())
 order by ls.total_score desc, ls.est_sale_date nulls last;

-- Grants --------------------------------------------------------------------------------
revoke execute on function process_raw_property_lead(uuid) from public, anon, authenticated;
revoke execute on function recalculate_lead_score(uuid) from public, anon, authenticated;
grant execute on function process_raw_property_lead(uuid), recalculate_lead_score(uuid) to service_role, hbh_dashboard;
grant execute on function estimated_sale_date(uuid) to hbh_dashboard;
grant select, insert, update on borrower_dossiers to hbh_dashboard;
grant select on v_needs_match, v_action_list to hbh_dashboard;
create policy dashboard_all on borrower_dossiers for all to hbh_dashboard using (true) with check (true);

-- rescore everything under v3
select recalculate_lead_score(id) from properties;
