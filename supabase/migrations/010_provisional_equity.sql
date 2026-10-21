-- 010: provisional equity, and an honest label for it
--
-- The lead score gives 25 of its 100 points to equity. The equity rule needs a dollar
-- value and a dollar balance, and nothing in the daily feed produces either: the
-- counties publish assessed values but not mortgage balances, and the recorder's
-- grantor/grantee index publishes no amounts at all.
--
-- Migration 007 already let the recorded owner history stand in for the missing
-- numbers, at 12 points for a high hint and 6 for a moderate one. That was too little
-- to move anything: a lead straight off the feed topped out at urgency 40 + equity 12
-- + condition 4 + authority 10 = 66, so Tier A -- the "call these first" list -- could
-- never fill, however good the property was.
--
-- This raises the provisional points to the bands the dollar rule uses, stops a
-- truncated history from counting, and records that the equity is provisional so the
-- dashboard can label it. A real valuation, once the enrichment worker runs, still
-- replaces it.

alter table lead_scores add column if not exists equity_provisional boolean not null default false;

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
  v_hint text; v_prov boolean := false;
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
    v_reason := v_reason || jsonb_build_object('equity_pct', round(v_pct, 3), 'equity_source', 'underwritten');
  else
    -- Provisional equity from the recorded owner history, until real numbers arrive.
    --
    -- This already existed at 12 points for a high hint and 6 for a moderate one, which
    -- was too little to matter: a lead straight off the daily feed tops out at
    -- urgency 40 + equity 12 + condition 4 + authority 10 = 66, so Tier A -- the
    -- "call these first" list -- could never fill from the feed, however good the
    -- property was. Ranking a list nobody can act on is the thing to avoid.
    --
    -- Three changes:
    --   * the hint maps onto the same bands the dollar rule uses, at the low end of
    --     the band it implies: high -> the >=35% band -> 20, moderate -> the >=20%
    --     band -> 10. Recorded history is weaker evidence than a valuation, so it
    --     takes the bottom of the band rather than the middle.
    --   * a truncated history is not counted. The dossier is cut short when the
    --     county's index has more documents than we read, so it is not the whole
    --     story and must not push a lead up the list.
    --   * the score records that the equity is provisional, so the dashboard can say
    --     so instead of passing a guess off as a valuation.
    select d.signals->>'equity_hint' into v_hint
      from borrower_dossiers d
      join raw_lead_intake i on i.id = d.intake_id
     where i.property_id = p.id and d.error is null and not d.truncated
     order by d.fetched_at desc
     limit 1;

    v_equity := case v_hint when 'high' then 20 when 'moderate' then 10 else 0 end;
    v_prov := v_equity > 0;
    v_reason := v_reason || jsonb_build_object('equity_pct', 'unknown',
                                               'equity_hint', coalesce(v_hint, 'unknown'),
                                               'equity_source', case when v_prov then 'recorded_history' else 'unknown' end);
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
                           est_sale_date, equity_provisional, score_reasoning, calculated_at)
  values (p.id, v_urgency, v_equity, v_condition, v_authority, v_exit, v_risk, v_total, v_tier, v_epl,
          v_est_sale, v_prov, v_reason || jsonb_build_object('rule_version', 'v4'), now())
  on conflict (property_id) do update set
    urgency_score = excluded.urgency_score, equity_score = excluded.equity_score,
    condition_score = excluded.condition_score, authority_score = excluded.authority_score,
    exit_score = excluded.exit_score, risk_score = excluded.risk_score,
    total_score = excluded.total_score, lead_tier = excluded.lead_tier,
    equity_purchase_law_applies = excluded.equity_purchase_law_applies,
    est_sale_date = excluded.est_sale_date,
    equity_provisional = excluded.equity_provisional,
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
-- keep the view in step with the new column
drop view if exists v_action_list;
create view v_action_list with (security_invoker = true) as
select p.id as property_id, p.state, p.county, p.address_line_1, p.city, p.zip, p.apn,
       ls.lead_tier, ls.total_score, ls.urgency_score, ls.equity_score, ls.risk_score,
       ls.equity_purchase_law_applies, ls.equity_provisional,
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

grant execute on function recalculate_lead_score(uuid) to hbh_dashboard;
