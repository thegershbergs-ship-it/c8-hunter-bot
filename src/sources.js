// Channel 2: automatic direct sources, ONLY sites whose robots.txt and terms allow it (see RESEARCH.md).
// usedcorvettesforsale.com: robots.txt has no rules for general bots; terms have no anti-automation clause (checked 2026-11-16).
import { politeFetch } from './fetcher.js';
import { parsePage } from './extract.js';
import { upsertObservation, canonicalUrl } from './listing.js';
import { nowIso, log } from './util.js';

export const DIRECT_SOURCES = {
  usedcorvettesforsale: {
    index: ['https://usedcorvettesforsale.com/c8-corvettes/', 'https://usedcorvettesforsale.com/corvettes-for-sale-gen.html?off=1&cid=8&s_res=AND&s_by=&a_d=desc'],
    detail: /^(?:https:\/\/usedcorvettesforsale\.com\/)?(20[2-3]\d-Corvette-[A-Za-z-]+-\d+\.html)$/,
    base: 'https://usedcorvettesforsale.com/',
  },
};

/** Returns {found, newOnes:[listing], seen} and updates lastSeen for cars still listed. */
export async function runDirectSource(db, name, ctx) {
  const src = DIRECT_SOURCES[name];
  const s = ctx.s;
  const links = new Set();
  for (const idx of src.index) {
    const r = await politeFetch(idx, s, db, { mode: 'auto' });
    if (!r.ok) { if (idx === src.index[0]) throw new Error(r.reason); continue; }
    for (const m of r.html.matchAll(/href="([^"]+)"/g)) { const mm = m[1].match(src.detail); if (mm) links.add(src.base + mm[1]); }
  }
  if (!links.size) throw new Error('no listings found on index page (layout change?)');
  const out = { found: links.size, fresh: [], seen: 0 };
  let fetched = 0;
  for (const url of links) {
    const cu = canonicalUrl(url);
    const existing = db.listings.find((l) => l.links?.some((k) => k.url === cu));
    if (existing) { existing.lastSeen = nowIso(); existing.lastChecked = nowIso(); existing.recheck = true; if (existing.status === 'likely_sold') existing.status = 'active'; out.seen++; continue; }
    if (fetched >= s.fetch.max_pages_per_run) break; // rest next run
    const yr = Number(url.match(/\/(20\d\d)-/)?.[1]);
    if (yr && yr < s.hard.min_model_year) continue;
    const r = await politeFetch(url, s, db, { mode: 'auto' });
    fetched++;
    if (!r.ok) continue;
    const fields = parsePage(r.html, url);
    fields.sellerName ||= fields.pageText?.match(/For Sale By\s*:\s*(\w+)/i)?.[1] === 'Private' ? 'Private seller' : undefined;
    if (/For Sale By\s*:\s*Private/i.test(fields.pageText || '')) fields.sellerType = 'private';
    const { listing: l, isNew } = upsertObservation(db, fields, { url, source: name, dataLevel: 'page' });
    l.recheck = true; l.lastChecked = nowIso();
    if (isNew) out.fresh.push(l);
  }
  // quality check: if most fresh listings lack mileage/year, the layout probably changed
  const bad = out.fresh.filter((l) => l.miles == null || !l.year).length;
  out.degraded = out.fresh.length >= 4 && bad / out.fresh.length > 0.5;
  log(`${name}: ${out.found} listed, ${out.fresh.length} new, ${out.seen} still listed`);
  return out;
}
