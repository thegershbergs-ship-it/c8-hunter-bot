// Deep-dive report, inspection checklist, seller message draft, weekly digest.
import { esc } from './telegram.js';
import { money, miles, daysBetween, fmtEastern } from './util.js';
import { carTitle, shortLine, carNum } from './alerts.js';
import { marketSnapshot } from './market.js';
import { aiText, listingPayload } from './ai.js';

export function inspectionChecklist(l) {
  const y = l.year || 0, m = l.miles || 0;
  const items = [
    'Independent pre-purchase inspection (PPI) by a shop that knows mid-engine C8s. Do this before any deposit.',
    'Full scan of all modules (engine, TCM/transmission, ABS, airbag) for stored and pending codes.',
    'DCT: look for fluid leaks at the pan gasket and input-shaft seal; check whether the DCT fluid/filter service has been done (first service is commonly cited around 22,500 mi / 3 yr).',
    'Test drive: cold start, smooth low-speed creep and parking-lot maneuvers (shudder?), no "Service Transmission" message, clean shifts in all modes.',
    'Front splitter and nose underside: scrapes, cracks, missing fasteners. Test front lift if equipped.',
    'Wheels and tires: curb rash, tire date codes, tread depth (rears wear fast; a set costs ~$1,500–2,000).',
    'Panel paint/gap check for respray or overspray (bring a paint meter if possible); look under PPF/wrap edges.',
    'Frunk: latch and interior release work; no water or musty smell. Rear trunk dry.',
    'Engine bay under the rear hatch: no aftermarket intake/tuner signs, no oil residue, covers present.',
    'Interior: seat bolster wear matches mileage; no water stains or rust on seat rails (flood sign).',
    'Brakes: rotor lip and pad thickness (track use shows here).',
    'Glovebox/door options label: confirm Z51 / FE4 (Mag Ride) / E60 (front lift) codes in person.',
    'Number of keys (2 fobs), owner manual, original window sticker if available.',
    `Open recalls by VIN: ask a Chevy dealer for a printout${y ? ` (${y} recalls listed in the alert)` : ''}.`,
  ];
  if (y && y <= 2021) items.push('2020–21 build: ask specifically about any transmission repairs or TCM updates (early-build DCT complaints were most common).');
  if (y === 2021 || y === 2022) items.push('Half-shaft recall 22V091000 (missing bearings): confirm it was completed.');
  if (y === 2020) items.push('2020 frunk-latch and seat-belt recalls (20V461, 20V489, 20V581) and brake sensor (20V588): confirm completed.');
  if (l.body === 'convertible') items.push('Convertible: operate the roof 3×, check seals and the tonneau for leaks/noise.');
  else items.push('Coupe: remove/store the roof panel; check latches and the weatherstrip for creaks/leaks.');
  if (m > 30000) items.push('Higher mileage: ask about brake fluid, spark plugs and DCT service records specifically.');
  if (l.sellerType === 'private') items.push('Private sale: meet at a bank or the inspection shop, verify the title in person matches the seller ID and VIN, and never wire money or use an "escrow" service the seller picked.');
  return items;
}

export function sellerDraft(l) {
  if (l.aiFindings?.sellerMessage) return l.aiFindings.sellerMessage;
  const asks = [];
  if (!l.vin) asks.push('the VIN');
  asks.push('the service records (especially any transmission/DCT fluid service)');
  if (!l.historyReportUrl) asks.push('a CARFAX or AutoCheck report');
  asks.push('how many keys come with it', 'a short cold-start video', 'the tire age/date codes');
  if ((l.year || 0) >= 2022) asks.push('whether factory warranty remains');
  asks.push('the reason for selling', 'whether I can arrange an independent pre-purchase inspection at a shop near you');
  const t = `${l.year || ''} Corvette ${l.trim || ''}`.replace(/\s+/g, ' ').trim();
  return `Hi${l.sellerName ? ' ' + l.sellerName : ''}, I'm interested in your ${t}${l.price ? ` listed at ${money(l.price)}` : ''}. Is it still available? Before setting up a visit, could you please share ${asks.slice(0, -1).join(', ')}, and ${asks.at(-1)}? I'm a serious buyer and can move quickly if everything checks out. Thanks!`;
}

export async function deepDive(db, l, res, ctx) {
  const { fv, nb, distance } = res;
  const out = [`<b>🔍 Full report: #${carNum(db, l)} ${esc(carTitle(l))}</b>`, `${money(l.price)} · ${miles(l.miles)} · first seen ${fmtEastern(l.firstSeen)}`];
  if (l.eval) out.push(`Score ${l.eval.score}/100 (${l.eval.cls}, ${l.eval.confidence}) · rule breakdown: ${Object.entries(l.eval.breakdown || {}).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const ai = l.aiFindings;
  if (ai) {
    out.push('<b>Photo & description analysis</b>');
    for (const [k, v] of Object.entries(ai.options || {})) out.push(` ${k}: ${v.value ?? '?'} (${v.truth}${v.evidence ? ': ' + esc(v.evidence) : ''})`);
    if (ai.odometerPhotoMiles != null) out.push(` Odometer in photo: ${ai.odometerPhotoMiles.toLocaleString()} mi (listed ${l.miles?.toLocaleString()})`);
    out.push(` Warning lights: ${ai.warningLights == null ? 'not visible' : ai.warningLights ? 'YES' : 'none seen'} · Track use signs: ${ai.trackUse == null ? '?' : ai.trackUse ? 'yes' : 'none'} · Photo quality: ${esc(ai.photoQuality || '?')}`);
    for (const f of [...(ai.cosmeticFlaws || []), ...(ai.yellowFlags || [])]) out.push(` • ${esc(f)}`);
  }
  out.push('<b>Comparables</b>');
  if (fv?.comps?.length) for (const c of fv.comps) out.push(` ${c.url ? `<a href="${esc(c.url)}">${esc(c.title)}</a>` : esc(c.title)} · ${miles(c.miles)} · ${money(c.price)} → adj ${money(c.adjusted)} (${c.kind})`);
  else out.push(' None yet in the database.');
  if (fv) out.push(`<i>${esc(fv.note)}</i>`);
  if (nb) {
    out.push('<b>Negotiation brief</b>', ` Days on market: ${nb.dom} (${esc(nb.domSource)})`, ` Opening ${money(nb.opening)} · target ${money(nb.target)} · walk-away ${money(nb.walk)}`, ` ${esc(nb.reasoning)}`);
    for (const p of nb.points) out.push(` • ${esc(p)}`);
    for (const p of ai?.negotiationPoints || []) out.push(` • ${esc(p)} (AI)`);
    if (nb.noEvidence) out.push(` ${esc(nb.noEvidence)}`);
    for (const t of nb.dealerTips) out.push(` ✓ ${esc(t)}`);
    if (nb.transport) out.push(` Transport (rough): ${money(nb.transport.open)} open / ${money(nb.transport.enclosed)} enclosed`);
  }
  out.push('<b>Inspection checklist</b>', ...inspectionChecklist(l).map((x) => ` ☐ ${esc(x)}`));
  out.push('<b>Questions for the seller</b>', esc(sellerDraft(l)));
  // optional AI narrative (counts toward the daily cap)
  const r = await aiText(db, ctx.s, `You are a C8 Corvette buying analyst. In under 180 words, give a frank, evidence-based summary of this listing for a private buyer: biggest strengths, biggest risks, and what to verify first. Never invent facts; say "unknown" when data is missing. Data:\n${JSON.stringify({ ...listingPayload(l), fairValue: fv && { low: fv.low, high: fv.high, enough: fv.enough }, eval: l.eval && { score: l.eval.score, cls: l.eval.cls, red: l.eval.redFlags, yellow: l.eval.yellowFlags, unknowns: l.eval.unknowns } })}`, { notify: ctx.notifyOnce });
  if (r.text) out.splice(3, 0, `<b>Analyst summary</b> <i>(${esc(r.tier)})</i>\n${esc(r.text.trim())}`);
  out.push('<i>Get an independent pre-purchase inspection before any deposit.</i>');
  return out.join('\n');
}

export async function weeklyDigest(db, ctx, { top, watch, lastTop }) {
  const s = ctx.s;
  const snap = marketSnapshot(db, s);
  const lines = [`${s.alerts.test_mode ? '[TEST] ' : ''}<b>📅 Weekly C8 digest</b>`];
  lines.push(`<b>Market</b>: ${snap.total} C8 Stingrays seen in the last 30 days, ${snap.underMax} at or under ${money(s.price.max)}.${snap.trend != null ? ` 30-day median change: ${snap.trend >= 0 ? '+' : ''}${money(snap.trend)}.` : ''}`);
  const yrs = Object.entries(snap.yearsUnderBudget).sort();
  lines.push(`Model years realistically in budget: ${yrs.length ? yrs.map(([y, n]) => `${y} (${n})`).join(', ') : 'not enough data yet'}`);
  for (const r of snap.rows.slice(0, 12)) lines.push(` ${esc(r.k)}: median ${money(r.median)} (${r.n})`);
  lines.push('<b>Top 5 now</b>', ...(top.length ? top.map((x) => ' ' + shortLine(db, x.l, x)) : [' none yet']));
  if (lastTop?.length) {
    lines.push('<b>Last week\'s top 5</b>');
    for (const id of lastTop) { const l = db.get(id); if (l) lines.push(` #${l.num} ${esc(carTitle(l))}: ${l.status === 'active' ? `still listed at ${money(l.price)}` : l.status.replace('_', ' ')}`); }
  }
  lines.push('<b>Your watchlist</b>', ...(watch.length ? watch.map((x) => ' ' + shortLine(db, x.l, x) + (x.l.status !== 'active' ? ` (${x.l.status})` : '')) : [' empty']));
  lines.push('<b>Sources</b>');
  for (const [n, x] of Object.entries(db.d.sources)) lines.push(` ${x.status === 'OK' ? '🟢' : x.status === 'DEGRADED' ? '🟡' : '🔴'} ${esc(n)} (last OK ${fmtEastern(x.lastSuccess)})`);
  const week = Object.entries(db.d.usage).filter(([d]) => daysBetween(d) <= 7);
  const sum = (k) => week.reduce((a, [, u]) => a + (u[k] || 0), 0);
  lines.push(`<b>Free-tier usage (7 days)</b>: Claude ${sum('claude')} (cap ${s.ai.claude_daily_cap}/day) · Gemini ${sum('gemini')} (cap ${s.ai.gemini_daily_cap}/day) · emails ${sum('emails')} · pages ${sum('pages')} · Telegram msgs ${sum('telegramSent')}. GitHub Actions: free (public repo).`);
  lines.push('<b>Manual checks this week</b>: Facebook Marketplace (Tue & Fri evenings): paste any interesting link here. Also glance at Corvette Forum C8 classifieds and Bring a Trailer results. Links in USER_GUIDE.md.');
  const sug = weightSuggestions(db, s); if (sug) lines.push(`<b>Tuning suggestion</b>: ${esc(sug)} (reply /set … to apply; nothing changes automatically)`);
  const r = await aiText(db, s, `In 3 short sentences, summarize this week's used C8 Corvette Stingray market for a buyer with a ${money(s.price.max)} ceiling. Use only these numbers, no outside facts: ${JSON.stringify(snap)}`, { notify: ctx.notifyOnce });
  if (r.text) lines.splice(1, 0, `<i>${esc(r.text.trim())}</i>`);
  return lines.join('\n');
}

/** After >= N ratings, suggest (never apply) weight tweaks from Watch/Reject behaviour. */
export function weightSuggestions(db, s) {
  const acts = db.d.actions.filter((a) => a.type === 'watch' || a.type === 'reject');
  if (acts.length < s.learning.min_ratings_before_suggestions) return null;
  const reasons = {};
  for (const a of db.d.actions.filter((x) => x.type === 'reject_reason')) reasons[a.value] = (reasons[a.value] || 0) + 1;
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 4) return null;
  const map = { price: 'price_vs_market up by 3 (you reject on price often)', color: 'raise color_penalty to 2', miles: 'mileage_ownership up by 3', distance: 'seller_distance up by 3 or lower radius', seller: 'seller_distance up by 2' };
  return map[top[0]] ? `You rejected ${top[1]} cars for "${top[0]}". Consider ${map[top[0]]}.` : null;
}
