// Extract listing fields from HTML pages, alert-email snippets, or pasted text.
// Everything extracted here is a SELLER CLAIM until verified elsewhere.
import * as cheerio from 'cheerio';
import { findVins, quickDecode, isValidVin } from './vin.js';

export const EXT_COLORS = [
  ['black', /\b(black|carbon flash)\b/i], ['dark red', /\b(red mist|long beach red|radiant red|garnet)\b/i], ['red', /\b(torch red|red)\b/i],
  ['blue', /\b(elkhart lake blue|rapid blue|riptide blue|blue)\b/i], ['yellow', /\b(accelerate yellow|yellow)\b/i],
  ['silver', /\b(blade silver|silver flare|silver)\b/i], ['white', /\b(arctic white|white pearl|white)\b/i],
  ['gray', /\b(ceramic matrix|shadow gray|hypersonic gray|sea ?wolf gray|gr[ae]y)\b/i], ['orange', /\b(sebring orange|amplify orange|orange)\b/i],
  ['bronze', /\b(zeus bronze|caffeine|bronze|brown)\b/i], ['green', /\b(cacti green|green)\b/i], ['purple', /\b(hysteria purple|purple)\b/i],
];
export const INT_COLORS = [
  ['black', /\b(jet black|black)\b/i], ['natural', /\b(natural( dipped)?)\b/i], ['tan', /\b(tan|kalahari|saddle)\b/i], ['caramel', /\bcaramel\b/i],
  ['brown', /\b(artemis|brown|habanero)\b/i], ['white', /\b(white|ceramic)\b/i], ['red', /\b(adrenaline red|morello red|red)\b/i],
  ['gray', /\b(sky cool gray|gr[ae]y)\b/i], ['blue', /\b(tension blue|twilight blue|santorini blue|blue)\b/i], ['yellow', /\bstrike yellow\b/i],
];
export function colorFamily(name, table = EXT_COLORS) {
  if (!name) return null;
  for (const [fam, re] of table) if (re.test(name)) return fam;
  return 'other';
}

const num = (s) => Number(String(s).replace(/[^0-9.]/g, ''));

/** Parse useful fields from free text (listing description, email snippet, pasted text). */
export function parseText(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const out = {};
  const ym = t.match(/\b(20[2-3]\d)\s+(?:chevrolet\s+|chevy\s+)?corvette\b/i) || t.match(/\bcorvette\b[^.]{0,40}?\b(20[2-3]\d)\b/i);
  if (ym) out.year = Number(ym[1]);
  if (/\bcorvette\b/i.test(t)) { out.make = 'Chevrolet'; out.model = 'Corvette'; }
  if (/\bz06\b/i.test(t)) out.variant = 'Z06'; else if (/\be-?ray\b/i.test(t)) out.variant = 'E-Ray'; else if (/\bzr1x?\b/i.test(t)) out.variant = 'ZR1';
  else if (/\bstingray\b/i.test(t)) out.variant = 'Stingray';
  const trim = t.match(/\b([123])\s?LT\b/i); if (trim) out.trim = `${trim[1]}LT`;
  if (/\bconvertible\b|\bhardtop convertible\b|\bhtc\b/i.test(t)) out.body = 'convertible'; else if (/\bcoupe\b/i.test(t)) out.body = 'coupe';
  // price: prefer "Price: $x" / "$xx,xxx" values in a plausible range
  const prices = [...t.matchAll(/\$\s?(\d{2,3}(?:,\d{3})|\d{2,3}k)\b(?!\s*(?:\/|per)\s*mo)/gi)]
    .map((m) => (/k$/i.test(m[1]) ? num(m[1]) * 1000 : num(m[1]))).filter((p) => p >= 20000 && p <= 250000);
  if (prices.length) out.price = prices[0];
  const mi = t.match(/\b(\d{1,3}(?:,\d{3})|\d{1,6}|\d{1,3}(?:\.\d)?k)\s*(?:mi\b|miles\b|mileage)/i) || t.match(/\bmileage:?\s*(\d{1,3}(?:,\d{3})|\d{1,6})/i) || t.match(/\bodometer:?\s*(\d{1,3}(?:,\d{3})|\d{1,6})/i);
  if (mi) { const v = /k$/i.test(mi[1]) ? num(mi[1]) * 1000 : num(mi[1]); if (v >= 0 && v < 400000) out.miles = v; }
  const vins = findVins(t); if (vins.length) { out.vin = vins[0]; out.vinCandidates = vins; }
  const ext = t.match(/\b(?:exterior(?: color)?|ext\.?(?: color)?|color)\s*:?\s*([A-Za-z][A-Za-z ]{2,30}?)(?=\s*(?:\||,|;|interior|int\.|$|\.|\n|mileage|vin|transmission))/i);
  if (ext) out.extColorName = ext[1].trim();
  const int = t.match(/\b(?:interior(?: color)?|int\.?(?: color)?)\s*:?\s*([A-Za-z][A-Za-z ]{2,30}?)(?=\s*(?:\||,|;|exterior|$|\.|\n|mileage|vin|transmission|seats?))/i);
  if (int) out.intColorName = int[1].trim();
  const loc = t.match(/\b([A-Z][a-zA-Z.' -]{2,25}),\s*([A-Z]{2})\b(?:\s+(\d{5}))?/);
  if (loc && STATES.has(loc[2])) { out.city = loc[1].trim(); out.state = loc[2]; if (loc[3]) out.zip = loc[3]; }
  const zip = t.match(/\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b/); if (zip && !out.zip) out.zip = zip[1];
  const owners = t.match(/\b(one|1|single|two|2|three|3|four|4)[- ]owner\b/i);
  if (owners) out.ownersClaim = { one: 1, '1': 1, single: 1, two: 2, '2': 2, three: 3, '3': 3, four: 4, '4': 4 }[owners[1].toLowerCase()];
  out.optionClaims = optionClaimsFromText(t);
  if (/\bprivate (party|seller)\b|\bby owner\b/i.test(t)) out.sellerType = 'private';
  if (/\bcertified pre-?owned\b|\bcpo\b/i.test(t)) out.cpo = true;
  return out;
}

export function optionClaimsFromText(t) {
  const o = {};
  if (/\bz51\b/i.test(t)) o.Z51 = true;
  if (/\bmag(netic)?\s*(selective )?ride\b|\bmrc\b|\bfe4\b|\bfe2\b/i.test(t)) o.MagRide = true;
  if (/\bfront (axle |end )?lift\b|\bnose lift\b|\be60\b/i.test(t)) o.FrontLift = true;
  if (/\bperformance exhaust\b|\bnpp\b|\bdual[- ]mode exhaust\b/i.test(t)) o.PerfExhaust = true;
  if (/\bcompetition (sport )?seats?\b|\bae4\b/i.test(t)) o.Seats = 'Competition';
  else if (/\bgt2\b|\bah2\b/i.test(t)) o.Seats = 'GT2';
  else if (/\bgt1\b|\baq9\b/i.test(t)) o.Seats = 'GT1';
  return o;
}

const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));

/** Extract from a full listing web page (JSON-LD first, then meta tags, then visible text). */
export function parsePage(html, url) {
  const $ = cheerio.load(html);
  const out = { photos: [], jsonld: false };
  $('script[type="application/ld+json"]').each((_, el) => {
    let j; try { j = JSON.parse($(el).contents().text()); } catch { return; }
    const items = [].concat(j, j?.['@graph'] || []).flat();
    for (const it of items) {
      const types = [].concat(it?.['@type'] || []).map(String);
      if (!types.some((x) => /^(Car|Vehicle|Product|Motorcycle|IndividualProduct)$/i.test(x))) continue;
      out.jsonld = true;
      if (it.vehicleIdentificationNumber) out.vin = String(it.vehicleIdentificationNumber).toUpperCase();
      const mo = it.mileageFromOdometer; if (mo) out.miles = num(mo.value ?? mo);
      const offer = [].concat(it.offers || [])[0]; if (offer?.price) out.price = num(offer.price);
      if (offer?.seller?.name) out.sellerName = offer.seller.name;
      if (offer?.seller?.address) { const a = offer.seller.address; out.city ||= a.addressLocality; out.state ||= a.addressRegion; out.zip ||= a.postalCode; }
      if (it.color) out.extColorName = it.color;
      if (it.vehicleInteriorColor) out.intColorName = it.vehicleInteriorColor;
      if (it.vehicleModelDate || it.modelDate || it.productionDate) out.year = num(it.vehicleModelDate || it.modelDate || it.productionDate) || out.year;
      if (it.bodyType) out.bodyName = it.bodyType;
      if (it.vehicleConfiguration) out.trimName = it.vehicleConfiguration;
      if (it.description) out.description = String(it.description).slice(0, 4000);
      for (const im of [].concat(it.image || [])) { const u = typeof im === 'string' ? im : im?.url || im?.contentUrl; if (u) out.photos.push(u); }
      if (it.name) out.title = it.name;
    }
  });
  const meta = (p) => $(`meta[property="${p}"]`).attr('content') || $(`meta[name="${p}"]`).attr('content');
  out.title ||= meta('og:title') || $('title').text();
  const ogImg = meta('og:image'); if (ogImg) out.photos.push(ogImg);
  $('img').each((_, el) => { const s = $(el).attr('data-src') || $(el).attr('src') || ''; if (/^https?:\/\//.test(s) && /\.(jpe?g|webp|png)(\?|$)/i.test(s) && !/logo|icon|sprite|badge|avatar/i.test(s)) out.photos.push(s); });
  out.photos = [...new Set(out.photos)].slice(0, 40);
  $('script,style,noscript,svg').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  out.pageText = text.slice(0, 12000);
  const fromText = parseText(`${out.title || ''} ${text}`);
  for (const [k, v] of Object.entries(fromText)) if (out[k] === undefined || out[k] === null || out[k] === '') out[k] = v;
  if (out.trimName && !out.trim) { const m = String(out.trimName).match(/\b([123])LT\b/i); if (m) out.trim = `${m[1]}LT`; }
  if (out.bodyName && !out.body) out.body = /convertible/i.test(out.bodyName) ? 'convertible' : /coupe/i.test(out.bodyName) ? 'coupe' : undefined;
  out.historyReportUrl = findHistoryLink($, url);
  out.marketSignals = findMarketSignals(text);
  return out;
}

function findHistoryLink($, base) {
  let found = null;
  $('a[href]').each((_, el) => {
    const h = $(el).attr('href') || '';
    if (!found && /carfax\.com|autocheck\.com|vhr|vehicle-?history/i.test(h)) { try { found = new URL(h, base).href; } catch { /* ignore */ } }
  });
  return found;
}

/** Free public market signals sometimes shown on listing pages (labeled by source). */
export function findMarketSignals(text) {
  const s = {};
  const deal = text.match(/\b(Great|Good|Fair|High|Overpriced) (Deal|Price)\b/); if (deal) s.dealRating = deal[0];
  const imv = text.match(/(?:IMV|instant market value|market value|est\.? market value)[^$]{0,30}\$\s?(\d{2,3},\d{3})/i); if (imv) s.marketValue = num(imv[1]);
  const dom = text.match(/(\d{1,4})\s+days? (?:on (?:the )?market|on CarGurus|listed)/i); if (dom) s.daysOnMarket = Number(dom[1]);
  const drop = text.match(/price (?:dropped|drop|reduced)[^$]{0,30}\$\s?(\d{1,2},\d{3}|\d{3,4})/i); if (drop) s.lastDrop = num(drop[1]);
  return s;
}

/** Normalize raw extracted fields into listing fields. */
export function normalizeFields(raw) {
  const o = { ...raw };
  if (o.vin) { o.vin = String(o.vin).toUpperCase(); o.vinValid = isValidVin(o.vin); const q = quickDecode(o.vin); if (q?.isCorvette) { o.year ||= q.year; o.body ||= q.body; o.trim ||= q.trim; o.variant ||= q.variant; } }
  o.extColor = colorFamily(o.extColorName, EXT_COLORS);
  o.intColor = colorFamily(o.intColorName, INT_COLORS);
  return o;
}
