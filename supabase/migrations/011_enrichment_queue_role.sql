-- Enrichment queue: make the claimed job self-describing, and let the dashboard
-- role work the queue.
--
-- Two real problems, both found by running the worker against a live database:
--
-- 1. `claim_enrichment_jobs` did not return `enrichment_type`. The worker asked
--    the claimed row which type it was so it could pick a provider, got null,
--    and skipped every job with "No provider is configured" -- while the
--    provider sat right there in the table. The type is now returned.
--
-- 2. The queue functions were granted to `service_role` only. The dashboard
--    connects as `hbh_dashboard`, so in production the worker would have been
--    refused at the first `claim`. The dashboard role is the one that owns the
--    queue, so it gets the queue functions too.
--
-- The old signature is dropped first: a function's return type is part of its
-- identity, so adding a column to the result means a new function.

drop function if exists claim_enrichment_jobs(text, text, int);

create or replace function claim_enrichment_jobs(p_type text, p_worker text, p_limit int default 5)
returns table (job_id uuid, property_id uuid, enrichment_type text, provider text,
               state char(2), county text, apn text, address_line_1 text, city text, zip text)
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
      returning ej.id, ej.property_id, ej.enrichment_type, ej.provider
  )
  select upd.id, upd.property_id, upd.enrichment_type, upd.provider,
         p.state, p.county, p.apn, p.address_line_1, p.city, p.zip
    from upd join properties p on p.id = upd.property_id;
end $$;

comment on function claim_enrichment_jobs(text, text, int) is
  'Claim up to p_limit queued jobs of type p_type for worker p_worker. Returns enrichment_type so the caller can pick a provider.';

-- The dashboard role owns the queue, so it gets the queue functions.
grant execute on function claim_enrichment_jobs(text, text, int),
                      finish_enrichment_job(uuid, text, text),
                      release_stale_enrichment_jobs()
  to service_role, hbh_dashboard;

revoke execute on function claim_enrichment_jobs(text, text, int),
                       finish_enrichment_job(uuid, text, text),
                       release_stale_enrichment_jobs()
  from public, anon, authenticated;

-- The worker writes the provider's findings onto the property, and the queue
-- view on the Sources page reads the jobs.
grant select, insert, update on enrichment_jobs to hbh_dashboard;
grant insert, update on enrichment_runs to hbh_dashboard;
