import { NextResponse } from 'next/server';
import { COOKIE, sessionToken, safeEqual } from '@/lib/auth';

export async function middleware(req) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/login')) return NextResponse.next();
  if (!process.env.DASHBOARD_PASSWORD || !process.env.SESSION_SECRET) {
    return new NextResponse('Dashboard is not configured.', { status: 503 });
  }
  const cookie = req.cookies.get(COOKIE)?.value;
  if (cookie && safeEqual(cookie, await sessionToken())) return NextResponse.next();
  if (pathname.startsWith('/api/')) return new NextResponse('Unauthorized', { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
