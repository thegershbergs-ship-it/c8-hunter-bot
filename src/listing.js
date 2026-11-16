// Listing records, site detection, deduplication, price/mileage history, relisting detection.
import { hash, nowIso, daysBetween } from './util.js';
import { normalizeFields } from './extract.js';

export const SITE_PATTERNS = [
  ['autotrader', /autotrader\.com/i], ['carscom', /(^|\.)cars\.com/i], ['cargurus', /cargurus\.com/i], ['carmax', /carmax\.com/i],
  ['carvana', /carvana\.com/i], ['truecar', /truecar\.com/i], ['edmunds', /edmunds\.com/i], ['bringatrailer', /bringatrailer\.com/i],
  ['carsandbids', /carsandbids\.com/i], ['facebook', /facebook\.com|fb\.com|fb\.me/i], ['craigslist', /craigslist\.org/i],
  ['chevrolet', /chevrolet\.com|gmcertified\.com/i], ['corvetteforum', /corvetteforum\.com/i], ['instagram', /instagram\.com/i],
];
export function siteOf(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return 'unknown'; }
  for (const [name, re] of SITE_PATTERNS) if (re.test(host)) return name;
  return 'dealer';
}

/** Canonical form of a listing URL (drop tracking params) for dedupe. */
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|ref|clickid|cid|campaign|source|trk|lnk|eid|mid|sid|zip|cmp|s_|icid|fbclid|gclid)/i.test(p)) u.searchParams.delete(p);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch { return url; }
}

/** Is this observation a C8 Corvette (or unknown)? Returns 'c8' | 'not_c8' | 'unknown'. */
export function generationCheck(f) {
  if (f.model && !/corvette/i.test(f.model)) return 'not_c8';
  if (f.year && f.year < 2020) return 'not_c8';
  if (f.year && f.year >= 2020 && (f.model ? /corvette/i.test(f.model) : true)) return 'c8';
  return 'unknown';
}

/**
 * Merge a new observation into the DB. Dedupe: VIN -> link -> close match.
 * Returns {listing, isNew, changes:[...]}.
 */
export function upsertObservation(db, obsRaw, { source, url, at = nowIso(), dataLevel = 'email' } = {}) {
  const obs = normalizeFields(obsRaw);
  const curl = url ? canonicalUrl(url) : null;
  let l = null;
  if (obs.vin && obs.vinValid) l = db.listings.find((x) => x.vin === obs.vin);
  if (!l && curl) l = db.listings.find((x) => x.links?.some((k) => k.url === curl));
  if (!l) l = closeMatch(db, obs);
  const changes = [];
  let isNew = false;
  if (!l) {
    isNew = true;
    const id = obs.vin && obs.vinValid ? obs.vin : 'L' + hash((curl || '') + JSON.stringify([obs.year, obs.trim, obs.miles, obs.price, obs.city]), 10);
    l = {
      id, vin: null, vinValid: null, year: null, make: 'Chevrolet', model: 'Corvette', variant: null, trim: null, body: null,
      price: null, miles: null, extColorName: null, intColorName: null, extColor: null, intColor: null,
      sellerName: null, sellerType: null, city: null, state: null, zip: null, links: [], photos: [], description: null,
      optionClaims: {}, ownersClaim: null, historyReportUrl: null, marketSignals: {}, cpo: false,
      firstSeen: at, lastSeen: at, status: 'active', priceHistory: [], mileageHistory: [], failReasons: [],
      history: null, eval: null, dataLevel, sources: [], flags: [],
    };
    db.put(l);
  } else {
    // relisting: same VIN reappears after being gone, or via a different seller/changed miles
    if (l.status === 'likely_sold' || l.status === 'removed') { changes.push('relisted'); l.flags = [...new Set([...(l.flags || []), 'relisted'])]; l.status = 'active'; }
    if (obs.sellerName && l.sellerName && norm(obs.sellerName) !== norm(l.sellerName)) { changes.push('different seller'); l.flags = [...new Set([...(l.flags || []), 'seller_changed'])]; }
  }
  // links
  if (curl && !l.links.some((k) => k.url === curl)) { l.links.push({ url: curl, site: siteOf(curl), firstSeen: at }); if (!isNew) changes.push('new link'); }
  if (source && !l.sources.includes(source)) l.sources.push(source);
  // price history (keep lowest current price across sites)
  if (obs.price) {
    const last = l.priceHistory.at(-1);
    if (!last || last.price !== obs.price) l.priceHistory.push({ at, price: obs.price, site: siteOf(curl || '') });
    if (l.price && obs.price < l.price) changes.push(`price drop ${l.price} -> ${obs.price}`);
    if (l.price && obs.price > l.price && l.links.length <= 1) changes.push(`price up ${l.price} -> ${obs.price}`);
    l.price = l.links.length > 1 && l.price ? Math.min(l.price, obs.price) : obs.price;
  }
  // mileage history + odometer consistency
  if (obs.miles != null) {
    const last = l.mileageHistory.at(-1);
    if (!last || last.miles !== obs.miles) {
      l.mileageHistory.push({ at, miles: obs.miles, source: dataLevel });
      if (last && obs.miles < last.miles - 50) { changes.push('mileage DECREASED'); l.flags = [...new Set([...(l.flags || []), 'odometer_decrease'])]; }
      else if (last) changes.push(`mileage ${last.miles} -> ${obs.miles}`);
    }
    l.miles = obs.miles;
  }
  // fill/overwrite fields (better data levels overwrite worse)
  const rank = { email: 1, pasted: 2, page: 3 };
  const better = (rank[dataLevel] || 0) >= (rank[l.dataLevel] || 0);
  for (const k of ['vin', 'vinValid', 'year', 'variant', 'trim', 'body', 'extColorName', 'intColorName', 'extColor', 'intColor', 'sellerName', 'sellerType', 'city', 'state', 'zip', 'description', 'historyReportUrl', 'ownersClaim', 'cpo', 'title', 'pageText']) {
    const v = obs[k];
    if (v === undefined || v === null || v === '' || v === 'other' && l[k]) continue;
    if (l[k] == null || better) l[k] = v;
  }
  if (obs.vin && obs.vinValid && l.id !== obs.vin && !db.get(obs.vin)) { // re-key to VIN when it becomes known
    delete db.d.listings[l.id]; l.aliases = [...(l.aliases || []), l.id]; l.id = obs.vin; db.put(l);
  }
  l.optionClaims = { ...(l.optionClaims || {}), ...(obs.optionClaims || {}) };
  if (obs.photos?.length) l.photos = [...new Set([...(l.photos || []), ...obs.photos])].slice(0, 40);
  if (obs.marketSignals && Object.keys(obs.marketSignals).length) l.marketSignals = { ...l.marketSignals, ...obs.marketSignals, source: siteOf(curl || ''), at };
  if (better) l.dataLevel = dataLevel;
  l.lastSeen = at;
  if (l.status === 'active' || isNew) l.status = 'active';
  return { listing: l, isNew, changes };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function closeMatch(db, o) {
  if (!o.year || o.miles == null) return null;
  return db.listings.find((x) => x.year === o.year && (!o.trim || !x.trim || x.trim === o.trim) && (!o.extColor || !x.extColor || x.extColor === o.extColor)
    && x.miles != null && Math.abs(x.miles - o.miles) <= 100
    && ((o.sellerName && x.sellerName && norm(o.sellerName) === norm(x.sellerName)) || (o.city && x.city && norm(o.city) === norm(x.city))));
}

/** Mark listings not seen for N days as likely sold. Returns changed listings. */
export function markLikelySold(db, days = 3) {
  const out = [];
  for (const l of db.active()) {
    // Only cars the bot actually re-checks (watchlisted + page re-check) can be judged "gone".
    // Email-only cars are just not re-announced, so they become 'stale' after 45 days instead.
    if (l.recheck && l.lastChecked && daysBetween(l.lastSeen) > days) { l.status = 'likely_sold'; l.soldClueAt = nowIso(); l.soldCluePrice = l.price; out.push(l); }
    else if (!l.recheck && daysBetween(l.lastSeen) > 45) l.status = 'stale';
  }
  return out;
}
