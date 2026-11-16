// Rule-engine scoring (100 pts), confidence, scam risk, class. Weights/thresholds from settings.yaml.
import { textSignals, dealerFeeFlags } from './rules.js';
import { warrantyPoints, T } from './history.js';

const lerp = (x, pts) => { // piecewise linear over [[x,y],...] sorted by x
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0); }
  return pts.at(-1)[1];
};

/** Combine option evidence: AI photo findings > seller claims > unknown. */
export function resolveOptions(l) {
  const out = {};
  const ai = l.aiFindings?.options || {};
  for (const k of ['Z51', 'MagRide', 'FrontLift', 'PerfExhaust', 'Seats']) {
    const a = ai[k];
    if (a && a.value !== undefined && a.value !== null && a.truth === T.V) out[k] = { value: a.value, truth: T.V, source: a.evidence || 'photos/report' };
    else if (l.optionClaims?.[k] !== undefined) out[k] = { value: l.optionClaims[k], truth: T.C, source: 'listing text' };
    else if (a && a.value !== undefined && a.value !== null) out[k] = { value: a.value, truth: T.C, source: a.evidence || 'AI read of listing' };
    else out[k] = { value: null, truth: T.U, source: '' };
  }
  if (out.Z51.value === true && out.PerfExhaust.truth === T.U) out.PerfExhaust = { value: true, truth: out.Z51.truth, source: 'included with Z51' };
  l.optionsResolved = out;
  return out;
}

const SCAM_STRONG = [
  [/\b(deployed|military (deployment|base)|stationed overseas|on deployment)\b/i, 'Seller says they are deployed/military (classic scam script)'],
  [/\b(moved|moving|relocat\w+) (overseas|abroad|out of the country)\b/i, 'Seller moved overseas'],
  [/\b(passed away|deceased|late (husband|wife|father|son)|died)\b/i, 'Selling for someone who passed away (common scam script)'],
  [/\b(wire transfer|western union|moneygram|gift ?cards?|bitcoin|crypto|usdt)\b/i, 'Asks for wire / gift card / crypto payment'],
  [/\b(ebay (motors )?(protection|escrow)|escrow (service|company)|shipping (company|protection|agent)|google (pay|wallet) protection|amazon (pay|escrow))\b/i, 'Insists on a third-party escrow/shipping company'],
  [/\b(no inspections?|inspection not (allowed|possible)|can'?t (be )?inspect)\b/i, 'Refuses inspection'],
  [/\b(won'?t|will not|can'?t) (give|provide|share) (the )?vin\b/i, 'Refuses to give the VIN'],
];
const SCAM_SOFT = [
  [/\b(zelle|cash ?app|venmo|paypal friends)\b/i, 'Mentions payment apps'],
  [/\b(text|email) only\b|\bno (phone )?calls\b/i, 'Contact by text/email only'],
  [/\bfirst \$\d|\bfirst come first serve(d)?\b.*\bdeposit\b/i, 'Pushes for a quick deposit'],
];

export function scamRisk(l, ctx) {
  const reasons = [];
  const text = [l.title, l.description, l.pageText, l.pastedText].filter(Boolean).join(' ');
  let level = 0;
  for (const [re, msg] of SCAM_STRONG) if (re.test(text)) { reasons.push(msg); level = 2; }
  for (const [re, msg] of SCAM_SOFT) if (re.test(text)) { reasons.push(msg); level = Math.max(level, 1); }
  if (l.vin && l.vinValid === false) { reasons.push('VIN fails check digit'); level = 2; }
  if (l.history?.serious?.some((x) => /different car/.test(x))) { reasons.push('VIN decodes to a different car'); level = 2; }
  if (/\b(canad|mexic|out[- ]of[- ]country|foreign) title\b/i.test(text)) { reasons.push('Out-of-country title'); level = 2; }
  const fv = ctx.fv;
  if (fv?.mid && l.price && l.price < fv.mid * (1 - ctx.s.price.far_below_market_pct / 100)) {
    const pct = Math.round((1 - l.price / fv.mid) * 100);
    reasons.push(`Price ${pct}% below fair value with no stated reason`);
    level = Math.max(level, l.sellerType === 'private' || !l.vin ? 2 : 1);
  }
  if (ctx.photoDupes?.length) { reasons.push(`Photos also appear on another listing (${ctx.photoDupes.length})`); level = 2; }
  if ((l.photos || []).length && l.photos.length < 6) { reasons.push('Very few photos'); level = Math.max(level, 1); }
  if (l.aiFindings?.scamRisk === 'High') { reasons.push(...(l.aiFindings.scamReasons || ['AI flagged scam patterns'])); level = 2; }
  else if (l.aiFindings?.scamRisk === 'Medium') level = Math.max(level, 1);
  return { level: ['Low', 'Medium', 'High'][level], reasons: [...new Set(reasons)] };
}

/** Duplicate-photo check against other listings with a different VIN. */
export function photoDupes(db, l) {
  if (!l.photos?.length) return [];
  const mine = new Set(l.photos.map((u) => u.split('?')[0]));
  return db.listings.filter((x) => x.id !== l.id && x.vin && l.vin && x.vin !== l.vin && (x.photos || []).some((u) => mine.has(u.split('?')[0]))).map((x) => x.id);
}

/**
 * Score a listing. ctx: {s, fv, distance, dupes}
 * Returns eval object (also stored on l.eval by caller).
 */
export function scoreListing(l, ctx) {
  const { s, fv, distance } = ctx;
  const W = s.weights;
  const unknowns = [];
  const h = l.history || { checks: {}, serious: [] };
  const c = h.checks || {};
  const tv = (f, ok, label, claim = 0.6) => (!f || f.truth === T.U ? (unknowns.push(label), 0.5) : f.truth === T.V ? ok : claim);
  const opts = resolveOptions(l);
  const text = [l.title, l.description, l.pageText, l.pastedText].filter(Boolean).join(' ');
  const sig = textSignals(text);
  const ai = l.aiFindings || {};

  // 1. history & title
  const titleScore = tv(c.title, /no title brands/i.test(c.title?.value || '') ? 1 : 0, 'title');
  const accScore = c.accidents?.truth === T.V ? (/no accidents/i.test(c.accidents.value) ? 1 : 0.3) : tv(c.accidents, 1, 'accidents');
  const odoScore = c.odometer?.truth === T.V ? (/consistent/i.test(c.odometer.value) ? 1 : 0) : 0.7;
  const reportScore = l.reportFacts ? 1 : l.historyReportUrl ? 0.6 : (unknowns.push('history report'), 0.4);
  const vinScore = !l.vin ? (unknowns.push('VIN'), 0.3) : l.vinValid ? 1 : 0;
  const hist = W.history_title * (0.3 * titleScore + 0.3 * accScore + 0.15 * odoScore + 0.15 * reportScore + 0.1 * vinScore);

  // 2. price vs market
  let mkt;
  if (fv?.mid && l.price) mkt = lerp(l.price / fv.mid, [[0.9, 1], [0.95, 1], [1, 0.75], [1.05, 0.45], [1.1, 0.15]]);
  else { mkt = 0.5; unknowns.push('fair value'); }
  const p = l.price;
  const band = !p ? 0.5 : p <= s.price.ideal_max ? 1 : p <= s.price.max ? lerp(p, [[s.price.ideal_max, 1], [s.price.max, 0.5]]) : 0.15;
  const price = W.price_vs_market * (0.7 * mkt + 0.3 * band);

  // 3. mechanical & maintenance
  const recordsVerified = l.reportFacts?.serviceRecords > 0;
  const records = recordsVerified ? 1 : sig.quality.some((q) => /dealer|records|history/i.test(q)) ? 0.7 : (unknowns.push('maintenance records'), 0.4);
  const warnings = ai.warningLights === false ? 1 : ai.warningLights === true ? 0 : 0.5;
  const mods = ai.perfMods?.length ? 0 : sig.soundOnlyExhaust ? 0.6 : sig.cosmetic || ai.cosmeticMods?.length ? 0.9 : ai.analyzed ? 1 : 0.7;
  const track = ai.trackUse === true || /\btrack\b/i.test(sig.yellow.join(' ')) ? 0.2 : ai.trackUse === false ? 1 : 0.7;
  const mech = W.mechanical_maintenance * (0.35 * records + 0.15 * warnings + 0.2 * mods + 0.1 * track + 0.2 * warrantyPoints(l));

  // 4. mileage & ownership
  const m = l.miles;
  const milesS = m == null ? (unknowns.push('mileage'), 0.4) : lerp(m, [[0, 1], [10000, 0.9], [20000, 0.75], [30000, 0.55], [40000, 0.35], [50000, 0.15]]);
  const owners = l.reportFacts?.owners ?? l.ownersClaim;
  const ownS = owners == null ? 0.5 : owners <= 1 ? s.preferences.owners.one : owners === 2 ? s.preferences.owners.two : s.preferences.owners.three_plus;
  const mo = W.mileage_ownership * (0.65 * milesS + 0.35 * ownS);

  // 5. options, trim, colors
  const P = s.preferences;
  const ov = (k) => (opts[k].value === true ? 1 : opts[k].value === false ? 0 : 0.5);
  if (opts.Z51.truth === T.U) unknowns.push('Z51');
  let op = (l.trim ? P.trims[l.trim] ?? 0 : 1) + P.options.Z51 * ov('Z51') + P.options.MagRide * ov('MagRide') + P.options.FrontLift * ov('FrontLift') + P.options.PerfExhaust * ov('PerfExhaust')
    + (opts.Seats.value ? P.seats[opts.Seats.value] ?? 0 : 0.4);
  const maxOp = Math.max(...Object.values(P.trims)) + Object.values(P.options).reduce((a, b) => a + b, 0) + Math.max(...Object.values(P.seats));
  op = (op / maxOp) * W.options_trim_colors;
  if (l.body === 'convertible') op -= P.convertible_penalty;
  if (l.extColor && !P.exterior_preferred.includes(l.extColor)) op -= P.color_penalty;
  if (l.intColor && !P.interior_preferred.includes(l.intColor)) op -= P.color_penalty;
  op = Math.max(0, Math.min(W.options_trim_colors, op));

  // 6. seller & distance
  const st = l.sellerType || guessSellerType(l);
  const sellerS = { franchise: 1, online: 0.8, independent: 0.65, private: sig.quality.length >= 2 ? 0.75 : 0.55 }[st] ?? 0.5;
  const distS = distance == null ? 0.5 : lerp(distance, [[s.distance.preferred_miles, 1], [s.hard.max_distance_miles, 0]]);
  const sd = W.seller_distance * (0.5 * sellerS + 0.5 * distS);

  const ruleScore = Math.round(hist + price + mech + mo + op + sd);
  const keyUnknowns = new Set(unknowns).size;
  const confidence = keyUnknowns <= 2 ? 'High' : keyUnknowns <= 5 ? 'Medium' : 'Low';
  const scam = scamRisk(l, { s, fv, photoDupes: ctx.dupes });
  const redFlags = [...(h.serious || [])];
  const text2 = text;
  if ((l.flags || []).includes('odometer_decrease') && !redFlags.some((x) => /odometer/i.test(x))) redFlags.push('Odometer inconsistency');
  for (const pm of ai.perfMods || []) redFlags.push(`Engine/powertrain mod seen: ${pm}`);
  if (ai.structuralDamage) redFlags.push(`Possible structural/flood damage: ${ai.structuralDamage}`);
  const yellowFlags = [...sig.yellow.map((y) => `Listing says "${y}"`), ...(h.mismatches || []), ...(ai.yellowFlags || [])];
  if ((l.flags || []).includes('relisted')) yellowFlags.push('Relisted (seen before and disappeared)');
  if ((l.flags || []).includes('seller_changed')) yellowFlags.push('Same car, different seller (possible flip)');
  if (sig.soundOnlyExhaust) yellowFlags.push('Aftermarket sound-only exhaust (no tune claimed)');
  for (const f of dealerFeeFlags(text2, s)) yellowFlags.push(`Dealer add-on/fee: ${f.what}${f.amount ? ' $' + f.amount : ''}`);
  if (l.body === 'convertible') yellowFlags.push('Convertible (you prefer coupe)');
  const fvFarBelow = !!(fv?.mid && l.price && l.price < fv.mid * (1 - s.price.far_below_market_pct / 100));
  return { ruleScore, fvFarBelow, breakdown: { history: +hist.toFixed(1), price: +price.toFixed(1), mechanical: +mech.toFixed(1), mileage: +mo.toFixed(1), options: +op.toFixed(1), seller: +sd.toFixed(1) }, confidence, unknowns: [...new Set(unknowns)], scam, redFlags, yellowFlags, sellerType: st };
}

export function guessSellerType(l) {
  const sites = (l.links || []).map((k) => k.site);
  if (sites.includes('carmax') || sites.includes('carvana')) return 'online';
  if (sites.some((x) => ['facebook', 'craigslist', 'corvetteforum', 'instagram'].includes(x))) return 'private';
  if (/\b(chevrolet|chevy|gm|buick|gmc|cadillac)\b/i.test(l.sellerName || '')) return 'franchise';
  if (l.sellerName) return /motors|auto|cars|sales/i.test(l.sellerName) ? 'independent' : 'independent';
  return null;
}

/** Final class from score + AI adjustment + flags. */
export function classify(ev, l, s, aiAdjust = 0) {
  const score = Math.max(0, Math.min(100, ev.ruleScore + Math.max(-s.classes.ai_max_adjust, Math.min(s.classes.ai_max_adjust, aiAdjust || 0))));
  const C = s.classes;
  let cls;
  if (ev.redFlags.length || ev.scam.level === 'High') cls = 'Reject';
  else if (score >= C.exceptional && ev.confidence === 'High') cls = 'Exceptional';
  else if (score >= C.strong) cls = 'Strong';
  else if (score >= C.watchlist) cls = 'Watchlist';
  else cls = 'Reject';
  const notes = [];
  if (!l.vin && (cls === 'Exceptional' || cls === 'Strong')) { cls = 'Watchlist'; notes.push('Capped at Watchlist until the VIN is known'); }
  if (l.price && l.price > s.price.max && cls !== 'Reject') {
    if (cls === 'Exceptional') notes.push(`NEEDS YOUR APPROVAL: over budget by $${(l.price - s.price.max).toLocaleString()}`);
    else { cls = 'Reject'; notes.push(`Over $${s.price.max.toLocaleString()} and not exceptional`); }
  }
  if (l.variant && l.variant !== 'Stingray' && cls !== 'Reject') {
    // Non-Stingray C8 at this price: alert only if it passes EVERYTHING.
    if (ev.scam.level !== 'Low' || ev.confidence !== 'High' || !l.vinValid || ev.yellowFlags.length) { cls = 'Reject'; notes.push(`${l.variant} under budget did not pass every check (likely scam/damage/data error)`); }
    else notes.push('Unusual: verify very carefully (non-Stingray C8 at this price)');
  }
  if (ev.fvFarBelow && cls !== 'Reject' && !(l.history?.checks?.decode?.truth === 'verified')) { cls = 'Watchlist'; notes.push('Far below market: held until the VIN/history checks pass'); }
  return { score, cls, notes };
}
