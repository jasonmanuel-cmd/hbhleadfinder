'use server';
import { redirect } from 'next/navigation';
import { sql, dbError } from '@/lib/db';
import { str } from '@/lib/format';

const UUID = /^[0-9a-f-]{36}$/i;

export async function fixAndRetry(fd) {
  const id = String(fd.get('id') || '');
  let msg = null, err = null, dest = null;
  try {
    if (!UUID.test(id)) throw new Error('Bad id');
    if (!str(fd, 'raw_apn') && !str(fd, 'raw_address')) throw new Error('Enter an APN or a street address.');
    await sql`update raw_lead_intake set
                raw_apn = ${str(fd, 'raw_apn')}, raw_address = ${str(fd, 'raw_address')},
                raw_city = coalesce(${str(fd, 'raw_city')}, raw_city), raw_zip = coalesce(${str(fd, 'raw_zip')}, raw_zip),
                processing_status = 'pending', processing_error = null
              where id = ${id} and processing_status in ('needs_review','failed','needs_property_match')`;
    const [{ res }] = await sql`select process_raw_property_lead(${id}) as res`;
    if (res.status === 'processed') dest = `/leads/${res.property_id}?ok=${encodeURIComponent('Resolved and scored.')}`;
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
