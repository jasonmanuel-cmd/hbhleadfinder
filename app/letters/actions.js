'use server';
import { redirect } from 'next/navigation';
import { sql, dbError } from '@/lib/db';
import { KIND, followUpDays } from '@/lib/letters';

const UUID = /^[0-9a-f-]{36}$/i;
const KEYS = ['letter_company', 'letter_sender', 'letter_phone', 'letter_email', 'letter_return_address', 'letter_city_line'];

export async function saveSettings(fd) {
  let err = null;
  try {
    for (const k of KEYS) {
      const v = String(fd.get(k) ?? '').trim() || null;
      await sql`insert into org_settings (key, value, updated_at) values (${k}, ${v}, now())
                on conflict (key) do update set value = excluded.value, updated_at = now()`;
    }
  } catch (e) { err = dbError(e); }
  redirect(`/letters?${err ? 'error' : 'ok'}=${encodeURIComponent(err || 'Letter details saved.')}`);
}

// Log one letter per selected property, set the follow-up, move new leads to "contacted"
export async function markMailed(fd) {
  const ids = fd.getAll('id').map(String).filter((x) => UUID.test(x));
  let msg = null, err = null;
  try {
    if (!ids.length) throw new Error('Select at least one letter.');
    const rows = await sql`select * from v_letter_queue where property_id in ${sql(ids)}`;
    let n = 0;
    for (const r of rows) {
      const kind = KIND[r.primary_signal] || 'general';
      const days = followUpDays(kind);
      const ownerId = r.recipient_ids?.[0] || null;
      await sql.begin(async (tx) => {
        await tx`insert into outreach (property_id, owner_id, channel, direction, status, contact_role, next_follow_up_at, notes, created_by)
                 values (${r.property_id}, ${ownerId}, 'letter', 'outbound', 'sent', ${r.recipient_roles?.[0] || null},
                         now() + make_interval(days => ${days}), ${`Letter #${(r.letters_sent || 0) + 1} (${kind})`}, 'letters')`;
        await tx`update deals set stage = case when stage in ('new','researching') then 'contacted' else stage end,
                   next_follow_up_at = least(coalesce(next_follow_up_at, 'infinity'::timestamptz), now() + make_interval(days => ${days})),
                   updated_at = now()
                 where property_id = ${r.property_id}`;
      });
      n++;
    }
    msg = `Logged ${n} letter${n === 1 ? '' : 's'} as mailed. Follow-ups are scheduled; each lead leaves the queue for 21 days.`;
  } catch (e) { err = dbError(e); }
  redirect(`/letters?${err ? 'error' : 'ok'}=${encodeURIComponent(err || msg)}`);
}
