// Parser for Kern County Recorder "Search by Document Class" result pages.
// Pure string -> data so it runs anywhere (server, tests, browser).

export // Decode HTML entities into the characters they stand for. The output keeps the
// typography the county used -- "Notice of Trustee’s Sale" stays curly -- and
// foldText() below is what makes two spellings comparable.
const decode = (s) =>
  s
    // numeric entities first, so &#x2019; becomes a real apostrophe
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;?/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&rsquo;/gi, '’').replace(/&lsquo;/gi, '‘')
    .replace(/&ldquo;/gi, '“').replace(/&rdquo;/gi, '”')
    .replace(/&ndash;/gi, '–').replace(/&mdash;/gi, '—')
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&hellip;/gi, '…').replace(/&middot;|&bull;/gi, '·')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
const strip = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Fold text to a comparable form.
 *
 * The county renders "Notice of Trustee's Sale" with a typographic apostrophe and
 * "Affidavit - TOD" with an en dash. Comparing those to the ASCII strings in the
 * class list fails, and the comparison is a filter -- so the mismatch does not
 * raise, it just quietly throws away every trustee's sale and every TOD filing.
 * That is the most valuable lead type the app has, and it was disappearing
 * without a word. Fold both sides instead.
 */
export function foldText(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u00b4\u0060]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u00ab\u00bb]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00a0\u202f\u2007\u200b\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** True when one of the page's descriptions is the class we asked for. */
export function matchesClass(descriptions, desc) {
  const want = foldText(desc);
  if (!want) return false;
  return (descriptions || []).some((d) => foldText(d) === want);
}

export function parseKernResults(html) {
  const rows = [];
  const chunks = html.split(/<tr\s+valign="?top"?\s*>/i).slice(1);
  for (const chunk of chunks) {
    const body = chunk.split(/<\/tr>/i)[0];
    const doc = body.match(/>\s*(\d{6,12})\s*<\/a>/i);
    if (!doc) continue;
    const cells = body.split(/<td\b/i).slice(1).map((c) => '<td' + c);
    // The recording date lives in its own cell. Looking for the first date in the
    // whole row can pick up a date out of the party names instead.
    const dateCell = cells.find((c) => /\d{2}\/\d{2}\/\d{4}/.test(strip(c))) || '';
    const date = (dateCell.match(/(\d{2})\/(\d{2})\/(\d{4})/) || []);
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
