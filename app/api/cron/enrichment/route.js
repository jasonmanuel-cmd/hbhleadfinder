import { runEnrichment } from '@/lib/enrichment';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Called by Vercel Cron with `Authorization: Bearer $CRON_SECRET`, or by hand from
// the Sources page. Drains the enrichment queue: claims jobs, fills in what the
// providers can find, and lets the database re-score the property.
export async function GET(req) {
  const auth = req.headers.get('authorization') || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const url = new URL(req.url);
  const types = (url.searchParams.get('types') || 'valuation,parcel,mortgage')
    .split(',').map((t) => t.trim()).filter(Boolean);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 10)));
  try {
    const stats = await runEnrichment({ types, limit });
    return Response.json({ ok: true, ...stats });
  } catch (e) {
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
