'use server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { COOKIE, sessionToken, safeEqual } from '@/lib/auth';

export async function login(formData) {
  const pw = String(formData.get('password') || '');
  // small constant delay to blunt brute force
  await new Promise((r) => setTimeout(r, 400));
  if (!process.env.DASHBOARD_PASSWORD || !safeEqual(pw, process.env.DASHBOARD_PASSWORD)) {
    redirect('/login?error=1');
  }
  (await cookies()).set(COOKIE, await sessionToken(), {
    httpOnly: true,
    // Only mark the cookie Secure when the request actually arrived over https.
    // A hard-coded `secure: true` stops some browsers from storing the cookie at
    // all on http://localhost, which makes local development look broken.
    secure: isHttps(),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect('/');
}

export async function logout() {
  (await cookies()).delete(COOKIE);
  redirect('/login');
}

function isHttps() {
  const proto = headers().get('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  return process.env.NODE_ENV === 'production';
}
