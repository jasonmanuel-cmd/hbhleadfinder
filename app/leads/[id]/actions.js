'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { sql, dbError } from '@/lib/db';
import { str, num, bool3, STAGES, EXITS, ROLES, CHANNELS, OUTREACH_STATUS } from '@/lib/format';

const UUID = /^[0-9a-f-]{36}$/i;

function done(id, err, ok) {
  revalidatePath(`/leads/${id}`);
  const q = err ? `?error=${encodeURIComponent(err)}` : ok ? `?ok=${encodeURIComponent(ok)}` : '';
  redirect(`/leads/${id}${q}`);
}

function pid(fd) {
  const id = String(fd.get('property_id') || '');
  if (!UUID.test(id)) throw new Error('Bad property id');
  return id;
}

export async function saveUnderwriting(fd) {
  const id = pid(fd);
  let err = null;
  try {
    const cond = num(fd, 'condition_rating');
    await sql`
      update properties set
        estimated_market_value = ${num(fd, 'estimated_market_value')},
        estimated_arv          = ${num(fd, 'estimated_arv')},
        estimated_repair_cost  = ${num(fd, 'estimated_repair_cost')},
        estimated_loan_balance = ${num(fd, 'estimated_loan_balance')},
        estimated_other_liens  = ${num(fd, 'estimated_other_liens')},
        condition_rating       = ${cond && cond >= 1 && cond <= 5 ? cond : null},
        owner_occupied         = ${bool3(fd, 'owner_occupied')},
        absentee_owner         = ${bool3(fd, 'absentee_owner')},
        units                  = ${num(fd, 'units')},
        property_type          = ${str(fd, 'property_type')},
        vacant_signal          = ${fd.get('vacant_signal') === 'on'},
        title_verified         = ${fd.get('title_verified') === 'on'},
        data_confidence        = 'manual'
      where id = ${id}`;
    await sql`select recalculate_lead_score(${id})`;
  } catch (e) { err = dbError(e); }
  done(id, err, 'Underwriting saved and score recalculated.');
}

export async function addOwner(fd) {
  const id = pid(fd);
  let err = null;
  try {
    const name = str(fd, 'full_name');
    if (!name) throw new Error('Name is required');
    const role = ROLES.includes(str(fd, 'ownership_role')) ? str(fd, 'ownership_role') : 'owner';
    await sql.begin(async (tx) => {
      const [o] = await tx`
        insert into owners (full_name, entity_type, phone, email, mailing_address, contact_source, notes)
        values (${name}, ${str(fd, 'entity_type')}, ${str(fd, 'phone')}, ${str(fd, 'email')},
                ${str(fd, 'mailing_address')}, 'manual', ${str(fd, 'notes')})
        returning id`;
      await tx`
        insert into property_owners (property_id, owner_id, ownership_role, is_decision_maker, source)
        values (${id}, ${o.id}, ${role}, ${fd.get('is_decision_maker') === 'on'}, 'manual')`;
    });
    await sql`select recalculate_lead_score(${id})`;
  } catch (e) { err = dbError(e); }
  done(id, err, 'Contact added.');
}

export async function updateOwner(fd) {
  const id = pid(fd);
  const ownerId = String(fd.get('owner_id') || '');
  let err = null;
  try {
    if (!UUID.test(ownerId)) throw new Error('Bad owner id');
    await sql`
      update owners set
        phone = ${str(fd, 'phone')}, email = ${str(fd, 'email')},
        mailing_address = ${str(fd, 'mailing_address')},
        do_not_contact = ${fd.get('do_not_contact') === 'on'},
        do_not_call = ${fd.get('do_not_call') === 'on'},
        sms_opt_out = ${fd.get('sms_opt_out') === 'on'},
        email_opt_out = ${fd.get('email_opt_out') === 'on'}
      where id = ${ownerId}`;
    const role = ROLES.includes(str(fd, 'ownership_role')) ? str(fd, 'ownership_role') : 'owner';
    await sql`
      update property_owners set ownership_role = ${role},
             is_decision_maker = ${fd.get('is_decision_maker') === 'on'}
       where property_id = ${id} and owner_id = ${ownerId}`;
    await sql`select recalculate_lead_score(${id})`;
  } catch (e) { err = dbError(e); }
  done(id, err, 'Contact updated.');
}

export async function logOutreach(fd) {
  const id = pid(fd);
  let err = null;
  try {
    const channel = str(fd, 'channel');
    const status = str(fd, 'status');
    if (!CHANNELS.includes(channel) || !OUTREACH_STATUS.includes(status)) throw new Error('Pick a channel and result');
    const ownerId = str(fd, 'owner_id');
    const next = str(fd, 'next_follow_up_at');
    const nextTs = next ? new Date(`${next}T16:00:00Z`) : null; // ~9am Pacific
    await sql`
      insert into outreach (property_id, owner_id, channel, direction, status, contact_role, outcome, notes,
                            next_follow_up_at, created_by)
      values (${id}, ${ownerId && UUID.test(ownerId) ? ownerId : null}, ${channel},
              ${str(fd, 'direction') === 'inbound' ? 'inbound' : 'outbound'}, ${status},
              ${str(fd, 'contact_role')}, ${str(fd, 'outcome')}, ${str(fd, 'notes')}, ${nextTs}, 'dashboard')`;
    await sql`
      update deals set
        next_follow_up_at = case when ${status} = 'opted_out' then null
                                 else coalesce(${nextTs}::timestamptz, next_follow_up_at) end,
        stage = case when stage in ('new','researching') and ${status} in ('reached','appointment_set') then 'conversation'
                     when stage in ('new','researching') then 'contacted'
                     else stage end
      where property_id = ${id}`;
  } catch (e) { err = dbError(e); }
  done(id, err, 'Touch logged.');
}

export async function saveDeal(fd) {
  const id = pid(fd);
  let err = null;
  try {
    const stage = STAGES.includes(str(fd, 'stage')) ? str(fd, 'stage') : 'new';
    const exit = EXITS.includes(str(fd, 'best_exit')) ? str(fd, 'best_exit') : null;
    const next = str(fd, 'next_follow_up_at');
    await sql`
      update deals set
        stage = ${stage}, best_exit = ${exit}, offer_amount = ${num(fd, 'offer_amount')},
        seller_goal = ${str(fd, 'seller_goal')}, assigned_to = ${str(fd, 'assigned_to')},
        next_follow_up_at = ${next ? new Date(`${next}T16:00:00Z`) : null},
        compliance_reviewed = ${fd.get('compliance_reviewed') === 'on'},
        compliance_notes = ${str(fd, 'compliance_notes')}
      where property_id = ${id}`;
  } catch (e) { err = dbError(e); }
  done(id, err, 'Deal updated.');
}
