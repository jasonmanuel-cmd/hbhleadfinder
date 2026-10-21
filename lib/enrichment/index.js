// The enrichment worker.
//
// The database already enqueues enrichment jobs (triggers in the migrations) and has
// the full queue lifecycle -- claim, back off, fail, release stale locks -- in SQL.
// Nothing consumed them: the jobs piled up, one per new lead, and the score could
// never get the value and balance it needs.
//
// A provider is an async function that takes a job and returns the property columns
// it filled in. It throws to fail the job (the database backs off and retries) and
// returns { skipped: '...' } to say "not now, and that is fine".
//
// The worker never invents a number. If a provider cannot find the data, the job
// fails and says why; the score keeps whatever it already had.

import { sql } from '../db.js';
import { assessorProvider } from './providers/assessor.js';
import { webhookProvider } from './providers/webhook.js';

// The columns a provider is allowed to write. Anything else is ignored.
const WRITABLE = new Set([
  'estimated_market_value', 'estimated_arv', 'estimated_repair_cost',
  'estimated_loan_balance', 'estimated_other_liens', 'assessed_value',
  'living_sqft', 'lot_sqft', 'year_built', 'bedrooms', 'bathrooms',
  'owner_occupied', 'vacant_signal', 'condition_rating',
  'valuation_last_verified_at', 'mortgage_last_verified_at', 'ownership_last_verified_at',
  'attom_id', 'regrid_id', 'vendor_property_id', 'data_confidence', 'source_metadata',
]);

// Which provider handles which job type, in order of preference. A job can name its
// own provider (the triggers do that for the ones that need a paid source).
const BY_TYPE = {
  valuation: ['assessor', 'webhook'],
  parcel: ['assessor', 'webhook'],
  mortgage: ['webhook'],
  foreclosure: ['webhook'],
  ownership: ['webhook'],
  contact: ['webhook'],
  title_review: ['webhook'],
};

const PROVIDERS = {
  assessor: assessorProvider,
  webhook: webhookProvider,
};

function pickProvider(job, type, providers) {
  const byType = BY_TYPE[type] || BY_TYPE[job.enrichment_type] || [];
  const preferred = job.provider ? [job.provider, ...byType] : byType;
  for (const name of preferred) {
    const p = providers[name];
    if (!p) continue;
    if (name === 'webhook' && !process.env.ENRICHMENT_PROVIDER_URL) continue; // not configured
    return { name, fn: p };
  }
  return null;
}

export async function runEnrichment({
  types = ['valuation', 'parcel'],
  worker = `enrichment-${process.pid}`,
  limit = 10,
  deadline = Date.now() + 60000,
  providers = PROVIDERS, // overridable, so the worker can be tested without a network
  db = sql,              // overridable, so the worker can be tested without a server
} = {}) {
  const stats = { claimed: 0, completed: 0, failed: 0, skipped: 0, released: 0 };

  // Reclaim jobs whose worker died holding them.
  try {
    const [{ n }] = await db`select release_stale_enrichment_jobs() as n`;
    stats.released = n || 0;
  } catch { /* the function may not exist on an old database */ }

  for (const type of types) {
    const jobs = await db`select * from claim_enrichment_jobs(${type}, ${worker}, ${limit})`;
    if (!jobs.length) continue;
    stats.claimed += jobs.length;

    for (const job of jobs) {
      if (Date.now() > deadline) break;
      const provider = pickProvider(job, type, providers);
      if (!provider) {
        // Nothing can service this job. Skip it rather than fail it, so it does not
        // burn its attempts and end up "failed" for a reason that will never change.
        await db`select finish_enrichment_job(${job.job_id}, 'skipped', ${`No provider is configured for ${type}`})`;
        stats.skipped++;
        continue;
      }
      try {
        const result = await provider.fn(job);
        if (result?.skipped) {
          await db`select finish_enrichment_job(${job.job_id}, 'skipped', ${String(result.skipped).slice(0, 300)})`;
          stats.skipped++;
          continue;
        }
        const fields = {};
        for (const [k, v] of Object.entries(result || {})) {
          if (WRITABLE.has(k) && v !== null && v !== undefined) fields[k] = v;
        }
        if (Object.keys(fields).length) {
          const keys = Object.keys(fields);
          const vals = Object.values(fields);
          const sets = keys.map((k, i) => `${k} = $${i + 1}`);
          await db.unsafe(
            `update properties set ${sets.join(', ')} where id = $${keys.length + 1}`,
            [...vals, job.property_id],
          );
        }
        // finish_enrichment_job recalculates the score for us.
        await db`select finish_enrichment_job(${job.job_id}, 'completed', null)`;
        stats.completed++;
      } catch (e) {
        const msg = String(e?.message || e).slice(0, 300);
        await db`select finish_enrichment_job(${job.job_id}, 'failed', ${msg})`;
        stats.failed++;
      }
    }
  }
  return stats;
}
