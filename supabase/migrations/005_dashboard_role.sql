-- 005: least-privilege role for the Vercel dashboard.
-- Login + password are set out-of-band (never stored in migrations):
--   alter role hbh_dashboard with login password '<secret>';
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'hbh_dashboard') then
    create role hbh_dashboard nologin;
  end if;
end $$;

grant usage on schema public to hbh_dashboard;
grant select on all tables in schema public to hbh_dashboard;
grant insert, update on raw_lead_intake, properties, owners, property_owners, deals, outreach to hbh_dashboard;
grant delete on property_owners to hbh_dashboard;
grant execute on function process_pending_intake(int), process_raw_property_lead(uuid), recalculate_lead_score(uuid) to hbh_dashboard;
alter role hbh_dashboard set statement_timeout = '15s';

do $$ declare t text; begin
  foreach t in array array['state_rules','jurisdictions','lead_sources','raw_lead_intake','properties','owners',
                           'property_owners','distress_events','enrichment_jobs','enrichment_runs','lead_scores',
                           'deals','outreach'] loop
    execute format('create policy dashboard_all on %I for all to hbh_dashboard using (true) with check (true)', t);
  end loop;
end $$;
