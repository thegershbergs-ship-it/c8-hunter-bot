// Hard filters, red-flag text rules, finance, transport. All thresholds come from settings.yaml.

const TITLE_BRANDS = /\b(salvage|rebuilt|reconstructed|flood(ed)?[- ]title|flood damage|fire damage|hail damage|lemon|buy ?back|manufacturer buyback|theft recover(y|ed)|recovered theft|branded title|title issues?|bill of sale only|no title|missing title|out[- ]of[- ](country|state title issue)|canadian title|mexican title|export only|parts only|total loss)\b/i;
const PERF_MODS = /\b(tune[d]?|tuning|hp tuners|flash(ed)? (ecu|pcm|tcm)|ecu tune|pcm tune|tcm tune|trans(mission)? tune|supercharg(ed|er)|procharg|whipple|turbo(charged|s)?|twin[- ]turbo|cold air intake|aftermarket intake|\bcai\b|headers?|long ?tubes?|cam(shaft)? (swap|upgrade)|cammed|cat[- ]?delete|catless|decat|test pipes?|straight pipes?|e85|stage [1-3]|nitrous|built motor|forged internals)\b/i;
const STRUCTURAL = /\b(frame damage|structural damage|unibody damage|airbags? (deployed|deployment)|deployed airbags?|flood|water damage|submerged)\b/i;
const NEG = /\b(no|not|never|non|zero|free of|without|w\/o|clean of)\b[^.;!]{0,25}$/i;

/** Find a pattern match that is not negated nearby ("no tune", "never flooded"). */
export function positiveMention(text, re) {
  const t = String(text || '');
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 40), m.index);
    if (!NEG.test(before)) return m[0];
  }
  return null;
}

export function textRedFlags(text) {
  const flags = [];
  const tb = positiveMention(text, TITLE_BRANDS); if (tb) flags.push({ code: 'branded_title', serious: true, msg: `Title problem mentioned: "${tb}"` });
  const pm = positiveMention(text, PERF_MODS); if (pm) flags.push({ code: 'perf_mod', serious: true, msg: `Engine/powertrain modification mentioned: "${pm}"` });
  const st = positiveMention(text, STRUCTURAL); if (st) flags.push({ code: 'structural', serious: true, msg: `Damage mentioned: "${st}"` });
  return flags;
}

const YELLOW_PHRASES = [/\bas[- ]is\b/i, /\bneeds tlc\b/i, /\bminor issue/i, /\bjust needs\b/i, /\bselling for (a )?(friend|relative|family|my (dad|father|mom|brother|uncle))\b/i,
  /\btrack (day )?car\b|\btracked\b|\bhpde\b/i, /\blight damage\b|\bminor damage\b/i, /\bcheck engine\b/i, /\bservice transmission\b/i];
const QUALITY_PHRASES = [/\bone owner\b|\b1[- ]owner\b/i, /\bdealer (serviced|maintained)\b/i, /\ball (service )?records\b|\bfull service history\b/i, /\bgarage[- ]kept\b/i,
  /\bppf\b|\bpaint protection film\b|\bxpel\b/i, /\bwarranty remaining\b|\bremaining (factory )?warranty\b/i, /\boriginal (window )?sticker\b/i];
const COSMETIC_MODS = /\b(wrap(ped)?|ppf|tint|aftermarket wheels|carbon (fiber )?(trim|spoiler|splitter)|cat[- ]?back|axle[- ]?back|borla|corsa|akrapovic)\b/i;
export function textSignals(text) {
  const t = String(text || '');
  return {
    yellow: YELLOW_PHRASES.map((r) => positiveMention(t, r)).filter(Boolean),
    quality: QUALITY_PHRASES.map((r) => t.match(r)?.[0]).filter(Boolean),
    cosmetic: positiveMention(t, COSMETIC_MODS),
    soundOnlyExhaust: /\b(cat[- ]?back|axle[- ]?back)\b/i.test(t) && !positiveMention(t, PERF_MODS),
  };
}

/**
 * Hard filters. Unknown values pass (they lower confidence instead).
 * ctx.distance = estimated driving miles or null. Returns {pass, reasons[], overBudget, unusualVariant}
 */
export function hardFilter(l, s, ctx = {}) {
  const r = [];
  if (l.model && !/corvette/i.test(l.model)) r.push('not a Corvette');
  if (l.year && l.year < s.hard.min_model_year) r.push(`not a C8 (${l.year})`);
  if (l.price && l.price > s.price.exception_max) r.push(`price ${l.price} over ${s.price.exception_max}`);
  if (l.miles != null && l.miles >= s.hard.max_miles) r.push(`mileage ${l.miles} >= ${s.hard.max_miles}`);
  if (ctx.distance != null && ctx.distance > s.hard.max_distance_miles) r.push(`about ${Math.round(ctx.distance)} mi away (> ${s.hard.max_distance_miles})`);
  const text = [l.title, l.description, l.pageText].filter(Boolean).join(' ');
  for (const f of textRedFlags(text)) r.push(f.msg);
  if (l.vinDecode?.transmissionOk === false) r.push('VIN decode says not the 8-speed DCT (data problem)');
  return {
    pass: r.length === 0, reasons: r,
    overBudget: l.price && l.price > s.price.max ? l.price - s.price.max : 0,
    unusualVariant: l.variant && l.variant !== 'Stingray' && l.variant !== null,
  };
}

/** Standard amortized loan payment. */
export function monthlyPayment(price, { apr_pct, down_payment, months }) {
  const P = Math.max(0, price - down_payment);
  const r = apr_pct / 100 / 12;
  if (P === 0) return 0;
  if (r === 0) return P / months;
  return (P * r) / (1 - (1 + r) ** -months);
}

export function transportEstimate(dist, t) {
  if (dist == null) return null;
  const long = dist > t.long_threshold_miles;
  const open = Math.max(t.minimum, dist * (long ? t.open_per_mile_long : t.open_per_mile_short));
  const enclosed = Math.max(t.minimum, dist * (long ? t.enclosed_per_mile_long : t.enclosed_per_mile_short));
  return { open, enclosed };
}

/** Out-the-door hints from listing text (mandatory add-ons / market adjustments). */
export function dealerFeeFlags(text, s) {
  const t = String(text || '');
  const out = [];
  const adj = t.match(/\b(market adjustment|additional dealer markup|adm|dealer add[- ]?ons?|protection package|appearance package|nitrogen|etch(ing)?|theft deterrent|mandatory (add[- ]?ons?|accessories))\b[^$]{0,40}(\$\s?\d[\d,]*)?/i);
  if (adj) out.push({ what: adj[1], amount: adj[3] ? Number(adj[3].replace(/[^0-9]/g, '')) : null });
  const doc = t.match(/\bdoc(umentation)? fee[^$]{0,20}\$\s?(\d[\d,]*)/i);
  if (doc) { const n = Number(doc[2].replace(/,/g, '')); if (n > s.price.normal_doc_fee_max) out.push({ what: 'high doc fee', amount: n }); }
  return out;
}
