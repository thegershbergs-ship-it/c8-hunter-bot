// Fair value from the bot's own database of C8 listings + auction results. Never invents comparables.
import { DB } from './db.js';
import { daysBetween } from './util.js';

// Default adjustments (dollars). Mileage slope and year step are re-estimated from the data when enough exists.
export const DEFAULT_ADJ = { perMile: 0.15, perYear: 3000, trim: { '1LT': 0, '2LT': 4000, '3LT': 7000 }, Z51: 3000, MagRide: 1000, FrontLift: 1000, convertible: 4000, privateSeller: -0.03 };

const has = (l, k) => l.optionsResolved?.[k]?.value === true || l.optionClaims?.[k] === true;

function pool(db, s) {
  const all = [...db.listings, ...DB.archived()];
  const out = all.filter((x) => x.price && x.year && (x.variant || 'Stingray') === 'Stingray' && x.miles != null && daysBetween(x.lastSeen || x.firstSeen) <= s.market.comparable_max_age_days && !(x.flags || []).includes('scam'));
  for (const a of db.d.auctions || []) if (a.price && a.year && a.miles != null && a.sold && daysBetween(a.date) <= 365) out.push({ ...a, id: 'A:' + a.url, isAuction: true, variant: 'Stingray', links: [{ url: a.url, site: a.source }] });
  return out;
}

/** Estimate $/mile and $/year from data (simple, robust), clamped to sane ranges. */
export function estimateAdjustments(listings) {
  const adj = structuredClone(DEFAULT_ADJ);
  const method = [];
  // mileage slope: within same year+trim groups, pairwise slopes median
  const slopes = [];
  const groups = {};
  for (const l of listings) (groups[`${l.year}|${l.trim}|${l.body}`] ||= []).push(l);
  for (const g of Object.values(groups)) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
    const dm = g[j].miles - g[i].miles; if (Math.abs(dm) < 3000) continue;
    slopes.push(-(g[j].price - g[i].price) / dm);
  }
  if (slopes.length >= 8) { adj.perMile = clamp(median(slopes), 0.05, 0.4); method.push(`$/mile from ${slopes.length} same-year/trim pairs`); } else method.push('$/mile default 0.15 (not enough data yet)');
  const byYear = {};
  for (const l of listings) if (l.trim === '1LT' || l.trim === '2LT') (byYear[l.year] ||= []).push(l.price + adj.perMile * (l.miles - 20000) - adj.trim[l.trim]);
  const yrs = Object.keys(byYear).map(Number).sort();
  const steps = [];
  for (let i = 1; i < yrs.length; i++) if (byYear[yrs[i]].length >= 3 && byYear[yrs[i - 1]].length >= 3) steps.push(median(byYear[yrs[i]]) - median(byYear[yrs[i - 1]]));
  if (steps.length) { adj.perYear = clamp(median(steps), 500, 8000); method.push(`$/model-year from ${steps.length} year pair(s)`); } else method.push('$/model-year default 3000');
  adj.method = method.join('; ');
  return adj;
}

/** Fair value range for listing l. */
export function fairValue(db, l, s) {
  const p = pool(db, s);
  const adj = estimateAdjustments(p.filter((x) => !x.isAuction));
  const target = { year: l.year, miles: l.miles ?? 25000, trim: l.trim || '1LT', body: l.body || 'coupe' };
  const comps = p.filter((x) => x.id !== l.id && (!l.vin || x.vin !== l.vin) && Math.abs(x.year - target.year) <= 1 && (x.body || 'coupe') === target.body && Math.abs(x.miles - target.miles) <= s.market.comparable_mileage_window)
    .map((x) => {
      let a = x.price;
      a += (x.miles - target.miles) * adj.perMile;
      a += (target.year - x.year) * adj.perYear;
      a += (adj.trim[target.trim] || 0) - (adj.trim[x.trim || '1LT'] || 0);
      for (const k of ['Z51', 'MagRide', 'FrontLift']) a += (has(l, k) ? adj[k] : 0) - (has(x, k) ? adj[k] : 0);
      if (x.sellerType === 'private' && l.sellerType !== 'private') a *= 1 - adj.privateSeller;
      const sim = Math.abs(x.year - target.year) * 3 + Math.abs(x.miles - target.miles) / 2000 + (x.trim === target.trim ? 0 : 2) + daysBetween(x.lastSeen || x.firstSeen || x.date) / 30;
      return { id: x.id, title: `${x.year} ${x.trim || ''} ${x.body || ''}`.trim(), price: x.price, miles: x.miles, adjusted: Math.round(a), url: x.links?.[0]?.url || x.url, kind: x.isAuction ? 'auction sold price' : x.status === 'likely_sold' ? 'likely-sold last ask' : 'dealer/seller asking price', sim };
    })
    .sort((a, b) => a.sim - b.sim).slice(0, 12);
  const sig = l.marketSignals?.marketValue ? { value: l.marketSignals.marketValue, source: `${l.marketSignals.source || 'site'} estimate (${l.marketSignals.dealRating || 'no rating'})` } : null;
  if (comps.length < s.market.min_comparables) {
    const vals = comps.map((c) => c.adjusted);
    return {
      enough: false, comps, adj,
      low: vals.length ? Math.min(...vals) : sig ? Math.round(sig.value * 0.95) : null,
      high: vals.length ? Math.max(...vals) : sig ? Math.round(sig.value * 1.05) : null,
      mid: vals.length ? median(vals) : sig?.value ?? null, siteEstimate: sig,
      note: `Not enough data for a reliable value yet (${comps.length} comparable${comps.length === 1 ? '' : 's'}).${sig ? ' Leaning on the site\'s own market estimate.' : ''}`,
    };
  }
  const vals = comps.map((c) => c.adjusted).sort((a, b) => a - b);
  const mid = median(vals);
  const q1 = vals[Math.floor(vals.length * 0.25)], q3 = vals[Math.floor(vals.length * 0.75)];
  const half = Math.max((q3 - q1) / 2, mid * 0.03);
  return { enough: true, comps, adj, low: Math.round(mid - half), high: Math.round(mid + half), mid: Math.round(mid), siteEstimate: sig, note: `${comps.length} comparables; ${adj.method}` };
}

/** Where a price sits in the fair range, as % (0 = low end, 100 = high end). */
export function positionInRange(price, fv) {
  if (!fv?.low || !fv?.high || fv.high === fv.low) return null;
  return Math.round(((price - fv.low) / (fv.high - fv.low)) * 100);
}

/** Market snapshot (median by year/trim, 30-day trend, which years fit budget). */
export function marketSnapshot(db, s) {
  const act = db.listings.filter((l) => l.price && l.year && (l.variant || 'Stingray') === 'Stingray' && daysBetween(l.lastSeen) <= 30);
  const by = {};
  for (const l of act) (by[`${l.year} ${l.trim || '?'}`] ||= []).push(l.price);
  const rows = Object.entries(by).sort().map(([k, v]) => ({ k, n: v.length, median: median(v) }));
  const under = act.filter((l) => l.price <= s.price.max);
  const yrs = {}; for (const l of under) yrs[l.year] = (yrs[l.year] || 0) + 1;
  const prev = db.listings.filter((l) => l.price && daysBetween(l.firstSeen) > 30 && daysBetween(l.firstSeen) <= 60);
  const trend = prev.length >= 5 && act.length >= 5 ? median(act.map((l) => l.price)) - median(prev.map((l) => l.price)) : null;
  return { total: act.length, underMax: under.length, rows, yearsUnderBudget: yrs, trend };
}

export function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
