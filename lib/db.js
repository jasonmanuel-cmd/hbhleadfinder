import postgres from 'postgres';

const g = globalThis;

export const sql =
  g.__hbhSql ??
  (g.__hbhSql = postgres(process.env.DATABASE_URL, {
    prepare: false, // required for Supabase transaction pooler
    max_pipeline: 0, // never pipeline queries on one connection: Supavisor transaction mode can hang on it
    max: 5,
    idle_timeout: 10, // drop idle sockets before the pooler / platform silently kills them
    max_lifetime: 60 * 5,
    connect_timeout: 10,
    ssl: process.env.PGSSLMODE === 'disable' ? false : 'require',
  }));

// Postgres raises readable messages from our guards; strip the noise.
export function dbError(e) {
  const msg = e?.message || String(e);
  return msg.replace(/^.*?ERROR:\s*/, '').slice(0, 400);
}
