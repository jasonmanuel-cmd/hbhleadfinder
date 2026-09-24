// Parcel resolvers: street address <-> APN from each county's free public GIS.
// No owner names anywhere — California counties don't publish them (Gov Code 6254.21 policy),
// so the name -> address step stays human; everything after it is automatic.
// Add a county by adding an entry to RESOLVERS keyed "ST:County".

const TIMEOUT = 10000;
const UA = 'HarbisonBuysHomes-LeadDesk/1.0 (parcel lookup; low volume)';

async function getJson(url, params) {
  let res;
  try {
    res = await fetch(`${url}?${new URLSearchParams({ ...params, f: 'json' })}`, {
      headers: { 'User-Agent': UA }, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    throw new Error(`The county's parcel map didn't answer (${e.name === 'TimeoutError' ? 'timed out' : e.message}). Try again, or enter both APN and address.`);
  }
  if (!res.ok) throw new Error(`GIS HTTP ${res.status}`);
  const d = await res.json();
  if (d.error && !/Unable to find address/i.test(JSON.stringify(d.error))) throw new Error(`GIS error: ${d.error.message}`);
  return d;
}

const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
// "1115 TRUXTUN AV" -> "1115 Truxtun Ave"
const tidyStreet = (s) => titleCase(s).replace(/\bAv\b/, 'Ave');

// Unincorporated parcels often come back without a ZIP or city; the Census geocoder fills both from the point.
// Works nationwide, no key. ZCTA is close enough to the ZIP for mailing.
async function censusZipCity(x, y) {
  try {
    const d = await getJson('https://geocoding.geo.census.gov/geocoder/geographies/coordinates', {
      x: String(x), y: String(y), benchmark: 'Public_AR_Current', vintage: 'Current_Current', format: 'json',
      layers: '2020 Census ZIP Code Tabulation Areas,Incorporated Places,Census Designated Places',
    });
    const g = d.result?.geographies || {};
    const zip = g['2020 Census ZIP Code Tabulation Areas']?.[0]?.BASENAME || null;
    const city = g['Incorporated Places']?.[0]?.BASENAME || g['Census Designated Places']?.[0]?.BASENAME || null;
    return { zip, city };
  } catch {
    return { zip: null, city: null };
  }
}

async function withZipCity(hit) {
  if (!hit || hit.ambiguous || (hit.zip && hit.city) || !hit.x) return hit;
  const c = await censusZipCity(hit.x, hit.y);
  return { ...hit, zip: hit.zip || c.zip, city: hit.city || c.city };
}

// ---------------- Kern County, CA ----------------
const KERN_LOCATOR = 'https://maps.kerncounty.com/arcgis/rest/services/Locators/ITS_Composite_Locator/GeocodeServer';
const kernParcelLayer = (y) =>
  `https://services5.arcgis.com/Y8jwjGUWbRjuqpG5/arcgis/rest/services/Assessor_Parcels_Land_${y}_gdb/FeatureServer/0/query`;
let kernLayerUrl = null;

// The county republishes the parcel layer each roll year under a new name; use the newest one that answers.
async function kernParcels(params) {
  const urls = kernLayerUrl ? [kernLayerUrl] : [];
  const y = new Date().getUTCFullYear();
  for (const yr of [y + 1, y, y - 1, y - 2]) if (!urls.includes(kernParcelLayer(yr))) urls.push(kernParcelLayer(yr));
  let last;
  for (const u of urls) {
    try {
      const d = await getJson(u, params);
      if (d.features) { kernLayerUrl = u; return d.features; }
    } catch (e) { last = e; }
  }
  throw last || new Error('Kern parcel layer unavailable');
}

async function kernApnAt(x, y) {
  const f = await kernParcels({
    geometry: `${x},${y}`, geometryType: 'esriGeometryPoint', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outFields: 'APN,APN_LABEL', returnGeometry: 'false',
  });
  return f.map((x) => x.attributes.APN_LABEL || x.attributes.APN).filter(Boolean);
}

async function kernCandidates(single) {
  const d = await getJson(`${KERN_LOCATOR}/findAddressCandidates`, {
    SingleLine: single, outFields: 'Loc_name,Match_addr,StAddr,City,ZIP', maxLocations: '6', outSR: '4326',
  });
  return (d.candidates || []).filter((c) => c.score >= 88);
}

// address -> { apn, address, city, zip } | { ambiguous: [...] } | null
async function kernFromAddress({ address, city, zip }) {
  const single = [address, city, zip].filter(Boolean).join(', ');
  const cands = await kernCandidates(single);
  if (!cands.length) return null;
  const top = cands[0].score;
  const hits = [];
  for (const c of cands.filter((c) => c.score >= top - 3).slice(0, 4)) {
    const apns = await kernApnAt(c.location.x, c.location.y);
    if (!apns.length) continue;
    const a = c.attributes || {};
    hits.push({ apn: apns[0], address: tidyStreet(a.StAddr || c.address.split(',')[0]),
      city: titleCase(a.City || '') || null, zip: digits(a.ZIP).slice(0, 5) || null, score: c.score, x: c.location.x, y: c.location.y });
  }
  if (!hits.length) return null;
  const distinct = [...new Map(hits.map((h) => [h.apn, h])).values()];
  if (distinct.length > 1) {
    // same street number in two towns (e.g. 401 Alpine in Taft and Bakersfield) — a person has to pick
    const best = distinct.filter((h) => h.score === top);
    if (best.length !== 1 || top < 100) return { ambiguous: distinct };
    return withZipCity(best[0]);
  }
  // fill ZIP/city from whichever candidate had them, then from the Census point lookup
  const h = distinct[0];
  return withZipCity({ ...h, city: h.city || hits.find((x) => x.city)?.city || null, zip: h.zip || hits.find((x) => x.zip)?.zip || null });
}

// APN -> verified street address (reverse geocode, then forward-check it lands on the same parcel)
async function kernFromApn({ apn }) {
  const key = digits(apn);
  if (key.length < 8) return null;
  const f = await kernParcels({
    where: `APN='${key.slice(0, 8)}'`, outFields: 'APN,APN_LABEL', returnCentroid: 'true', returnGeometry: 'false', outSR: '4326',
  });
  const c = f[0]?.centroid;
  const label = f[0]?.attributes?.APN_LABEL;
  if (!c) return null;
  for (const dist of [5, 75, 200]) {
    const r = await getJson(`${KERN_LOCATOR}/reverseGeocode`, {
      location: JSON.stringify({ x: c.x, y: c.y, spatialReference: { wkid: 4326 } }), distance: String(dist), outSR: '4326',
    });
    if (!r.address?.Street) continue;
    const fwd = await kernFromAddress({ address: r.address.Street, city: r.address.City });
    if (fwd && !fwd.ambiguous && digits(fwd.apn) === digits(label)) return { ...fwd, apn: label };
  }
  return { apn: label, address: null, city: null, zip: null };
}

const RESOLVERS = {
  'CA:Kern': { fromAddress: kernFromAddress, fromApn: kernFromApn },
};

export function parcelResolver(state, county) {
  return RESOLVERS[`${String(state || '').toUpperCase()}:${titleCase(String(county || '').trim())}`] || null;
}

// Fill in whichever of APN / address is missing. Never overwrites what the user typed.
// -> { apn, address, city, zip, note } or throws a user-facing Error
export async function completeParcel({ state, county, apn, address, city, zip }) {
  const r = parcelResolver(state, county);
  if (!r || (apn && address)) return { apn, address, city, zip, note: null };
  if (address && !apn) {
    const hit = await r.fromAddress({ address, city, zip });
    if (!hit) throw new Error(`${county} County has no parcel at "${[address, city, zip].filter(Boolean).join(', ')}". Check the spelling, or enter the APN.`);
    if (hit.ambiguous) {
      throw new Error(`That address matches ${hit.ambiguous.length} parcels: ${hit.ambiguous
        .map((h) => `${h.address}, ${h.city || '?'} (${h.apn})`).join('; ')}. Add the city or ZIP.`);
    }
    // the county's spelling of the street keeps address matching consistent across sources
    return { apn: hit.apn, address: hit.address || address, city: hit.city || city, zip: hit.zip || zip, note: `APN ${hit.apn} found from the address` };
  }
  if (apn && !address) {
    const hit = await r.fromApn({ apn });
    if (!hit) throw new Error(`${county} County has no parcel ${apn}. Check the number.`);
    if (!hit.address) return { apn: hit.apn, address: null, city, zip, note: `APN ${hit.apn} found, but the county has no street address on file for it` };
    return { apn: hit.apn, address: hit.address, city: city || hit.city, zip: zip || hit.zip, note: `Address ${hit.address}${hit.city ? `, ${hit.city}` : ''} found from the APN` };
  }
  return { apn, address, city, zip, note: null };
}
