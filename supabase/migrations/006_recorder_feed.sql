-- 006: county recorder feed support
-- Recorder indexes give document number, date and borrower NAMES — no APN, no address.
-- Name-only records are attached to an already-tracked property when the owner name matches,
-- otherwise they wait in a "find the parcel" queue for a human match.

alter table raw_lead_intake drop constraint raw_lead_intake_processing_status_check;
alter table raw_lead_intake add constraint raw_lead_intake_processing_status_check
  check (processing_status in ('pending','processing','processed','failed','ignored','needs_review','needs_property_match'));

-- Order-insensitive name key: "Doe Jane A" = "JANE A DOE"
create or replace function name_key(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(array_to_string(array(
           select t from unnest(string_to_array(
             regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9 ]', ' ', 'g'), ' ')) t
           where t <> '' order by t), ' '), '')
$$;

create index if not exists owners_name_key_idx on owners (name_key(full_name));

-- Bookkeeping for automated pulls
create table if not exists source_runs (
  id           uuid primary key default gen_random_uuid(),
  source_id    text not null references lead_sources(id),
  trigger      text not null default 'cron',     -- cron | manual
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','ok','error')),
  window_from  date,
  window_to    date,
  fetched      integer not null default 0,
  inserted     integer not null default 0,
  processed    integer not null default 0,
  matched      integer not null default 0,
  needs_match  integer not null default 0,
  error        text
);
create index if not exists source_runs_source_idx on source_runs (source_id, started_at desc);
alter table source_runs enable row level security;

-- Resolver v3: adds name-based attach + co-borrowers
create or replace function process_raw_property_lead(p_intake_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r raw_lead_intake%rowtype;
  v_pid uuid; v_apn text; v_addr text; v_existing_apn text; v_n int;
  v_state char(2); v_county text; v_zip text; v_owner uuid; v_score jsonb;
  v_names text[]; v_name text; v_matched_by_name boolean := false;
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
    v_zip    := nullif(left(regexp_replace(coalesce(r.raw_zip, ''), '[^0-9]', '', 'g'), 5), '');

    -- every person named on the record (primary + co-borrowers)
    select array_agg(distinct n) into v_names from (
      select trim(r.raw_owner_name) as n where nullif(trim(r.raw_owner_name), '') is not null
      union all
      select trim(x) from jsonb_array_elements_text(coalesce(r.raw_payload -> 'borrowers', '[]'::jsonb)) x
       where nullif(trim(x), '') is not null
    ) s;

    if v_apn is null and v_addr is null then
      -- name-only record: attach to a tracked property in this county if exactly one owner-name match
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
        if r.source_type in ('notice_of_rescission','trustee_sale_cancelled','foreclosure_sold','trustee_sale_postponed') then
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

    -- link every named person not already linked (name-key match avoids "DOE JANE" vs "Jane Doe" duplicates)
    foreach v_name in array coalesce(v_names, '{}') loop
      if not exists (select 1 from property_owners po join owners o on o.id = po.owner_id
                      where po.property_id = v_pid and name_key(o.full_name) = name_key(v_name)) then
        insert into owners (full_name, contact_source) values (v_name, r.source_name) returning id into v_owner;
        insert into property_owners (property_id, owner_id, ownership_role, is_decision_maker, source)
        values (v_pid, v_owner, coalesce(r.raw_payload ->> 'party_role', 'owner'), false, r.source_name);
      end if;
    end loop;

    insert into deals (property_id) values (v_pid) on conflict do nothing;

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

create or replace view v_needs_review with (security_invoker = true) as
select id, source_name, source_type, raw_state, raw_county, raw_apn, raw_address,
       processing_status, processing_error, received_at
  from raw_lead_intake where processing_status in ('needs_review','failed')
 order by received_at desc;

create or replace view v_needs_match with (security_invoker = true) as
select i.id, i.source_name, i.source_type, i.raw_state, i.raw_county, i.raw_owner_name,
       coalesce(i.raw_payload -> 'borrowers', '[]'::jsonb) as borrowers,
       i.raw_payload ->> 'document_number' as document_number,
       coalesce(i.event_date, nullif(i.raw_payload ->> 'recorded_date', '')::date) as recorded_date,
       i.processing_error, i.received_at
  from raw_lead_intake i
 where i.processing_status = 'needs_property_match'
 order by case i.source_type when 'notice_of_trustee_sale' then 0 else 1 end,
          coalesce(i.event_date, nullif(i.raw_payload ->> 'recorded_date', '')::date) desc;

revoke execute on function process_raw_property_lead(uuid) from public, anon, authenticated;
grant execute on function process_raw_property_lead(uuid) to service_role, hbh_dashboard;
grant select, insert, update on source_runs to hbh_dashboard;
grant select on v_needs_match to hbh_dashboard;
create policy dashboard_all on source_runs for all to hbh_dashboard using (true) with check (true);
