import { sql } from '@/lib/db';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [r] = await sql`select current_user as role, (select count(*) from lead_sources)::int as sources, now() as db_time`;
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
