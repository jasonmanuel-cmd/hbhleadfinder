// The plug-in point for a paid data provider.
//
// The counties publish assessed values but not mortgage balances, and the recorder's
// index publishes no amounts at all, so the balance that turns a provisional score
// into a real one has to come from a paid source. Rather than hard-code one vendor's
// API, the worker POSTs the job to a URL you control and reads the answer back.
//
//   ENRICHMENT_PROVIDER_URL=https://your-service/enrich
//   ENRICHMENT_PROVIDER_KEY=...            (sent as "authorization: Bearer <key>")
//   ENRICHMENT_PROVIDER_TIMEOUT=20000
//
// The request is:
//   { "job_id", "property_id", "enrichment_type", "provider",
//     "state", "county", "apn", "address_line_1", "city", "zip" }
//
// The reply is the same shape the other providers return -- the property columns to
// write, and nothing else is used:
//   { "estimated_market_value": 385000, "estimated_loan_balance": 210000,
//     "estimated_arv": 360000, "condition_rating": 3, "data_confidence": "attom" }
//
// Reply with { "skipped": "..." } to park a job without failing it.

const TIMEOUT = Number(process.env.ENRICHMENT_PROVIDER_TIMEOUT || 20000);

export async function webhookProvider(job) {
  const url = process.env.ENRICHMENT_PROVIDER_URL;
  if (!url) return { skipped: 'No enrichment provider is configured' };

  const body = {
    job_id: job.job_id,
    property_id: job.property_id,
    enrichment_type: job.enrichment_type,
    provider: job.provider,
    state: job.state,
    county: job.county,
    apn: job.apn,
    address_line_1: job.address_line_1,
    city: job.city,
    zip: job.zip,
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.ENRICHMENT_PROVIDER_KEY
          ? { authorization: `Bearer ${process.env.ENRICHMENT_PROVIDER_KEY}` }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    throw new Error(`The enrichment provider did not answer: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
  }
  if (!res.ok) throw new Error(`The enrichment provider returned HTTP ${res.status}`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('The enrichment provider did not return JSON');
  }
  if (!data || typeof data !== 'object') throw new Error('The enrichment provider returned nothing usable');
  if (data.skipped) return { skipped: String(data.skipped).slice(0, 300) };
  return data;
}
