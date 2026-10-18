// Unit tests for the pure JavaScript: the county HTML parser, the name formatter,
// the CSV reader and the county-record rules. No database, no network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseKernResults, isEntity } from '../lib/collectors/kernRecorderParse.js';
import { borrowersFrom, peopleFor } from '../lib/collectors/kernRecorder.js';
import { buildDossier } from '../lib/collectors/kernHistory.js';
import { parseCsv } from '../lib/csv.js';
import { personName } from '../lib/letters.js';

// A recorder result page: one row per filing, parties marked (R) grantor / (E) grantee.
const PAGE = `
<html><body><table>
<tr valign="top">
  <td width="10%"><a href="/cgi-bin/alldetail.mbr?doc=202610001&USERKEY=abc">202610001</a></td>
  <td width="15%">10/01/2026</td>
  <td width="30%">Notice of Default<br>Notice of Trustee's Sale</td>
  <td width="53%">SALAZAR MARISOL A (R)<br>JPMORGAN CHASE BANK NA (R)</td>
</tr>
<tr valign="top">
  <td width="10%"><a href="/cgi-bin/alldetail.mbr?doc=202610002&USERKEY=abc">202610002</a></td>
  <td width="15%">10/02/2026</td>
  <td width="30%">Affidavit - TOD</td>
  <td width="53%">WHITFIELD HAROLD J DECD (R)<br>WHITFIELD SARA B (E)</td>
</tr>
</table>
<a href="/cgi-bin/oresultc02.mbr/Datedetail?START_ROW_NUM=25">NEXT</a>
</body></html>`;

test('the recorder parser reads document numbers, dates, classes and parties', () => {
  const { rows, next } = parseKernResults(PAGE);
  assert.equal(rows.length, 2);

  assert.equal(rows[0].document_number, '202610001');
  assert.equal(rows[0].recorded_date, '2026-10-01');
  assert.deepEqual(rows[0].descriptions, ['Notice of Default', "Notice of Trustee's Sale"]);
  assert.deepEqual(rows[0].parties, [
    { name: 'SALAZAR MARISOL A', role: 'grantor' },
    { name: 'JPMORGAN CHASE BANK NA', role: 'grantor' },
  ]);

  assert.equal(rows[1].recorded_date, '2026-10-02');
  assert.equal(rows[1].parties[0].role, 'grantor');
  assert.equal(rows[1].parties[1].role, 'grantee');

  assert.ok(next, 'the next-page link must be found');
  assert.ok(next.includes('START_ROW_NUM=25'));
});

test('the recorder parser survives a page with no rows', () => {
  const { rows, next } = parseKernResults('<html><body>No records found.</body></html>');
  assert.equal(rows.length, 0);
  assert.equal(next, null);
});

test('entities are told apart from people', () => {
  for (const name of ['JPMORGAN CHASE BANK NA', 'WELLS FARGO HOME MORTGAGE INC',
    'BAY AREA PROPERTY HOLDINGS LLC', 'CARD SERVICES INC']) {
    assert.equal(isEntity(name), true, `${name} should be an entity`);
  }
  for (const name of ['SALAZAR MARISOL A', 'NGUYEN THUY MINH', 'OKAFOR CHIDI E']) {
    assert.equal(isEntity(name), false, `${name} should be a person`);
  }
});

test('a lender indexed as grantor is never treated as the borrower', () => {
  const parties = [
    { name: 'SALAZAR MARISOL A', role: 'grantor' },
    { name: 'JPMORGAN CHASE BANK NA', role: 'grantor' },
  ];
  assert.deepEqual(borrowersFrom(parties), ['SALAZAR MARISOL A'],
    'a bank must not become the owner we call');

  const servicer = [
    { name: 'SALAZAR MARISOL A', role: 'grantor' },
    { name: 'WELLS FARGO HOME MORTGAGE INC', role: 'grantor' },
    { name: 'CREDIT UNION', role: 'grantor' },
  ];
  assert.deepEqual(borrowersFrom(servicer), ['SALAZAR MARISOL A']);
});

test('a trustee and a "TR" suffix are not borrowers either', () => {
  const parties = [
    { name: 'SALAZAR MARISOL A', role: 'grantor' },
    { name: 'SOMETHING ACQUISITION TR', role: 'grantor' },
    { name: 'FIRST NATIONAL TRUSTEE', role: 'grantor' },
  ];
  assert.deepEqual(borrowersFrom(parties), ['SALAZAR MARISOL A']);
});

test('a death filing names the surviving owner as the decision-maker', () => {
  const who = peopleFor(
    { people: 'death', signal: 'tod_affidavit' },
    [
      { name: 'WHITFIELD HAROLD J DECD', role: 'grantor' },
      { name: 'WHITFIELD SARA B', role: 'grantee' },
    ],
  );
  assert.ok(who);
  assert.deepEqual(who.people, [
    { name: 'WHITFIELD HAROLD J', role: 'decedent', decision_maker: false },
    { name: 'WHITFIELD SARA B', role: 'heir', decision_maker: true },
  ]);
  assert.equal(who.contact, 'WHITFIELD SARA B');
  assert.deepEqual(who.historyNames, ['WHITFIELD HAROLD J']);
});

test('a death filing with no decedent is skipped', () => {
  const who = peopleFor(
    { people: 'death', signal: 'tod_affidavit' },
    [{ name: 'WHITFIELD SARA B', role: 'grantee' }],
  );
  assert.equal(who, null, 'a re-recorded TOD deed is not a lead');
});

test('an estate filing names the executor', () => {
  const who = peopleFor(
    { people: 'estate', signal: 'letters_testamentary' },
    [
      { name: 'BRENNAN PATRICIA L EST', role: 'grantor' },
      { name: 'BRENNAN PATRICIA L EXTR', role: 'grantee' },
    ],
  );
  assert.ok(who);
  assert.equal(who.people[0].role, 'decedent');
  assert.equal(who.people[1].role, 'executor');
  assert.equal(who.people[1].decision_maker, true);
  assert.equal(who.contact, 'BRENNAN PATRICIA L', 'the executor, not the decedent, is the contact');
});

test('a lien filing with no human name is skipped', () => {
  const who = peopleFor(
    { people: 'debtor', signal: 'tax_lien' },
    [{ name: 'COUNTY OF KERN', role: 'grantor' }],
  );
  assert.equal(who, null);
});

// -------------------------------------------------------------------------------------------
// Owner-history dossier
// -------------------------------------------------------------------------------------------

const doc = (n, date, desc, parties) => ({
  document_number: n,
  recorded_date: date,
  descriptions: [desc],
  parties: parties.map(([name, role]) => ({ name, role })),
});

test('a dossier finds the loan, the reconveyance and the ownership history', () => {
  const rows = [
    doc('D1', '2015-03-04', 'Deed of Trust', [['SALAZAR MARISOL A', 'grantor'], ['MORTGAGE CO', 'grantee']]),
    doc('D2', '2019-06-01', 'Reconveyance', [['SALAZAR MARISOL A', 'grantor']]),
    doc('D3', '2011-01-10', 'Grant Deed', [['SMITH JOHN A', 'grantor'], ['SALAZAR MARISOL A', 'grantee']]),
    doc('D4', '2024-02-02', 'Deed of Trust', [['SALAZAR MARISOL A', 'grantor'], ['WELLS FARGO HOME MORTGAGE', 'grantee']]),
  ];
  const d = buildDossier({ signal: 'notice_of_default', date: '2026-10-01', document_number: 'D5' },
    ['SALAZAR MARISOL A'], rows, false);

  assert.equal(d.signals.recorded_loans, 2);
  assert.equal(d.signals.reconveyances, 1);
  assert.equal(d.signals.open_loans, 1, 'one loan is still open');
  assert.equal(d.signals.last_purchase_date, '2011-01-10');
  assert.ok(d.priority > 0);
});

test('a dossier marks a lead that has already been foreclosed or sold as worthless', () => {
  const rows = [
    doc('D1', '2026-11-01', 'Trustee/Foreclosure Deed', [['SALAZAR MARISOL A', 'grantor']]),
  ];
  const d = buildDossier({ signal: 'notice_of_default', date: '2026-10-01', document_number: 'D5' },
    ['SALAZAR MARISOL A'], rows, false);
  assert.equal(d.signals.foreclosed, true);
  assert.equal(d.priority, 0, 'a lead that is already gone is worth no attention');
  assert.ok(d.summary.join(' ').toLowerCase().includes('foreclosure deed'));
});

test('a truncated (common-name) history is flagged as unverified', () => {
  const rows = [doc('D1', '2015-03-04', 'Deed of Trust', [['SALAZAR MARISOL A', 'grantor']])];
  const d = buildDossier({ signal: 'notice_of_default', date: '2026-10-01', document_number: 'D5' },
    ['SALAZAR MARISOL A'], rows, true);
  assert.equal(d.signals.common_name, true);
  assert.equal(d.signals.equity_hint, 'unverified');
  assert.equal(d.truncated, true);
});

// -------------------------------------------------------------------------------------------
// CSV + letter formatting
// -------------------------------------------------------------------------------------------

test('the CSV reader handles quotes, escaped quotes and CRLF', () => {
  const rows = parseCsv('source,signal,apn,owner\r\nkern_recorder,notice_of_default,123-456-09,"SALAZAR, MARISOL"\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'kern_recorder');
  assert.equal(rows[0].owner, 'SALAZAR, MARISOL');
});

test('the CSV reader normalises header names and skips blank lines', () => {
  const rows = parseCsv('Source Name,Signal,APN\n\nkern_recorder,notice_of_default,123-456-09\n\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_name, 'kern_recorder');
  assert.equal(rows[0].apn, '123-456-09');
});

test('recorder names are turned into mailing names', () => {
  assert.equal(personName('SALAZAR MARISOL A'), 'Marisol A Salazar');
  assert.equal(personName('SALAZAR MARISOL A DECD'), 'Marisol A Salazar');
  assert.equal(personName('BRENNAN PATRICIA L EST'), 'Patricia L Brennan');
  assert.equal(personName('WHITFIELD HAROLD J TR'), 'Harold J Whitfield');
  assert.equal(personName('JPMORGAN CHASE BANK NA'), 'Jpmorgan Chase Bank Na');
  assert.equal(personName(''), '');
});

test('a married couple is merged into one mailing name', () => {
  assert.equal(personName('AGUILAR ISMAEL & BRIGITT'), 'Ismael & Brigitt Aguilar');
});
