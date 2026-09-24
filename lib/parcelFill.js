import { sql } from '@/lib/db';
import { parcelResolver } from '@/lib/parcels';

// A parcel we already track under a longer key (Kern tax records use the 11-digit ATN) — reuse its APN
// string so the filing attaches to that property instead of creating a duplicate.
export async function existingApn(state, county, apn) {
  if (!apn) return apn;
  const [row] = await sql`
    select apn from properties
     where state = ${state} and county = ${county} and apn_key is not null
       and parcel_key8(apn_key) = parcel_key8(${apn})
     order by length(apn_key) desc limit 1`;
  return row?.apn || apn;
}

// Replace a missing or "APN 123-…" placeholder address with a real one.
export async function fixPropertyAddress(propertyId, { address, city, zip }) {
  if (!propertyId || !address) return false;
  const res = await sql`
    update properties set
           address_line_1 = case when real_address(address_line_1) then address_line_1 else ${address} end,
           address_key = case when real_address(address_line_1) then address_key else normalize_address(${address}) end,
           city = coalesce(city, ${city}), zip = coalesce(nullif(zip, ''), ${zip}), updated_at = now()
     where id = ${propertyId} and (not real_address(address_line_1) or nullif(zip, '') is null or city is null)
    returning id`;
  return res.length > 0;
}

// Fill street addresses from the county parcel map for leads that only have an APN. Best-first, time-boxed.
export async function fillMissingAddresses({ limit = 60, deadline = Date.now() + 60000 } = {}) {
  const todo = await sql`select property_id, state, county, apn from v_needs_address limit ${limit}`;
  let filled = 0, none = 0, failed = 0;
  for (const t of todo) {
    if (Date.now() > deadline) break;
    const r = parcelResolver(t.state, t.county);
    if (!r) continue;
    try {
      const hit = await r.fromApn({ apn: t.apn });
      if (hit?.address) {
        await fixPropertyAddress(t.property_id, hit);
        if (!hit.zip) await sql`update properties set source_metadata = source_metadata || '{"address_lookup":"none"}'::jsonb
                                 where id = ${t.property_id}`;
        filled++;
      } else {
        // vacant land / no situs: stop asking the county every run
        await sql`update properties set source_metadata = source_metadata || '{"address_lookup":"none"}'::jsonb
                   where id = ${t.property_id}`;
        none++;
      }
    } catch {
      failed++;
    }
  }
  const [{ n }] = await sql`select count(*)::int as n from v_needs_address`;
  return { filled, none, failed, remaining: n };
}

// Tax-list name match + auto-skip; cheap, run after every pull and history build
export async function tidyQueue({ minPriority = 15 } = {}) {
  const [{ m }] = await sql`select match_tax_defaults() as m`;
  const [{ s }] = await sql`select auto_skip_dead_filings(${minPriority}) as s`;
  return { taxMatched: m.matched, taxSeveral: m.several, skipped: s };
}
