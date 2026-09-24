export const EVENT_LABELS = {
  notice_of_default: 'Notice of Default',
  notice_of_trustee_sale: 'Notice of Trustee Sale',
  lis_pendens: 'Lis Pendens',
  foreclosure_judgment: 'Foreclosure Judgment',
  trustee_sale_postponed: 'Sale Postponed',
  trustee_sale_cancelled: 'Sale Cancelled',
  notice_of_rescission: 'Rescission',
  foreclosure_sold: 'Sold at Auction',
  probate_opened: 'Probate Opened',
  letters_testamentary: 'Letters Testamentary',
  tax_default: 'Tax Default',
  power_to_sell: 'Power to Sell',
  vacancy_signal: 'Vacant',
  code_violation: 'Code Violation',
  absentee_owner: 'Absentee Owner',
  fsbo_listing: 'FSBO',
  estate_sale: 'Estate Sale',
  bankruptcy: 'Bankruptcy',
  co_owner_referral: 'Co-owner Referral',
  inbound_seller_request: 'Inbound Seller',
};
export const EVENT_TYPES = Object.keys(EVENT_LABELS);

export const STAGES = ['new', 'researching', 'contacted', 'conversation', 'appointment', 'offer_sent',
  'under_contract', 'closed', 'lost', 'nurture', 'dead'];
export const EXITS = ['cash', 'listing', 'wholesale', 'novation', 'seller_finance', 'pass'];
export const ROLES = ['owner', 'co_owner', 'heir', 'executor', 'administrator', 'trustee', 'attorney', 'decedent'];
export const CHANNELS = ['call', 'sms', 'email', 'letter', 'door', 'referral', 'other'];
export const OUTREACH_STATUS = ['attempted', 'reached', 'voicemail', 'no_answer', 'wrong_contact', 'bad_number',
  'appointment_set', 'not_interested', 'opted_out'];

export const label = (s) => (s ? String(s).replace(/_/g, ' ') : '—');
export const ev = (t) => EVENT_LABELS[t] || label(t);

export function money(n) {
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export function date(d) {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function dateTime(d) {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Los_Angeles' });
}

export function daysUntil(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  const today = new Date(new Date().toISOString().slice(0, 10));
  return Math.round((dt - today) / 86400000);
}

export function isoDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}

// form helpers
export const str = (fd, k) => {
  const v = fd.get(k);
  return v === null || String(v).trim() === '' ? null : String(v).trim();
};
export const num = (fd, k) => {
  const v = str(fd, k);
  if (v === null) return null;
  const n = Number(v.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
export const bool3 = (fd, k) => {
  const v = str(fd, k);
  return v === 'yes' ? true : v === 'no' ? false : null;
};
