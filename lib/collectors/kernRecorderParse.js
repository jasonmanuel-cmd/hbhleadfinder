// Parser for Kern County Recorder "Search by Document Class" result pages.
// Pure string -> data so it runs anywhere (server, tests, browser).

const decode = (s) =>
  s.replace(/&nbsp;?/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
   .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
const strip = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function parseKernResults(html) {
  const rows = [];
  const chunks = html.split(/<tr\s+valign="?top"?\s*>/i).slice(1);
  for (const chunk of chunks) {
    const body = chunk.split(/<\/tr>/i)[0];
    const doc = body.match(/>\s*(\d{6,12})\s*<\/a>/i);
    if (!doc) continue;
    const cells = body.split(/<td\b/i).slice(1).map((c) => '<td' + c);
    const date = (body.match(/(\d{2})\/(\d{2})\/(\d{4})/) || []);
    // description cell: the one containing letters but not the doc link / names
    const descCell = cells.find((c) => /width="?30%/i.test(c)) || '';
    const descriptions = decode(descCell.replace(/<td[^>]*>/i, '').replace(/<[^>]+>/g, '\n'))
      .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const nameCell = cells.find((c) => /width="?53%/i.test(c)) || '';
    const parties = nameCell.replace(/<td[^>]*>/i, '').split(/<br\s*\/?>/i)
      .map((s) => strip(s))
      .map((s) => {
        const m = s.match(/^(.*?)\s*\((R|E)\)\s*$/i);
        return m ? { name: m[1].trim(), role: m[2].toUpperCase() === 'R' ? 'grantor' : 'grantee' } : null;
      })
      .filter((p) => p && p.name);
    const href = (body.match(/href="([^"]+alldetail[^"]*)"/i) || [])[1];
    rows.push({
      document_number: doc[1],
      recorded_date: date.length ? `${date[3]}-${date[1]}-${date[2]}` : null,
      descriptions,
      parties,
      detail_url: href ? decode(href).replace(/USERKEY=[^&]*&?/i, '') : null,
    });
  }
  const next = html.match(/href="([^"]*START_ROW_NUM=[^"]*)"[^>]*>\s*NEXT/i);
  return { rows, next: next ? decode(next[1]) : null };
}

const ENTITY = /\b(INC|LLC|L L C|CORP|CORPORATION|COMPANY|CO|BANK|N A|NA|NATIONAL ASSOCIATION|TRUST CO|SERVICES?|SERVICING|MORTGAGE|FINANCIAL|FINANCE|TITLE|LENDER|LENDING|RECONTRUST|FUND|FEDERAL|ASSOCIATION|ASSN|CREDIT UNION|LP|LLP|GROUP|HOLDINGS|PARTNERS|SOLUTIONS|FORECLOSURE|INVESTMENTS?|CAPITAL|AGENCY|DEPARTMENT|COUNTY|STATE OF|UNITED STATES)\b/i;

export function isEntity(name) {
  return ENTITY.test(name.replace(/[.,]/g, ' '));
}
