// Unit tests for the session helpers. These are security-critical: the session token is
// derived from the dashboard password and the session secret, and the comparison has to
// be constant-time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COOKIE, sessionToken, safeEqual } from '../lib/auth.js';

const SECRET = 'test-session-secret';

test('session token is a stable sha-256 hex digest', async () => {
  process.env.DASHBOARD_PASSWORD = 'hunter2';
  process.env.SESSION_SECRET = SECRET;
  const a = await sessionToken();
  const b = await sessionToken();
  assert.equal(a, b, 'the token must be stable across calls');
  assert.match(a, /^[0-9a-f]{64}$/, 'must be a 64 character hex digest');
});

test('session token changes when the password or the secret changes', async () => {
  process.env.DASHBOARD_PASSWORD = 'hunter2';
  process.env.SESSION_SECRET = SECRET;
  const base = await sessionToken();

  process.env.DASHBOARD_PASSWORD = 'hunter3';
  const otherPassword = await sessionToken();
  assert.notEqual(base, otherPassword, 'a different password must give a different token');

  process.env.DASHBOARD_PASSWORD = 'hunter2';
  process.env.SESSION_SECRET = 'another-secret';
  const otherSecret = await sessionToken();
  assert.notEqual(base, otherSecret, 'a different secret must give a different token');
});

test('session token does not leak the password or the secret', async () => {
  process.env.DASHBOARD_PASSWORD = 'sup3r-s3cret-pw';
  process.env.SESSION_SECRET = SECRET;
  const t = await sessionToken();
  assert.ok(!t.includes('sup3r'), 'the password must not appear in the token');
  assert.ok(!t.includes(SECRET), 'the secret must not appear in the token');
});

test('safeEqual accepts equal strings and rejects everything else', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'ab'), false, 'different lengths must not match');
  assert.equal(safeEqual('abc', 'abcd'), false, 'different lengths must not match');
  assert.equal(safeEqual('abc', ''), false);
  assert.equal(safeEqual(null, 'abc'), false, 'null must not throw');
  assert.equal(safeEqual('abc', undefined), false, 'undefined must not throw');
  assert.equal(safeEqual(undefined, undefined), false);
  assert.equal(safeEqual(123, 123), false, 'non-strings must not match');
});

test('the session cookie has a fixed name', () => {
  assert.equal(COOKIE, 'hbh_session');
});
