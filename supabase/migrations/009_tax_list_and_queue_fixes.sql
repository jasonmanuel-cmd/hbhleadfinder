-- 009: use the published Kern delinquent-tax list already loaded into intake; APN vs ATN keys; letter-queue hygiene

-- Kern tax records carry the 11-digit ATN (APN + "00" + check digit); recorder/GIS parcels carry the 8-digit APN.
-- Compare on the first 8 digits for Kern.
create or replace function parcel_key8(p text) returns text
language sql immutable set search_path = public as $$
  select left(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), 8)
$$;
create index if not exists properties_key8_idx on properties (state, county, parcel_key8(apn_key));
create index if not exists tax_defaults_key8_idx on tax_defaults (state, county, parcel_key8(apn_key));

-- An "address" that is really a parcel number is no address
create or replace function real_address(p text) returns boolean
language sql immutable set search_path = public as $$
  select p is not null and btrim(p) <> '' and p !~* '^\s*(APN|ATN|PARCEL)\y'
$$;

-- Load the tax-defaulted records other feeds already brought in (newspaper list, GovEase auction list)
insert into tax_defaults (state, county, apn, apn_key, assessee, amount_due, default_year, source)
select distinct on (upper(i.raw_state), initcap(i.raw_county), normalize_apn(i.raw_apn))
       upper(i.raw_state), initcap(i.raw_county), i.raw_apn, normalize_apn(i.raw_apn), i.raw_owner_name,
       nullif(coalesce(i.raw_payload #>> '{raw,amount}', i.raw_payload ->> 'price', i.raw_payload ->> 'amount_owed'), '')::numeric,
       extract(year from i.received_at)::int, i.source_name
  from raw_lead_intake i
 where i.source_type in ('tax_default','power_to_sell')
   and i.raw_apn is not null and length(regexp_replace(i.raw_apn, '[^0-9]', '', 'g')) >= 8
   and nullif(btrim(i.raw_owner_name), '') is not null
 order by upper(i.raw_state), initcap(i.raw_county), normalize_apn(i.raw_apn), i.received_at desc
on conflict do nothing;

create or replace function apply_tax_default_events() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; r record;
begin
  for r in
    select distinct on (p.id) p.id as property_id, td.apn_key, td.default_year, td.amount_due, td.assessee
      from tax_defaults td
      join properties p on p.state = td.state and p.county = td.county
                       and parcel_key8(p.apn_key) = parcel_key8(td.apn_key)
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

-- Letter queue: real street address with ZIP, and a recorder/court signal (not a bare tax delinquency)
drop view if exists v_letter_queue;
create view v_letter_queue with (security_invoker = true) as
with ev as (
  select de.property_id,
         (array_agg(de.event_type order by
            case de.event_type when 'notice_of_trustee_sale' then 1 when 'notice_of_default' then 2
              when 'letters_testamentary' then 3 when 'probate_opened' then 3 when 'tod_affidavit' then 4
              when 'death_joint_tenant' then 4 when 'tax_default' then 5 when 'power_to_sell' then 5 else 9 end,
            coalesce(de.event_date, de.recorded_date) desc))[1] as primary_signal,
         max(coalesce(de.event_date, de.recorded_date)) filter (
           where de.event_type in ('death_joint_tenant','tod_affidavit','letters_testamentary','probate_opened')) as death_date,
         bool_or(de.event_type in ('trustee_sale_cancelled','notice_of_rescission','foreclosure_sold')) as resolved,
         bool_or(de.event_type not in ('tax_default','tax_lien','judgment_lien')) as has_strong_signal,
         max(de.amount_owed) filter (where de.event_type in ('tax_default','power_to_sell')) as tax_owed
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
       ev.primary_signal, ev.death_date, ev.tax_owed, coalesce(lt.letters_sent, 0)::int as letters_sent, lt.last_letter,
       who.recipients, who.recipient_ids, who.recipient_roles, who.decedent,
       ls.lead_tier, ls.total_score, d.stage,
       case when ev.death_date is not null and ev.death_date > current_date - 30 then ev.death_date + 30 end as hold_until
  from properties p
  join ev on ev.property_id = p.id
  join who on who.property_id = p.id
  left join lt on lt.property_id = p.id
  left join lead_scores ls on ls.property_id = p.id
  left join deals d on d.property_id = p.id
 where real_address(p.address_line_1) and nullif(p.zip, '') is not null
   -- tax-only parcels: the list has no mailing address and many owners are absentee — don't mail the situs
   and ev.has_strong_signal
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

-- Properties whose address is missing or is really a parcel number, and that carry a signal worth mailing
create or replace view v_needs_address with (security_invoker = true) as
select p.id as property_id, p.state, p.county, p.apn, p.apn_key, p.address_line_1, p.city, p.zip,
       ls.total_score
  from properties p
  left join lead_scores ls on ls.property_id = p.id
 where (not real_address(p.address_line_1) or nullif(p.zip, '') is null) and p.apn_key is not null
   and exists (select 1 from distress_events de where de.property_id = p.id
                and de.event_type not in ('tax_default','tax_lien','judgment_lien'))
   and coalesce(p.source_metadata ->> 'address_lookup', '') <> 'none'
 order by ls.total_score desc nulls last;

revoke execute on function apply_tax_default_events() from public, anon, authenticated;
grant execute on function apply_tax_default_events(), parcel_key8(text), real_address(text) to hbh_dashboard, service_role;
grant select on v_letter_queue, v_needs_address to hbh_dashboard;

select apply_tax_default_events();
