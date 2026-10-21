// Free valuation facts from the county's own assessor parcel layer.
//
// California counties publish their assessor parcels as an open ArcGIS layer, and the
// app already talks to it to turn an address into an APN. This provider asks the same
// layer for the facts a buyer needs: what the property is assessed at, how big it is,
// when it was built.
//
// The county renames its fields from one roll year to the next, so this does not name
// fields. It asks for all of them and picks the first that matches, by name or by
// alias. A layer that has been restructured yields nulls, not wrong numbers.
//
// What it deliberately does NOT do: turn an assessed value into a market value.
// In California the assessed value is the Proposition 13 figure -- the purchase price
// plus 2% a year -- so it is a floor, not the market. Using it as the market value
// would understate every lead's equity and quietly sink good properties in the
// ranking. If you want that approximation, set MARKET_VALUE_FROM_ASSESSED to a factor
// and it will be applied, and recorded, as an estimate.

import { parcelResolver } from '../../parcels.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const CANDIDATES = {
  assessed: ['assessedvalue', 'assessedval', 'assdvalue', 'totalassessedvalue', 'totalassessed',
    'avlvalassd', 'parcelvalue', 'propertyvalue', 'ownervalue', 'fullvalue', 'totalvalue', 'value'],
  land: ['landvalue', 'avlvalland', 'landassessedvalue'],
  improvement: ['improvementvalue', 'imprvalue', 'avlvalimpr', 'buildingvalue', 'structurevalue', 'improvements'],
  sqft: ['sqft', 'squarefeet', 'livingsqft', 'livingarea', 'sqftlivingarea', 'livingareasqft',
    'bldgarea', 'buildingarea', 'floorarea', 'grosssqft'],
  yearBuilt: ['yearbuilt', 'yrbuilt', 'yrbld', 'builtyear', 'yearbuiltactual', 'constructionyear'],
  units: ['units', 'numunits', 'unitcount', 'nunits', 'numberunits', 'structureunits'],
  bedrooms: ['bedrooms', 'beds', 'numbedrooms', 'bedroomcount'],
  bathrooms: ['bathrooms', 'baths', 'numbathrooms', 'bathroomcount'],
  lotSqft: ['lotsqft', 'lotsize', 'lotsqfeet', 'lotarea', 'landarea'],
};

// The first attribute that matches, by exact name first and then by alias.
export function pickField(attributes, kind) {
  const names = CANDIDATES[kind] || [];
  const keys = Object.keys(attributes || {});
  for (const want of names) {
    const exact = keys.find((k) => norm(k) === want);
    if (exact !== undefined) return attributes[exact];
  }
  for (const want of names) {
    const loose = keys.find((k) => norm(k).includes(want));
    if (loose !== undefined) return attributes[loose];
  }
  return null;
}

export function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function extractFacts(attributes) {
  const land = toNumber(pickField(attributes, 'land'));
  const improvement = toNumber(pickField(attributes, 'improvement'));
  let assessed = toNumber(pickField(attributes, 'assessed'));
  // Some layers publish land and improvement separately and no total.
  if (assessed === null && (land !== null || improvement !== null)) {
    assessed = (land || 0) + (improvement || 0) || null;
  }
  const yb = toNumber(pickField(attributes, 'yearBuilt'));
  return {
    assessed_value: assessed,
    living_sqft: toNumber(pickField(attributes, 'sqft')),
    lot_sqft: toNumber(pickField(attributes, 'lotSqft')),
    year_built: yb ? Math.round(yb) : null,
    units: toNumber(pickField(attributes, 'units')),
    bedrooms: toNumber(pickField(attributes, 'bedrooms')),
    bathrooms: toNumber(pickField(attributes, 'bathrooms')),
  };
}

export async function assessorProvider(job) {
  const resolver = parcelResolver(job.state, job.county);
  if (!resolver?.facts) return { skipped: `No parcel layer for ${job.state} ${job.county}` };

  let facts;
  try {
    facts = await resolver.facts({ apn: job.apn, address: job.address_line_1, city: job.city, zip: job.zip });
  } catch (e) {
    throw new Error(`The county's parcel layer did not answer: ${e.message}`);
  }
  if (!facts) return { skipped: 'The county has no parcel record for this property' };

  const f = extractFacts(facts.attributes);
  const out = { ...f, valuation_last_verified_at: new Date(), data_confidence: 'assessor' };

  // Opt-in market estimate. Off by default: the assessed value is a floor under
  // Proposition 13, not the market, and using it as one would sink good leads.
  const factor = Number(process.env.MARKET_VALUE_FROM_ASSESSED || 0);
  if (factor > 0 && f.assessed_value) {
    out.estimated_market_value = Math.round(f.assessed_value * factor);
    out.data_confidence = 'assessor_estimate';
  }
  return out;
}
