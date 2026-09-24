// Seller letters. Plain, honest, and specific about who we are — California treats solicitations to
// owners in foreclosure strictly (Civil Code §§1695 and 2945; B&P Code §17533.6 on look-alike notices).
// Have your attorney read these once before the first mailing.

const ENTITY = /\b(LLC|L L C|INC|CORP|CORPORATION|CO|COMPANY|BANK|ASSN|ASSOCIATION|LP|LTD|PARTNERSHIP|CHURCH|TRUST|HOLDINGS|PROPERTIES|INVESTMENTS)\b/i;
const SUFFIX = /\s+(DECD|DEC'D|DECEASED|EST|ESTATE|TR|TRS|TRUSTEE|ETAL|ET AL|EXTR|EXTX|ADMR|ADMX)\.?$/i;
const cap = (w) => (w.length <= 1 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  .replace(/^(Mc|Mac)([a-z])/, (_, a, b) => a + b.toUpperCase()).replace(/[-'][a-z]/g, (m) => m.toUpperCase());

// Recorder / assessor names are "LAST FIRST MIDDLE"; couples are "LAST FIRST & FIRST" or "LAST FIRST & LAST2 FIRST2"
export function personName(raw) {
  let n = String(raw || '').trim().replace(/\s+/g, ' ');
  while (SUFFIX.test(n)) n = n.replace(SUFFIX, '');
  if (!n) return '';
  if (ENTITY.test(n)) return n.split(' ').map((w) => (/^(LLC|INC|LP|LLP|LTD|CO|II|III)$/.test(w) ? w : cap(w))).join(' ');
  const parts = n.split(/\s*&\s*/).filter(Boolean);
  const first = parts[0].split(' ');
  const last = cap(first[0]);
  const out = [[...first.slice(1).map(cap), last].join(' ')];
  for (const p of parts.slice(1)) {
    const t = p.split(' ');
    out.push(t.length === 1 ? cap(t[0]) : [...t.slice(1).map(cap), cap(t[0])].join(' '));
  }
  if (out.length === 2 && parts[1].split(' ').length === 1) return `${out[0].replace(new RegExp(` ${last}$`), '')} & ${out[1]} ${last}`;
  return out.join(' & ');
}

export const KIND = {
  notice_of_trustee_sale: 'foreclosure', notice_of_default: 'foreclosure',
  death_joint_tenant: 'death', tod_affidavit: 'death',
  letters_testamentary: 'estate', probate_opened: 'estate',
  tax_default: 'tax', power_to_sell: 'tax',
};

const ordinal = ['', '', 'second', 'third'];

// row: v_letter_queue row · s: org settings map
export function buildLetter(row, s) {
  const kind = KIND[row.primary_signal] || 'general';
  const roles = row.recipient_roles || [];
  const execIdx = roles.findIndex((r) => ['executor', 'administrator'].includes(r));
  const names = (row.recipients || []).map(personName).filter(Boolean);
  const decedent = row.decedent ? personName(row.decedent) : null;

  // "Ismael Aguilar & Brigitt Aguilar" -> "Ismael & Brigitt Aguilar"
  const pair = (a, b, sep) => {
    if (!b) return a;
    const la = a.split(' ').pop(), lb = b.split(' ').pop();
    return la === lb ? `${a.slice(0, -la.length - 1)} ${sep} ${b}` : `${a} ${sep} ${b}`;
  };
  let to, greet;
  if (kind === 'estate' && execIdx >= 0) {
    to = `${names[execIdx]}, Personal Representative${decedent ? `, Estate of ${decedent}` : ''}`;
    greet = names[execIdx];
  } else if (names.length) {
    to = pair(names[0], names[1], '&');
    greet = pair(names[0], names[1], 'and');
  } else if (decedent) {
    to = `The Family of ${decedent}`; greet = `family of ${decedent}`;
  } else {
    to = 'Current Owner'; greet = 'Homeowner';
  }

  const street = row.address_line_1;
  const place = [row.city, [row.state, row.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const sender = s.letter_sender || '[your name]';
  const company = s.letter_company || 'Harbison Buys Homes';
  const phone = s.letter_phone || '[phone]';
  const email = s.letter_email;
  const n = (row.letters_sent || 0) + 1;
  const follow = n > 1 ? `This is my ${ordinal[n] || 'last'} letter — I wrote a few weeks ago and wanted to follow up once. ` : '';

  const body = {
    foreclosure: [
      `${follow}My name is ${sender}. I'm a local home buyer here in Kern County with ${company}. Public records show a notice was recorded on the property at ${street}. If you are weighing your options, I would like to be one of them.`,
      `We buy houses as-is, for cash, on your timeline: no repairs, no cleaning, no agent commissions. Selling before a sale date can let an owner keep equity that a trustee's sale would wipe out. If working it out with your lender is the better path for you, I will tell you that.`,
      `Your options usually include reinstating the loan, a loan modification, listing with an agent, or selling directly. A HUD-approved housing counselor can walk you through them at no cost: 1-800-569-4287.`,
      `Call or text me at ${phone}. No pressure and no obligation.`,
    ],
    death: [
      `${follow}I'm sorry for your loss. My name is ${sender}, a local home buyer with ${company}. I'm writing because property records show a change in ownership at ${street}, and families in that situation sometimes have to decide about a house sooner than they expected.`,
      `If selling is ever something you want to consider, now or months from now, we buy as-is, can handle clearing out anything you don't want to keep, and work around your schedule. If not, please disregard this letter with my sympathy.`,
      `You can reach me at ${phone} whenever it is convenient.`,
    ],
    estate: [
      `${follow}My name is ${sender}, a local home buyer with ${company}. Public records show you are handling the estate${decedent ? ` of ${decedent}` : ''}. Please accept my condolences.`,
      `If the estate includes the property at ${street} and a sale is part of settling it, we can buy as-is, for cash, and close on the estate's schedule. We are comfortable working with the estate's attorney and with court confirmation when it is required, and we can take care of clearing out the house.`,
      `If that would help, call or text me at ${phone}. If not, please disregard this letter.`,
    ],
    tax: [
      `${follow}My name is ${sender}, a local home buyer with ${company}. County records show property taxes are past due on ${street}.`,
      `If the property has become more of a burden than it is worth to you, we buy as-is, for cash, and pay the back taxes out of the sale at closing. If you want to keep it, the Kern County Treasurer-Tax Collector offers a five-year payment plan for defaulted taxes (661-868-3490).`,
      `Either way, call or text me at ${phone} if I can help.`,
    ],
    general: [
      `${follow}My name is ${sender}, a local home buyer with ${company}. I'm interested in buying the property at ${street}, as-is and for cash, on your timeline.`,
      `If selling is something you would consider, call or text me at ${phone}.`,
    ],
  }[kind];

  const fine = [
    kind === 'foreclosure'
      ? 'This is a solicitation from a private business. We are not your lender, a government agency, or a foreclosure consultant, and we do not charge any fee to stop or delay a foreclosure.'
      : 'This is a solicitation from a private business, not a government agency or a court, and not a notice about any debt.',
    kind === 'foreclosure' ? 'Any contract to buy your home will include every cancellation right California law gives you, including under Civil Code §1695 where it applies.' : null,
    `If you would rather not hear from us, call or text ${phone}${email ? ` or email ${email}` : ''} and we will stop.`,
  ].filter(Boolean).join(' ');

  return { kind, to, greet, street, place, body, fine, sender, company, n };
}

export const REQUIRED_SETTINGS = ['letter_sender', 'letter_phone', 'letter_return_address', 'letter_city_line'];

// Follow-up timing after a letter goes out
export const followUpDays = (kind) => (kind === 'foreclosure' ? 7 : kind === 'estate' ? 14 : 21);
