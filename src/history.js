// Free history stack ("CARFAX substitute"). Every fact carries a truth label:
// 'verified' (bot read an official/third-party source), 'claim' (seller says), 'unknown'.
import { fetchRetry, nowIso, sleep, daysBetween } from './util.js';
import { isValidVin, quickDecode } from './vin.js';

export const T = { V: 'verified', C: 'claim', U: 'unknown' };
const fact = (value, truth, source) => ({ value, truth, source });

export async function nhtsaDecode(db, vin) {
  if (db.d.cache.vin[vin]) return db.d.cache.vin[vin];
  db.inc('nhtsa'); await sleep(1000);
  const res = await fetchRetry(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`);
  if (!res.ok) throw new Error('vPIC HTTP ' + res.status);
  const r = (await res.json()).Results?.[0] || {};
  const d = {
    at: nowIso(), errorCode: r.ErrorCode, errorText: r.ErrorText, year: Number(r.ModelYear) || null, make: r.Make, model: r.Model, trim: r.Trim, series: r.Series,
    body: /convertible/i.test(r.BodyClass || '') ? 'convertible' : /coupe/i.test(r.BodyClass || '') ? 'coupe' : r.BodyClass || null,
    engine: r.EngineModel, displacement: r.DisplacementL, transmission: [r.TransmissionStyle, r.TransmissionSpeeds].filter(Boolean).join(' '), plant: [r.PlantCity, r.PlantState].filter(Boolean).join(', '),
  };
  db.d.cache.vin[vin] = d;
  return d;
}

export async function nhtsaRecalls(db, year) {
  const c = db.d.cache.recalls[year];
  if (c && daysBetween(c.at) < 7) return c.items;
  db.inc('nhtsa'); await sleep(1000);
  const res = await fetchRetry(`https://api.nhtsa.gov/recalls/recallsByVehicle?make=CHEVROLET&model=CORVETTE&modelYear=${year}`);
  if (res.status === 400 || res.status === 404) { db.d.cache.recalls[year] = { at: nowIso(), items: [] }; return []; } // NHTSA has no data for this year yet
  if (!res.ok) throw new Error('Recalls HTTP ' + res.status);
  const items = ((await res.json()).results || []).map((r) => ({ id: r.NHTSACampaignNumber, date: r.ReportReceivedDate, component: r.Component, summary: plain(r.Summary) }));
  db.d.cache.recalls[year] = { at: nowIso(), items };
  return items;
}
function plain(s) {
  const t = String(s || '').replace(/\s+/g, ' ').replace(/^General Motors,? LLC \(GM\) is recalling certain [^.]*\.\s*/i, '');
  return t.split('. ')[0].slice(0, 160);
}

/** Variant from a vPIC decode. */
export function variantFromDecode(d) {
  if (!d) return null;
  const s = `${d.trim || ''} ${d.series || ''} ${d.engine || ''}`;
  if (/z06|lt6/i.test(s)) return 'Z06';
  if (/e-?ray/i.test(s)) return 'E-Ray';
  if (/zr1/i.test(s)) return 'ZR1';
  if (/lt2|stingray|[123]lt/i.test(s)) return 'Stingray';
  return null;
}

/**
 * Run the history stack on a listing. Mutates l.history and returns it.
 * Never throws: each check records its own error.
 */
export async function runHistory(db, l, { errors = [] } = {}) {
  const h = { at: nowIso(), checks: {}, recalls: [], mismatches: [], serious: [] };
  // 1. check digit
  if (!l.vin) h.checks.vin = fact('No VIN in listing', T.U, 'listing');
  else if (!isValidVin(l.vin)) { h.checks.vin = fact(`VIN ${l.vin} FAILS check digit`, T.V, 'check-digit math'); h.serious.push('Invalid VIN (check digit fails): typo, fake listing, or fraud'); }
  else h.checks.vin = fact(`VIN ${l.vin} check digit OK`, T.V, 'check-digit math');

  // 2. NHTSA decode
  if (l.vin && isValidVin(l.vin)) {
    try {
      const d = await nhtsaDecode(db, l.vin);
      l.vinDecode = { ...d, transmissionOk: d.transmission ? /automatic/i.test(d.transmission) && /8/.test(d.transmission) : null };
      const variant = variantFromDecode(d) || quickDecode(l.vin)?.variant;
      h.checks.decode = fact(`${d.year} ${d.make} ${d.model} ${d.trim || ''} ${d.body || ''}, ${d.engine || ''}, ${d.transmission || ''}, built ${d.plant || '?'}`.replace(/\s+/g, ' '), T.V, 'NHTSA vPIC');
      if (d.model && !/corvette/i.test(d.model)) h.serious.push(`VIN decodes to a ${d.make} ${d.model}, not a Corvette`);
      if (d.year && l.year && d.year !== l.year) h.mismatches.push(`Listing says ${l.year}, VIN says ${d.year}`);
      if (d.body && l.body && d.body !== l.body && /coupe|convertible/.test(d.body)) h.mismatches.push(`Listing says ${l.body}, VIN says ${d.body}`);
      const decTrim = (d.trim || '').match(/\b([123])LT\b/i)?.[0]?.toUpperCase();
      if (decTrim && l.trim && decTrim !== l.trim) h.mismatches.push(`Listing says ${l.trim}, VIN says ${decTrim}`);
      if (variant && l.variant && variant !== l.variant) h.mismatches.push(`Listing says ${l.variant}, VIN says ${variant}`);
      // VIN is authoritative for these
      if (d.year) l.year = d.year; if (/coupe|convertible/.test(d.body || '')) l.body = d.body; if (decTrim) l.trim = decTrim; if (variant) l.variant = variant;
      // Year or variant mismatch = serious (different car). Trim/body mismatch = yellow (listing typos are common).
      const hard = h.mismatches.filter((m) => /VIN says (20\d\d|Z06|E-Ray|ZR1|Stingray)$/.test(m));
      if (hard.length) h.serious.push('VIN decodes to a different car than advertised: ' + hard.join('; '));
    } catch (e) { h.checks.decode = fact('NHTSA decode failed this run (will retry)', T.U, 'NHTSA vPIC'); errors.push('vPIC: ' + e.message); }
  }

  // 3. recalls by model year
  if (l.year) {
    try {
      const items = await nhtsaRecalls(db, l.year);
      h.recalls = items.filter((r) => !/ZR1X|E-Ray/i.test(r.summary) || l.variant !== 'Stingray');
      h.checks.recalls = fact(items.length ? `${items.length} recall(s) for ${l.year} Corvettes. Confirm completion by VIN with a Chevy dealer` : `No NHTSA recalls listed for ${l.year} Corvette`, T.V, 'NHTSA recalls API');
    } catch (e) { h.checks.recalls = fact('Recall lookup failed this run', T.U, 'NHTSA'); errors.push('recalls: ' + e.message); }
  }

  // 4. free history report link
  h.checks.report = l.historyReportUrl ? fact(`Free history report linked: ${l.historyReportUrl}`, l.reportRead ? T.V : T.C, l.reportRead ? 'report page' : 'listing link (not yet read)') : fact('No free CARFAX/AutoCheck link found', T.U, 'listing');
  if (l.reportFacts) {
    const r = l.reportFacts;
    h.checks.owners = fact(r.owners != null ? `${r.owners} owner(s)` : 'owners not shown', r.owners != null ? T.V : T.U, 'history report');
    h.checks.accidents = fact(r.accidents != null ? (r.accidents === 0 ? 'No accidents reported on the report' : `${r.accidents} accident/damage report(s)`) : 'unknown', r.accidents != null ? T.V : T.U, 'history report');
    h.checks.title = fact(r.titleBrand ? `Title brand: ${r.titleBrand}` : r.titleClean ? 'No title brands on report' : 'unknown', r.titleBrand || r.titleClean ? T.V : T.U, 'history report');
    if (r.titleBrand) h.serious.push(`History report shows title brand: ${r.titleBrand}`);
    if (r.usage && /rental|fleet/i.test(r.usage)) h.checks.usage = fact(`Usage: ${r.usage}`, T.V, 'history report');
  } else {
    h.checks.owners = l.ownersClaim ? fact(`${l.ownersClaim} owner(s)`, T.C, 'listing text') : fact('Number of owners unknown', T.U, '');
    h.checks.accidents = /no accidents|accident[- ]free|clean (carfax|autocheck|history)/i.test(l.description || '') ? fact('Seller says no accidents (report NOT read)', T.C, 'listing text') : fact('Accident history unknown', T.U, '');
    h.checks.title = /clean title/i.test(l.description || '') ? fact('Seller says clean title', T.C, 'listing text') : fact('Title status unknown', T.U, '');
  }

  // 5. NICB: manual link only
  h.checks.nicb = fact('NICB VINCheck: tap the link (free, manual: theft & insurance total-loss records)', T.U, 'manual');

  // 7. odometer consistency
  const mh = l.mileageHistory || [];
  const dec = mh.some((m, i) => i > 0 && m.miles < mh[i - 1].miles - 50);
  if (dec || (l.flags || []).includes('odometer_decrease')) { h.checks.odometer = fact('Mileage DECREASED between observations', T.V, 'bot price/mileage history'); h.serious.push('Odometer inconsistency: mileage went down'); }
  else if (l.odometerPhoto != null && l.miles != null && Math.abs(l.odometerPhoto - l.miles) > 500) { h.checks.odometer = fact(`Odometer photo shows ${l.odometerPhoto}, listing says ${l.miles}`, T.V, 'photo'); h.serious.push('Odometer photo does not match listed mileage'); }
  else h.checks.odometer = fact(mh.length > 1 ? `Consistent across ${mh.length} observations` : 'Only one mileage reading so far', mh.length > 1 ? T.V : T.C, 'bot history');

  // 8. warranty estimate
  h.checks.warranty = fact(warrantyEstimate(l), T.U, 'estimate from model year + miles (confirm with a dealer by VIN)');
  l.history = h;
  return h;
}

/** Rough remaining factory coverage. In-service date assumed ~Jan 1 of the model year unless known. */
export function warrantyEstimate(l, now = new Date()) {
  if (!l.year) return 'Unknown (no model year)';
  const start = l.inServiceDate ? new Date(l.inServiceDate) : new Date(`${l.year - 1}-10-01`);
  const yrs = (now - start) / (365.25 * 86400000);
  const m = l.miles ?? Infinity;
  const parts = [];
  parts.push(yrs < 3 && m < 36000 ? `bumper-to-bumper likely left (~${Math.max(0, 3 - yrs).toFixed(1)} yr / ${Math.max(0, 36000 - m).toLocaleString()} mi)` : 'bumper-to-bumper (3yr/36k) likely expired');
  parts.push(yrs < 5 && m < 60000 ? `powertrain likely left (~${Math.max(0, 5 - yrs).toFixed(1)} yr / ${Math.max(0, 60000 - m).toLocaleString()} mi)` : 'powertrain (5yr/60k) likely expired');
  if (l.cpo) parts.push('CPO claimed: 6yr/100k powertrain from in-service + 12mo/12k limited (verify)');
  return parts.join('; ');
}
export function warrantyPoints(l, now = new Date()) {
  if (!l.year) return 0.5;
  const yrs = (now - new Date(`${l.year - 1}-10-01`)) / (365.25 * 86400000);
  const m = l.miles ?? 60000;
  if (yrs < 3 && m < 36000) return 1;
  if ((yrs < 5 && m < 60000) || (l.cpo && yrs < 6 && m < 100000)) return 0.6;
  return 0.2;
}
