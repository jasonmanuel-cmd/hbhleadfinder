-- Harbison Buys Homes — 002: matching, scoring, queue, compliance guards

alter table deals add column compliance_reviewed boolean not null default false;
alter table deals add column compliance_notes text;

-- ---------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;

create trigger properties_updated_at before update on properties for each row execute function set_updated_at();
create trigger owners_updated_at     before update on owners     for each row execute function set_updated_at();
create trigger deals_updated_at      before update on deals      for each row execute function set_updated_at();

-- ---------------------------------------------------------------
-- Address normalization: "123 n. Main Street, Apt 4" -> "123 N MAIN ST UNIT 4"
-- ---------------------------------------------------------------
create or replace function normalize_address(p text) returns text
language plpgsql immutable set search_path = public as $$
declare
  w text; outw text[] := '{}';
  m constant jsonb := '{
    "STREET":"ST","STR":"ST","AVENUE":"AVE","AV":"AVE","ROAD":"RD","DRIVE":"DR","DRV":"DR",
    "BOULEVARD":"BLVD","LANE":"LN","COURT":"CT","PLACE":"PL","CIRCLE":"CIR","HIGHWAY":"HWY",
    "PARKWAY":"PKWY","TERRACE":"TER","TRAIL":"TRL","WAY":"WAY","SQUARE":"SQ","LOOP":"LOOP",
    "NORTH":"N","SOUTH":"S","EAST":"E","WEST":"W","NORTHEAST":"NE","NORTHWEST":"NW",
    "SOUTHEAST":"SE","SOUTHWEST":"SW","APARTMENT":"UNIT","APT":"UNIT","STE":"UNIT",
    "SUITE":"UNIT","#":"UNIT"}'::jsonb;
begin
  if p is null then return null; end if;
  p := upper(split_part(p, ',', 1));                 -- street line only
  p := regexp_replace(p, '#', ' # ', 'g');
  p := regexp_replace(p, '[^A-Z0-9# ]', ' ', 'g');
  p := regexp_replace(trim(p), '\s+', ' ', 'g');
  if p = '' then return null; end if;
  foreach w in array string_to_array(p, ' ') loop
    outw := outw || coalesce(m ->> w, w);
  end loop;
  return regexp_replace(array_to_string(outw, ' '), 'UNIT UNIT', 'UNIT', 'g');
end $$;

create or replace function normalize_apn(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g'), '')
$$;

-- ---------------------------------------------------------------
-- Scoring (0-100). Urgency 40 · Equity 25 · Condition 10 · Authority 10 · Exit 15 · minus Risk
-- ---------------------------------------------------------------
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
  v_next_auction date;
begin
  select * into p from properties where id = p_property_id;
  if not found then return jsonb_build_object('error','property not found'); end if;

  -- Is a foreclosure currently active (start event with no later cancel/rescind/sale)?
  select max(coalesce(event_date, recorded_date, created_at::date)) into v_fc_start
    from distress_events where property_id = p.id
     and event_type in ('notice_of_default','notice_of_trustee_sale','lis_pendens','foreclosure_judgment');
  select max(coalesce(event_date, recorded_date, created_at::date)) into v_fc_end
    from distress_events where property_id = p.id
     and event_type in ('trustee_sale_cancelled','notice_of_rescission','foreclosure_sold');
  v_fc_active := v_fc_start is not null and (v_fc_end is null or v_fc_end < v_fc_start);

  -- URGENCY: strongest live signal (not a sum), recency-decayed, +2 per extra distinct signal (cap 5)
  with ev as (
    select event_type,
           coalesce(event_date, recorded_date, created_at::date) as d,
           case event_type
             when 'notice_of_trustee_sale' then 35 when 'foreclosure_judgment' then 35
             when 'notice_of_default' then 30 when 'lis_pendens' then 30
             when 'inbound_seller_request' then 30
             when 'probate_opened' then 25 when 'letters_testamentary' then 25
             when 'power_to_sell' then 25 when 'co_owner_referral' then 25
             when 'tax_default' then 20 when 'fsbo_listing' then 20 when 'estate_sale' then 20
             when 'vacancy_signal' then 15 when 'code_violation' then 10
             when 'absentee_owner' then 5 else 0 end as w
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
  v_reason := v_reason || jsonb_build_object('foreclosure_active', v_fc_active, 'live_signals', v_signals);

  -- EQUITY (needs value AND debt; unknown debt scores 0, not a guess)
  if coalesce(p.estimated_market_value, 0) > 0 and p.estimated_loan_balance is not null then
    v_pct := (p.estimated_market_value - p.estimated_loan_balance - coalesce(p.estimated_other_liens, 0))
             / p.estimated_market_value;
    v_equity := case when v_pct >= 0.50 then 25 when v_pct >= 0.35 then 20
                     when v_pct >= 0.20 then 10 when v_pct > 0 then 3 else 0 end;
    v_reason := v_reason || jsonb_build_object('equity_pct', round(v_pct, 3));
  else
    v_reason := v_reason || jsonb_build_object('equity_pct', 'unknown');
  end if;

  -- CONDITION
  if p.condition_rating is not null then
    v_condition := p.condition_rating * 2;
  elsif p.vacant_signal or exists (select 1 from distress_events
                                    where property_id = p.id and event_type = 'code_violation') then
    v_condition := 4;
  end if;

  -- AUTHORITY
  select count(*), coalesce(bool_or(is_decision_maker
           or ownership_role in ('executor','administrator','trustee')), false)
    into v_owner_count, v_dm
    from property_owners where property_id = p.id;
  v_authority := case when v_dm then 10 when v_owner_count > 0 then 4 else 0 end;

  -- EXIT (70% rule as screening heuristic only)
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

  -- RISK
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

  v_total := greatest(0, least(100, v_urgency + v_equity + v_condition + v_authority + v_exit - v_risk));
  v_tier  := case when v_total >= 70 then 'A' when v_total >= 50 then 'B' when v_total >= 30 then 'C' else 'D' end;

  -- Equity-purchaser statute (e.g. CA Civ. Code §1695): owner-occupied (unknown = assume yes), 1-4 units, active foreclosure
  select coalesce(sr.equity_purchase_law, false) and v_fc_active
         and coalesce(p.owner_occupied, true) and coalesce(p.units, 1) <= 4
    into v_epl from state_rules sr where sr.state = p.state;
  v_epl := coalesce(v_epl, false);

  insert into lead_scores (property_id, urgency_score, equity_score, condition_score, authority_score,
                           exit_score, risk_score, total_score, lead_tier, equity_purchase_law_applies,
                           score_reasoning, calculated_at)
  values (p.id, v_urgency, v_equity, v_condition, v_authority, v_exit, v_risk, v_total, v_tier, v_epl,
          v_reason || jsonb_build_object('rule_version', 'v2'), now())
  on conflict (property_id) do update set
    urgency_score = excluded.urgency_score, equity_score = excluded.equity_score,
    condition_score = excluded.condition_score, authority_score = excluded.authority_score,
    exit_score = excluded.exit_score, risk_score = excluded.risk_score,
    total_score = excluded.total_score, lead_tier = excluded.lead_tier,
    equity_purchase_law_applies = excluded.equity_purchase_law_applies,
    score_reasoning = excluded.score_reasoning, calculated_at = now();

  -- Spend gating: paid valuation only for real distress; contact data only for A/B
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
                            'equity_purchase_law_applies', v_epl);
end $$;

-- ---------------------------------------------------------------
-- Intake resolver: APN first, then address; conflicts go to review, never auto-merge
-- ---------------------------------------------------------------
create or replace function process_raw_property_lead(p_intake_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r raw_lead_intake%rowtype;
  v_pid uuid; v_apn text; v_addr text; v_existing_apn text; v_n int;
  v_state char(2); v_county text; v_zip text; v_owner uuid; v_score jsonb;
begin
  select * into r from raw_lead_intake where id = p_intake_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if r.processing_status in ('processed','ignored') then
    return jsonb_build_object('status', 'already_' || r.processing_status, 'property_id', r.property_id);
  end if;

  begin
    v_state  := upper(r.raw_state);
    v_county := initcap(trim(r.raw_county));
    v_apn    := normalize_apn(coalesce(r.raw_apn, r.raw_payload ->> 'apn'));
    v_addr   := normalize_address(r.raw_address);
    v_zip    := left(regexp_replace(coalesce(r.raw_zip, ''), '[^0-9]', '', 'g'), 5);
    v_zip    := nullif(v_zip, '');

    if v_apn is null and v_addr is null then
      update raw_lead_intake set processing_status = 'needs_review',
             processing_error = 'No APN or usable address' where id = r.id;
      return jsonb_build_object('status','needs_review','reason','no_identifier');
    end if;

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

    if nullif(trim(r.raw_owner_name), '') is not null and not exists (
         select 1 from property_owners po join owners o on o.id = po.owner_id
          where po.property_id = v_pid and upper(o.full_name) = upper(trim(r.raw_owner_name))) then
      insert into owners (full_name, contact_source) values (trim(r.raw_owner_name), r.source_name)
      returning id into v_owner;
      insert into property_owners (property_id, owner_id, ownership_role, is_decision_maker, source)
      values (v_pid, v_owner, coalesce(r.raw_payload ->> 'party_role', 'owner'), false, r.source_name);
    end if;

    insert into deals (property_id) values (v_pid) on conflict do nothing;

    if not exists (select 1 from properties where id = v_pid and regrid_id is not null) then
      insert into enrichment_jobs (property_id, enrichment_type, provider, priority)
      values (v_pid, 'parcel', 'regrid', 100) on conflict do nothing;
    end if;

    update raw_lead_intake set processing_status = 'processed', processing_error = null,
           property_id = v_pid, processed_at = now() where id = r.id;

    v_score := recalculate_lead_score(v_pid);
    return jsonb_build_object('status','processed','property_id', v_pid, 'score', v_score);

  exception when others then
    -- inner block rolled back; record the failure and DON'T re-raise (re-raising would erase this too)
    update raw_lead_intake set processing_status = 'failed', processing_error = sqlerrm where id = p_intake_id;
    return jsonb_build_object('status','failed','error', sqlerrm);
  end;
end $$;

create or replace function process_pending_intake(p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_res jsonb; v_out jsonb := '[]'::jsonb;
begin
  for v_id in select id from raw_lead_intake where processing_status = 'pending'
               order by received_at limit p_limit loop
    v_res := process_raw_property_lead(v_id);
    v_out := v_out || jsonb_build_array(v_res);
  end loop;
  return jsonb_build_object('processed', jsonb_array_length(v_out), 'results', v_out);
end $$;

-- ---------------------------------------------------------------
-- Enrichment queue
-- ---------------------------------------------------------------
create or replace function claim_enrichment_jobs(p_type text, p_worker text, p_limit int default 5)
returns table (job_id uuid, property_id uuid, provider text, state char(2), county text,
               apn text, address_line_1 text, city text, zip text)
language plpgsql security definer set search_path = public as $$
begin
  return query
  with nxt as (
    select ej.id from enrichment_jobs ej
     where ej.status = 'queued' and ej.enrichment_type = p_type and ej.available_at <= now()
     order by ej.priority desc, ej.created_at
     for update skip locked limit p_limit
  ), upd as (
    update enrichment_jobs ej set status = 'processing', locked_at = now(),
           locked_by = p_worker, attempts = ej.attempts + 1
      from nxt where ej.id = nxt.id
    returning ej.id, ej.property_id, ej.provider
  )
  select upd.id, upd.property_id, upd.provider, p.state, p.county, p.apn, p.address_line_1, p.city, p.zip
    from upd join properties p on p.id = upd.property_id;
end $$;

-- p_status: 'completed' | 'failed' | 'skipped'. Failures retry 15m -> 2h -> 1d, then fail for manual review.
create or replace function finish_enrichment_job(p_job_id uuid, p_status text, p_error text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j enrichment_jobs%rowtype;
begin
  select * into j from enrichment_jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('error','job not found'); end if;

  if p_status = 'failed' and j.attempts < j.max_attempts then
    update enrichment_jobs set status = 'queued', locked_at = null, locked_by = null, last_error = p_error,
           available_at = now() + case j.attempts when 1 then interval '15 minutes'
                                                 when 2 then interval '2 hours'
                                                 else interval '1 day' end
     where id = j.id;
    return jsonb_build_object('status','requeued','attempts', j.attempts);
  end if;

  update enrichment_jobs set status = p_status, completed_at = now(), locked_at = null,
         locked_by = null, last_error = p_error where id = j.id;
  perform recalculate_lead_score(j.property_id);
  return jsonb_build_object('status', p_status);
end $$;

create or replace function release_stale_enrichment_jobs() returns integer
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update enrichment_jobs set status = 'queued', locked_at = null, locked_by = null,
         available_at = now() + interval '15 minutes',
         last_error = coalesce(last_error, 'Lock expired; job requeued')
   where status = 'processing' and locked_at < now() - interval '20 minutes' and attempts < max_attempts;
  get diagnostics n = row_count;
  update enrichment_jobs set status = 'failed', locked_at = null, locked_by = null,
         last_error = coalesce(last_error, 'Lock expired; max attempts reached')
   where status = 'processing' and locked_at < now() - interval '20 minutes' and attempts >= max_attempts;
  return n;
end $$;

-- ---------------------------------------------------------------
-- Compliance guards (enforced in the database, not in someone's memory)
-- ---------------------------------------------------------------
create or replace function guard_outreach() returns trigger
language plpgsql security definer set search_path = public as $$
declare o owners%rowtype;
begin
  if new.owner_id is not null then
    select * into o from owners where id = new.owner_id;
    if new.status = 'opted_out' then
      update owners set do_not_contact = true where id = new.owner_id;
      return new;
    end if;
    if new.direction = 'outbound' then
      if o.do_not_contact then raise exception 'Blocked: % is marked do-not-contact', o.full_name; end if;
      if new.channel = 'call'  and o.do_not_call   then raise exception 'Blocked: % is on do-not-call', o.full_name; end if;
      if new.channel = 'sms'   and o.sms_opt_out   then raise exception 'Blocked: % opted out of SMS', o.full_name; end if;
      if new.channel = 'email' and o.email_opt_out then raise exception 'Blocked: % opted out of email', o.full_name; end if;
    end if;
  end if;
  return new;
end $$;
create trigger outreach_guard before insert on outreach for each row execute function guard_outreach();

create or replace function guard_deal_stage() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage in ('offer_sent','under_contract','closed')
     and not new.compliance_reviewed
     and exists (select 1 from lead_scores where property_id = new.property_id
                   and equity_purchase_law_applies) then
    raise exception 'Blocked: equity-purchaser statute likely applies (owner-occupied home in active foreclosure). Use the statute-compliant contract and set compliance_reviewed = true after attorney review.';
  end if;
  return new;
end $$;
create trigger deals_compliance_guard before insert or update on deals for each row execute function guard_deal_stage();
