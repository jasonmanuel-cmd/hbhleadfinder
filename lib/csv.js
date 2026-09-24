// Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF)
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, q = false;
  text = text.replace(/^﻿/, '');
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
    i++;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, j) => [h, (r[j] ?? '').trim()])));
}
