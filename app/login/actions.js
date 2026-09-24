'use server';
import { cookies } from 'next/headers';
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
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30,
  });
  redirect('/');
}

export async function logout() {
  (await cookies()).delete(COOKIE);
  redirect('/login');
}
