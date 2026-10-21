'use server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { COOKIE, sessionToken, safeEqual } from '@/lib/auth';

export async function login(formData) {
  const pw = String(formData.get('password') || '');
  // small constant delay to blunt brute force
  await new Promise((r) => setTimeout(r, 400));
  const ok = !!process.env.DASHBOARD_PASSWORD && safeEqual(pw, process.env.DASHBOARD_PASSWORD);
  // A one-line note on the outcome. Login is the one place where "it just goes back to
  // the login page" is genuinely hard to diagnose from the outside, so say what
  // happened. The password itself is never logged.
  console.log(`[login] ${ok ? 'accepted' : 'REJECTED'} from ${await clientIp()} (host ${await clientHost()})`);
  if (!ok) {
    redirect('/login?error=1');
  }
  const policy = await cookiePolicy();
  (await cookies()).set(COOKIE, await sessionToken(), {
    httpOnly: true,
    secure: policy.secure,
    sameSite: policy.sameSite,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect('/');
}

export async function logout() {
  (await cookies()).delete(COOKIE);
  redirect('/login');
}

/**
 * Cookie attributes.
 *
 * `Secure` follows the request protocol rather than being hard-coded: a hard-coded
 * `secure: true` stops some browsers from storing the cookie at all on
 * http://localhost, which makes local development look broken.
 *
 * `SameSite` matters more than it looks. When the dashboard is opened inside an
 * iframe on another origin (a hosted preview, for example) the browser treats the
 * session cookie as third-party: a SameSite=Lax cookie is not sent back at all, and
 * Chrome refuses to store third-party cookies outright unless the cookie is
 * SameSite=None; Secure. The symptom is a login that "does not work" - the password
 * is accepted, the cookie is dropped, and the next request bounces to the login
 * page again. Setting COOKIE_SAMESITE=none enables that mode; it needs https, so it
 * falls back to Lax on a plain http connection.
 */
async function cookiePolicy() {
  const h = await headers();
  const proto = h.get('x-forwarded-proto');
  const secure = proto ? proto.split(',')[0].trim() === 'https' : process.env.NODE_ENV === 'production';

  let sameSite = 'lax';
  if ((process.env.COOKIE_SAMESITE || '').toLowerCase() === 'none' && secure) {
    sameSite = 'none';
  }
  return { secure, sameSite };
}

async function clientHost() {
  const h = await headers();
  return h.get('x-forwarded-host') || h.get('host') || 'unknown';
}

async function clientIp() {
  const h = await headers();
  return h.get('x-forwarded-for')?.split(',')[0].trim() || h.get('x-real-ip') || 'local';
}
