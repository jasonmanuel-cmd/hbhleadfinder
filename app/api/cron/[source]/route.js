import { runCollector, COLLECTORS } from '@/lib/ingest';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Called by Vercel Cron with `Authorization: Bearer $CRON_SECRET`
export async function GET(req, { params }) {
  const { source } = await params;
  const auth = req.headers.get('authorization') || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!COLLECTORS[source]) return new Response('Unknown source', { status: 404 });
  try {
    const stats = await runCollector(source, { trigger: 'cron' });
    return Response.json({ ok: true, source, ...stats });
  } catch (e) {
    return Response.json({ ok: false, source, error: e.message }, { status: 500 });
  }
}
