// Formatting of car alerts, reports, and digests for Telegram (HTML).
import { esc } from './telegram.js';
import { money, miles, daysBetween, fmtEastern } from './util.js';
import { monthlyPayment } from './rules.js';
import { positionInRange } from './market.js';

const TL = { verified: '✅ Verified', claim: '🗣 Seller claim', unknown: '❔ Unknown' };
const truth = (t) => TL[t] || TL.unknown;
const ICON = { Exceptional: '🏆', Strong: '🔥', Watchlist: '👀', Reject: '⛔' };

export function carNum(db, l) {
  if (!l.num) { db.d.meta.nextNum = (db.d.meta.nextNum || 0) + 1; l.num = db.d.meta.nextNum; }
  return l.num;
}
export function carTitle(l) {
  const opt = l.optionsResolved?.Z51?.value === true ? ' Z51' : '';
  return `${l.year || '?'} ${l.variant && l.variant !== 'Stingray' ? l.variant : 'Stingray'} ${l.trim || ''} ${l.body ? l.body[0].toUpperCase() + l.body.slice(1) : ''}${opt}`.replace(/\s+/g, ' ').trim();
}

export function nicbLink() { return 'https://www.nicb.org/vincheck'; }
export function recallLink() { return 'https://www.chevrolet.com/ownercenter/recalls'; }

export function buttons(l) {
  return [
    [{ text: '⭐ Watch', callback_data: `w:${l.id}` }, { text: '🚫 Reject', callback_data: `r:${l.id}` }, { text: '🔍 Deep-dive', callback_data: `d:${l.id}` }],
    [{ text: '✉️ Draft seller msg', callback_data: `m:${l.id}` }, { text: '🧰 Inspection list', callback_data: `c:${l.id}` }],
  ];
}
export function rejectReasonButtons(l) {
  const r = ['price', 'color', 'miles', 'distance', 'seller', 'gut'];
  return [r.slice(0, 3).map((x) => ({ text: x, callback_data: `rr:${l.id}:${x}` })), r.slice(3).map((x) => ({ text: x, callback_data: `rr:${l.id}:${x}` }))];
}

/** Full car alert (sections 1-12 of the spec; photos sent separately). */
export function formatCarAlert(db, l, ctx) {
  const { s, priv, distance, fv, nb, testMode, changeNote } = ctx;
  const e = l.eval;
  const lines = [];
  const pre = testMode ? '[TEST] ' : '';
  lines.push(`${pre}${ICON[e.cls] || ''} <b>${e.cls.toUpperCase()} · ${e.score}/100 · ${e.confidence} confidence</b> (#${carNum(db, l)})`);
  lines.push(`<b>${esc(carTitle(l))} — ${money(l.price)}</b>`);
  for (const n of e.notes || []) lines.push(`⚠️ <b>${esc(n)}</b>`);
  if (changeNote) lines.push(`🔄 <i>What changed: ${esc(changeNote)}</i>`);
  // 2
  const days = Math.round(daysBetween(l.firstSeen));
  lines.push(`${miles(l.miles)} · ${esc(l.extColorName || l.extColor || 'color ?')} / ${esc(l.intColorName || l.intColor || 'interior ?')}`);
  lines.push(`📍 ${esc([l.city, l.state].filter(Boolean).join(', ') || 'location ?')}${distance != null ? ` · ~${Math.round(distance)} mi from home` : ''} · ${esc(l.sellerName || 'seller ?')} (${esc(e.sellerType || 'type ?')}) · listed ${l.marketSignals?.daysOnMarket ?? days}d`);
  // 3
  if (l.price) lines.push(`💵 Est. payment ≈ <b>${money(monthlyPayment(l.price, priv))}/mo</b> (${priv.apr_pct}% · ${money(priv.down_payment)} down · ${priv.months} mo${priv.financing_is_placeholder ? ' · PLACEHOLDER rates' : ''}; estimate)`);
  // 4
  if (fv) {
    const pos = positionInRange(l.price, fv);
    lines.push(fv.low ? `📊 Fair value ${money(fv.low)}–${money(fv.high)}${pos != null ? ` · price at ${pos}% of range` : ''}${fv.enough ? '' : ' · <i>' + esc(fv.note) + '</i>'}` : `📊 ${esc(fv.note)}`);
    if (fv.siteEstimate) lines.push(`   Site estimate: ${money(fv.siteEstimate.value)} (${esc(fv.siteEstimate.source)})`);
  }
  if (nb?.drops?.length) lines.push(`   Price drops: ${nb.drops.map((d) => `${d.at} ${money(d.from)}→${money(d.to)}`).join(', ')}`);
  // 5 options
  const o = l.optionsResolved || {};
  const optLine = [['Z51', 'Z51'], ['MagRide', 'Mag Ride'], ['FrontLift', 'Front lift'], ['PerfExhaust', 'Perf exhaust'], ['Seats', 'Seats']]
    .map(([k, n]) => { const x = o[k] || { truth: 'unknown' }; const v = x.value === true ? 'yes' : x.value === false ? 'no' : x.value || '?'; return `${n}: ${v} ${x.truth === 'verified' ? '✅' : x.truth === 'claim' ? '🗣' : '❔'}`; });
  lines.push(`⚙️ ${optLine.join(' · ')}`);
  // 6 history
  const c = l.history?.checks || {};
  const hl = (f) => (f ? `${f.truth === 'verified' ? '✅' : f.truth === 'claim' ? '🗣' : '❔'} ${esc(f.value)}` : '❔ not run');
  lines.push('<b>History</b>');
  for (const k of ['vin', 'decode', 'title', 'accidents', 'owners', 'odometer', 'report', 'warranty']) if (c[k]) lines.push(` ${hl(c[k])}`);
  if (l.history?.recalls?.length) lines.push(` 🔧 Recalls (${l.year}): ${l.history.recalls.slice(0, 4).map((r) => `${r.id} ${esc(r.summary)}`).join('; ')}. Confirm done by VIN.`);
  // 7 mods
  const ai = l.aiFindings || {};
  if (ai.perfMods?.length || ai.cosmeticMods?.length) lines.push(`🔩 Mods: ${esc([...(ai.perfMods || []), ...(ai.cosmeticMods || [])].join(', '))}`);
  // 8 scam & flags
  lines.push(`🛡 Scam risk: <b>${e.scam.level}</b>${e.scam.reasons.length ? ' — ' + esc(e.scam.reasons.join('; ')) : ''}`);
  for (const f of e.redFlags) lines.push(`🟥 ${esc(f)}`);
  for (const f of e.yellowFlags.slice(0, 6)) lines.push(`🟨 ${esc(f)}`);
  // 9 missing
  const missing = [...new Set([...(e.unknowns || []), ...(ai.missingInfo || [])])].slice(0, 8);
  if (missing.length) lines.push(`❓ Missing: ${esc(missing.join(', '))}`);
  // 10 negotiation
  if (nb && (e.cls === 'Strong' || e.cls === 'Exceptional')) lines.push(`🤝 Open ${money(nb.opening)} · target ${money(nb.target)} · walk-away ${money(nb.walk)}${nb.noEvidence ? ' · ' + esc(nb.noEvidence) : ''}`);
  // 11 recommendation
  lines.push(`👉 <b>${esc(e.recommendation || defaultRec(e))}</b>`);
  if (e.aiReason) lines.push(`<i>AI (${esc(e.tier)}): ${e.aiAdjust >= 0 ? '+' : ''}${e.aiAdjust} — ${esc(e.aiReason)}</i>`);
  else if (e.tier === 'rules') lines.push('<i>AI review pending</i>');
  // 12 links
  const links = (l.links || []).map((k) => `<a href="${esc(k.url)}">${esc(k.site)}</a>`);
  if (l.historyReportUrl) links.push(`<a href="${esc(l.historyReportUrl)}">free history report</a>`);
  links.push(`<a href="${nicbLink()}">NICB check</a>`, `<a href="${recallLink()}">Chevy recall lookup</a>`);
  lines.push(`🔗 ${links.join(' · ')}${l.vin ? ` · VIN <code>${esc(l.vin)}</code>` : ''}`);
  if (fv?.comps?.length) lines.push(`Comps: ${fv.comps.slice(0, 3).map((x, i) => (x.url ? `<a href="${esc(x.url)}">${i + 1}</a>` : `${i + 1}`) + ` ${money(x.price)}`).join(' · ')} (more in Deep-dive)`);
  lines.push('<i>Always get an independent pre-purchase inspection by a mid-engine Corvette specialist before any deposit.</i>');
  return lines.join('\n');
}

export function defaultRec(e) {
  if (e.cls === 'Exceptional') return 'Top candidate. Get the VIN-specific records and book an inspection now.';
  if (e.cls === 'Strong') return 'Worth pursuing. Clear up the unknowns, then inspect.';
  if (e.cls === 'Watchlist') return 'Keep an eye on it; not compelling yet.';
  return 'Pass.';
}

/** Short alert for a car known only from an alert email (no page data yet). */
export function formatEmailMatch(db, l, ctx) {
  const { distance, priv, testMode } = ctx;
  const lines = [`${testMode ? '[TEST] ' : ''}🆕 <b>New match (from ${esc(l.sources?.[0]?.replace('email:', '') || 'alert email')})</b> (#${carNum(db, l)})`,
    `<b>${esc(carTitle(l))} — ${money(l.price)}</b>`, `${miles(l.miles)} · ${esc(l.extColorName || '')} · ${esc([l.city, l.state].filter(Boolean).join(', '))}${distance != null ? ` · ~${Math.round(distance)} mi` : ''}`];
  if (l.price) lines.push(`💵 ≈ ${money(monthlyPayment(l.price, priv))}/mo (estimate)`);
  lines.push(`Pre-score ${l.eval?.ruleScore ?? '?'} from email data only. VIN, history and photos not checked yet.`);
  lines.push('Tap <b>Full check</b> and the bot opens this one listing page on its next run (or asks you to paste it if the site blocks bots).');
  lines.push((l.links || []).map((k) => `<a href="${esc(k.url)}">${esc(k.site)}</a>`).join(' · '));
  return lines.join('\n');
}
export function emailMatchButtons(l) {
  return [[{ text: '🔎 Full check', callback_data: `f:${l.id}` }, { text: '⭐ Watch', callback_data: `w:${l.id}` }, { text: '🚫 Reject', callback_data: `r:${l.id}` }]];
}

export function shortLine(db, l, ctx = {}) {
  const e = l.eval || {};
  const d = ctx.distance != null ? ` · ${Math.round(ctx.distance)}mi` : '';
  return `#${carNum(db, l)} ${ICON[e.cls] || '·'} ${esc(carTitle(l))} · ${money(l.price)} · ${miles(l.miles)}${d} · ${e.score ?? e.ruleScore ?? '?'}/100 ${e.cls || ''}`;
}

export function formatStatus(db, ctx) {
  const { s, aiTier } = ctx;
  const u = db.usage();
  const lines = ['<b>C8 Hunter status</b>'];
  const lr = db.d.meta.lastRun || {};
  lines.push(`Last quick check: ${fmtEastern(lr.quick)} · last full sweep: ${fmtEastern(lr.sweep)} · last digest: ${fmtEastern(lr.digest)}`);
  lines.push(`Alerts: ${s.alerts.paused ? '⏸ PAUSED' : '▶️ on'}${s.alerts.test_mode ? ' · TEST mode' : ''}`);
  lines.push(`AI tier now: <b>${esc(aiTier)}</b> · Claude ${u.claude}/${s.ai.claude_daily_cap} today · Gemini ${u.gemini}/${s.ai.gemini_daily_cap} · questions ${u.questions}/${s.ai.question_answers_per_day}`);
  lines.push(`Today: ${u.emails} emails read · ${u.pages} pages fetched · ${u.nhtsa} NHTSA calls · ${u.telegramSent} messages sent`);
  lines.push('<b>Sources</b>');
  const src = Object.entries(db.d.sources).sort();
  if (!src.length) lines.push(' (none checked yet)');
  for (const [n, x] of src) lines.push(` ${x.status === 'OK' ? '🟢' : x.status === 'DEGRADED' ? '🟡' : '🔴'} ${esc(n)}: last OK ${fmtEastern(x.lastSuccess)}${x.failCount ? ` · ${x.failCount} fail(s): ${esc((x.lastError || '').slice(0, 80))}` : ''}`);
  lines.push(`Database: ${db.listings.length} cars (${db.active().length} active)`);
  lines.push('<i>Commands are answered at the next scheduled run (up to ~1 hour). GitHub can start runs late.</i>');
  return lines.join('\n');
}

export const HELP = `<b>C8 Hunter commands</b>
/status: health, last run time, AI usage
/top: best 5 cars right now
/watchlist: your watched cars
/car 12: full details for car #12
/market: prices by year/trim, 30-day trend
/settings: your criteria
/set max price 56000: change a setting (also: miles, radius, quiet start 22:30, interest rate 6.9, down payment 15000, loan length 60, ai cap 10, test mode off)
/pause · /resume: stop/start alerts
/search: full sweep on the next run
Paste any listing link (Facebook, Craigslist, dealer, forum) and I'll evaluate it.
Type any question about a car or the market and I'll answer.
<i>I'm not a live chat: I read your messages at each hourly run, so replies take up to about an hour.</i>`;
