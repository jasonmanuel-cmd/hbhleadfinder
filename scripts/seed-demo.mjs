#!/usr/bin/env node
// Fill a database with a realistic book of demo business so the dashboard has something
// to show: filings from the Kern recorder feed, scores, tiers, a letter queue, follow-ups
// and a touch history.
//
//   npm run db:seed:demo                     # uses DATABASE_URL
//   npm run db:seed:demo -- --url <url>
//
// Safe to re-run: it clears the demo rows it owns first.

import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = opt('url') || process.env.DATABASE_URL;
if (!url) {
  console.error('No DATABASE_URL. Set it, or pass --url <connection string>.');
  process.exit(1);
}

const { default: postgres } = await import('postgres');
const sql = postgres(url, { max: 1, prepare: false, max_pipeline: 0, connect_timeout: 15, ssl: process.env.PGSSLMODE === 'disable' ? false : undefined });

const FILINGS = [
  { sig: 'notice_of_trustee_sale', apn: '123-456-09', addr: '4820 N Brundage Dr', city: 'Bakersfield', zip: '93311',
    owner: 'SALAZAR MARISOL A', doc: '2026-10001', auction: '2026-11-14', score: 'A' },
  { sig: 'notice_of_default', apn: '234-567-01', addr: '915 Cherry Ave', city: 'Bakersfield', zip: '93304',
    owner: 'OKAFOR CHIDI E', doc: '2026-10002', score: 'B' },
  { sig: 'notice_of_trustee_sale', apn: '345-678-02', addr: '2201 Fife Ave', city: 'Bakersfield', zip: '93301',
    owner: 'NGUYEN THUY MINH', doc: '2026-10003', auction: '2026-10-29', score: 'A' },
  { sig: 'tod_affidavit', apn: '456-789-03', addr: '778 Santa Barbara St', city: 'Bakersfield', zip: '93304',
    owner: 'WHITFIELD HAROLD J', doc: '2026-10004', score: 'B' },
  { sig: 'letters_testamentary', apn: '567-891-04', addr: '3310 Kern River Dr', city: 'Bakersfield', zip: '93308',
    owner: 'BRENNAN PATRICIA L', doc: '2026-10005', score: 'C' },
  { sig: 'notice_of_default', apn: '678-912-05', addr: '1620 East 17th St', city: 'Bakersfield', zip: '93301',
    owner: 'HERRERA RAMON', doc: '2026-10006', score: 'C' },
  { sig: 'notice_of_default', apn: '789-013-06', addr: '4407 Stearns Rd', city: 'Bakersfield', zip: '93306',
    owner: 'ABARA NGOZI E', doc: '2026-10007', score: 'D' },
];

const UNDERWRITING = {
  '2026-10001': { mv: 385000, loan: 210000, arv: 360000, repair: 35000, occ: true, cond: 3, units: 1 },
  '2026-10003': { mv: 512000, loan: 268000, arv: 495000, repair: 42000, occ: true, cond: 4, units: 1 },
  '2026-10002': { mv: 298000, loan: 224000, arv: 285000, repair: 28000, occ: true, cond: 3, units: 1 },
};

try {
  // Clear only the demo rows (identified by their document numbers) so a real database
  // is never wiped by a demo seed.
  const docs = FILINGS.map((f) => f.doc);
  await sql`delete from distress_events where document_number in ${sql(docs)}`;
  await sql`delete from raw_lead_intake where source_record_id in ${sql(docs)}`;
  await sql`delete from outreach where notes like 'demo seed%'`;
  await sql`delete from org_settings where key in ('letter_company','letter_sender','letter_phone','letter_email','letter_return_address','letter_city_line')`;

  for (const f of FILINGS) {
    const payload = { document_number: f.doc, recorded_date: '2026-10-10' };
    if (f.auction) payload.auction_date = f.auction;
    const [row] = await sql`
      insert into raw_lead_intake
        (source_name, source_type, source_record_id, event_date, raw_state, raw_county,
         raw_apn, raw_address, raw_city, raw_zip, raw_owner_name, raw_payload)
      values ('kern_recorder', ${f.sig}, ${f.doc}, current_date, 'CA', 'Kern', ${f.apn}, ${f.addr},
              ${f.city}, ${f.zip}, ${f.owner}, ${sql.json(payload)})
      on conflict do nothing returning id`;
    if (!row) continue;
  }
  await sql`select process_pending_intake(500)`;

  for (const f of FILINGS) {
    const u = UNDERWRITING[f.doc];
    if (!u) continue;
    const [p] = await sql`
      select p.id from properties p
        join distress_events de on de.property_id = p.id
       where de.document_number = ${f.doc} limit 1`;
    if (!p) continue;
    await sql`
      update properties set
        estimated_market_value = ${u.mv}, estimated_loan_balance = ${u.loan},
        estimated_arv = ${u.arv}, estimated_repair_cost = ${u.repair},
        owner_occupied = ${u.occ}, units = ${u.units}, condition_rating = ${u.cond},
        title_verified = false, data_confidence = 'demo'
      where id = ${p.id}`;
    await sql`select recalculate_lead_score(${p.id})`;
  }

  // A couple of people we have already spoken to, and one who must never be contacted.
  const [nguyen] = await sql`select p.id from properties p join distress_events de on de.property_id = p.id
                              where de.document_number = '2026-10003' limit 1`;
  if (nguyen) {
    const [ow] = await sql`select owner_id from property_owners where property_id = ${nguyen.id} limit 1`;
    await sql`update owners set phone = '(661) 555-0143', email = 'tnguyen@example.com' where id = ${ow.owner_id}`;
    await sql`insert into outreach (property_id, owner_id, channel, direction, status, contact_role, outcome, notes, created_by)
               values (${nguyen.id}, ${ow.owner_id}, 'call', 'outbound', 'voicemail', 'owner', null, 'demo seed: left voicemail', 'demo')`;
    await sql`update deals set stage = 'contacted', next_follow_up_at = now() + interval '2 days' where property_id = ${nguyen.id}`;
  }
  const [salazar] = await sql`select p.id from properties p join distress_events de on de.property_id = p.id
                               where de.document_number = '2026-10001' limit 1`;
  if (salazar) {
    const [ow] = await sql`select owner_id from property_owners where property_id = ${salazar.id} limit 1`;
    await sql`update owners set do_not_contact = true, notes = 'demo seed: opted out' where id = ${ow.owner_id}`;
  }

  await sql`
    insert into org_settings (key, value) values
      ('letter_company', 'Harbison Buys Homes'),
      ('letter_sender', 'Jordan Harbison'),
      ('letter_phone', '(661) 555-0101'),
      ('letter_email', 'jordan@example.com'),
      ('letter_return_address', 'PO Box 4471'),
      ('letter_city_line', 'Bakersfield, CA 93311')
    on conflict (key) do update set value = excluded.value`;

  const counts = {
    properties: (await sql`select count(*)::int c from properties`)[0].c,
    tiers: (await sql`select lead_tier, count(*)::int c from lead_scores group by 1 order by 1`),
    letters: (await sql`select count(*)::int c from v_letter_queue`)[0].c,
    toMatch: (await sql`select count(*)::int c from v_needs_match`)[0].c,
  };
  console.log('demo data seeded');
  console.log(`  properties: ${counts.properties}`);
  console.log(`  tiers:      ${counts.tiers.map((t) => `${t.lead_tier}=${t.c}`).join('  ')}`);
  console.log(`  letters:    ${counts.letters} ready to mail`);
  console.log(`  to match:   ${counts.toMatch}`);
} catch (e) {
  console.error(`Seeding failed: ${e.message}`);
  await sql.end();
  process.exit(1);
}
await sql.end();
