'use server';
import { redirect } from 'next/navigation';
import { sql, dbError } from '@/lib/db';
import { str } from '@/lib/format';
import { completeParcel } from '@/lib/parcels';

const UUID = /^[0-9a-f-]{36}$/i;

export async function fixAndRetry(fd) {
  const id = String(fd.get('id') || '');
  let msg = null, err = null, dest = null;
  try {
    if (!UUID.test(id)) throw new Error('Bad id');
    if (!str(fd, 'raw_apn') && !str(fd, 'raw_address')) throw new Error('Enter an APN or a street address.');
    const [row] = await sql`select raw_state, raw_county from raw_lead_intake where id = ${id}`;
    if (!row) throw new Error('Record not found');
    // fill whichever of APN / address is missing from the county's parcel GIS
    const cz = str(fd, 'raw_cityzip') || '';
    const czZip = (cz.match(/\b\d{5}\b/) || [])[0] || null;
    const czCity = cz.replace(/\b\d{5}(-\d{4})?\b/, '').replace(/,?\s*(CA|California)\s*$/i, '').replace(/[,\s]+$/, '').trim() || null;
    const p = await completeParcel({ state: row.raw_state, county: row.raw_county, apn: str(fd, 'raw_apn'),
      address: str(fd, 'raw_address'), city: str(fd, 'raw_city') || czCity, zip: str(fd, 'raw_zip') || czZip });
    await sql`update raw_lead_intake set
                raw_apn = ${p.apn}, raw_address = ${p.address},
                raw_city = coalesce(${p.city}, raw_city), raw_zip = coalesce(${p.zip}, raw_zip),
                processing_status = 'pending', processing_error = null
              where id = ${id} and processing_status in ('needs_review','failed','needs_property_match')`;
    const [{ res }] = await sql`select process_raw_property_lead(${id}) as res`;
    if (res.status === 'processed') dest = `/leads/${res.property_id}?ok=${encodeURIComponent(`Lead created and scored.${p.note ? ` ${p.note}.` : ''}`)}`;
    else msg = `Still needs review: ${res.reason || res.error}`;
  } catch (e) {
    err = dbError(e);
  }
  redirect(dest || `/review?${err ? 'error' : 'ok'}=${encodeURIComponent(err || msg)}`);
}

export async function ignore(fd) {
  const id = String(fd.get('id') || '');
  if (UUID.test(id)) await sql`update raw_lead_intake set processing_status = 'ignored' where id = ${id}`;
  redirect('/review?ok=Ignored.');
}
