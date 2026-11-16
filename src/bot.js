// Telegram command, button, pasted-link and question handling (polled at each run).
import { getUpdates, send, answerCallback, esc } from './telegram.js';
import { HELP, formatStatus, rejectReasonButtons, shortLine, carTitle, formatCarAlert, buttons } from './alerts.js';
import { SETTING_ALIASES, setPublicSetting, setPrivate, setPrivateRaw, settings, privateSettings } from './config.js';
import { currentTier, aiText } from './ai.js';
import { marketSnapshot } from './market.js';
import { upsertObservation, siteOf } from './listing.js';
import { parseText } from './extract.js';
import { money, nowIso, log, warn, daysBetween } from './util.js';
import { distanceFor } from './pipeline.js';

const URL_RE = /https?:\/\/[^\s<>"]+/gi;

/** Fetch and route updates. Only the owner's chat is accepted. Returns work items for this run. */
export async function processUpdates(db, ctx) {
  const updates = await getUpdates((db.d.telegram.offset || 0) + 0);
  if (!updates.length) return;
  let owner = ctx.priv.chat_id ? String(ctx.priv.chat_id) : null;
  for (const u of updates) {
    db.d.telegram.offset = u.update_id + 1;
    const msg = u.message || u.callback_query?.message;
    const chat = String(u.message?.chat?.id ?? u.callback_query?.message?.chat?.id ?? '');
    const fromChat = u.message?.chat || u.callback_query?.message?.chat;
    if (!owner) {
      // First private chat that sends /start binds as owner (setup step 2), stored encrypted.
      // Binding happens ONCE EVER. If the encrypted link is later lost (e.g. bot token rotated), the bot
      // fails closed: it ignores everyone until you set the TELEGRAM_CHAT_ID secret (see TROUBLESHOOTING).
      if (db.d.meta.ownerLinkedOnce) { log('owner link missing; ignoring updates until TELEGRAM_CHAT_ID secret is set'); continue; }
      if (u.message?.chat?.type === 'private' && /^\/start/.test(u.message.text || '')) {
        setPrivateRaw('chat_id', chat); owner = chat; ctx.priv.chat_id = chat;
        db.d.meta.ownerLinkedOnce = new Date().toISOString();
        await send(chat, `✅ Linked to you, ${esc(fromChat.first_name || '')}. I'll only ever talk to this chat.\n\n${HELP}`, { db });
        continue;
      }
      continue;
    }
    if (chat !== owner) { log('ignored update from a non-owner chat'); continue; } // ignore everyone else silently
    try {
      if (u.callback_query) await onButton(db, ctx, u.callback_query);
      else if (msg) await onMessage(db, ctx, u.message);
    } catch (e) { warn('update failed: ' + e.message); await send(owner, `⚠️ Sorry, I couldn't handle that: ${esc(e.message)}`, { db }).catch(() => {}); }
  }
}

function findCar(db, ref) {
  ref = String(ref || '').replace('#', '').trim();
  return db.listings.find((l) => String(l.num) === ref) || db.get(ref) || db.listings.find((l) => l.vin === ref.toUpperCase());
}

async function onButton(db, ctx, q) {
  const [kind, id, extra] = q.data.split(':');
  const l = findCar(db, id);
  const chat = ctx.priv.chat_id;
  if (!l) return answerCallback(q.id, 'That car is no longer in the database');
  const Q = db.d.queue;
  switch (kind) {
    case 'w': l.watch = true; l.recheck = true; db.action('watch', l.id); await answerCallback(q.id, 'Added to watchlist'); await send(chat, `⭐ Watching #${l.num} ${esc(carTitle(l))}. I'll tell you about price drops and status changes.`, { db }); break;
    case 'r': l.userRejected = true; l.watch = false; l.status = l.status === 'active' ? 'rejected' : l.status; db.action('reject', l.id); await answerCallback(q.id, 'Rejected'); await send(chat, `🚫 #${l.num} hidden for good. Optional: why?`, { buttons: rejectReasonButtons(l), db }); break;
    case 'rr': db.action('reject_reason', l.id, extra); await answerCallback(q.id, 'Thanks, noted'); break;
    case 'd': Q.deepDive.includes(l.id) || Q.deepDive.push(l.id); await answerCallback(q.id, 'Deep-dive queued'); break;
    case 'm': Q.draft.includes(l.id) || Q.draft.push(l.id); await answerCallback(q.id, 'Drafting'); break;
    case 'c': Q.checklist.includes(l.id) || Q.checklist.push(l.id); await answerCallback(q.id, 'Checklist coming'); break;
    case 'f': Q.fullCheck.includes(l.id) || Q.fullCheck.push(l.id); await answerCallback(q.id, 'Full check queued'); break;
    default: await answerCallback(q.id, 'Unknown button');
  }
}

async function onMessage(db, ctx, m) {
  const chat = ctx.priv.chat_id;
  const text = (m.text || m.caption || '').trim();
  const s = ctx.s;
  // photos for a pending pasted listing
  if (m.photo?.length) {
    const aw = db.d.telegram.awaiting;
    const l = aw && db.get(aw.id);
    if (l && daysBetween(aw.at) < 1) {
      l.userPhotoIds = [...(l.userPhotoIds || []), m.photo.at(-1).file_id].slice(0, 20);
      aw.dirty = true;
      if (text) { l.pastedText = [l.pastedText, text].filter(Boolean).join('\n'); }
      return;
    }
    if (!text) return send(chat, 'Got a photo. Send me the listing link first, then the photos, so I know which car they belong to.', { db });
  }
  if (!text) return;
  if (text.startsWith('/')) return onCommand(db, ctx, text);
  const urls = text.match(URL_RE);
  if (urls) {
    for (const url of urls) {
      const clean = url.replace(/[).,]+$/, '');
      db.d.queue.links.push({ url: clean, at: nowIso(), note: text.replace(URL_RE, '').trim().slice(0, 2000) });
      db.action('paste_link', null, siteOf(clean));
    }
    return send(chat, `🔗 Got it. I'll evaluate ${urls.length > 1 ? 'these' : 'it'} at the next run (within ~1 hour).`, { db });
  }
  // pasted listing text for the awaiting car?
  const aw = db.d.telegram.awaiting;
  if (aw && daysBetween(aw.at) < 1 && (/\$|\bmiles?\b|\bmi\b|corvette|stingray|vin|owner|z51/i.test(text) || text.length > 200)) {
    const l = db.get(aw.id);
    if (l) { l.pastedText = [l.pastedText, text].filter(Boolean).join('\n'); aw.dirty = true; return; }
  }
  // otherwise: a question
  db.d.queue.questions.push({ q: text.slice(0, 1000), at: nowIso() });
}

async function onCommand(db, ctx, text) {
  const chat = ctx.priv.chat_id;
  const s = ctx.s;
  const [cmd0, ...rest] = text.split(/\s+/);
  const cmd = cmd0.toLowerCase().replace(/@.*/, '');
  const arg = rest.join(' ').trim();
  const top = () => db.active().filter((l) => !l.userRejected && l.eval && !l.eval.filtered && l.eval.cls !== 'Reject').sort((a, b) => (b.eval.score ?? b.eval.ruleScore) - (a.eval.score ?? a.eval.ruleScore));
  switch (cmd) {
    case '/start': case '/help': return send(chat, HELP, { db });
    case '/status': return send(chat, formatStatus(db, { s, aiTier: currentTier(db, s) }), { db });
    case '/top': {
      const t = top().slice(0, 5);
      return send(chat, t.length ? '<b>Top 5 now</b>\n' + t.map((l) => shortLine(db, l, { distance: distanceFor(l, ctx) })).join('\n') + '\nUse /car N for details.' : 'No qualifying cars yet.', { db });
    }
    case '/watchlist': {
      const w = db.listings.filter((l) => l.watch);
      return send(chat, w.length ? '<b>Watchlist</b>\n' + w.map((l) => { const ph = l.priceHistory || []; const ch = ph.length > 1 ? ` (was ${money(ph[0].price)})` : ''; return shortLine(db, l, { distance: distanceFor(l, ctx) }) + ch + (l.status !== 'active' ? ` · ${l.status}` : ''); }).join('\n') : 'Watchlist is empty. Tap ⭐ Watch on any alert.', { db });
    }
    case '/car': {
      const l = findCar(db, arg);
      if (!l) return send(chat, 'Usage: /car 12 (the # number shown in alerts)', { db });
      db.d.queue.deepDive.includes(l.id) || db.d.queue.deepDive.push(l.id);
      return send(chat, `#${l.num} ${esc(carTitle(l))}: ${money(l.price)}, score ${l.eval?.score ?? l.eval?.ruleScore ?? '?'}. The full report follows at the next run.`, { buttons: buttons(l), db });
    }
    case '/settings': {
      const p = privateSettings();
      return send(chat, `<b>Your criteria</b>\nPrice: ideal ${money(s.price.ideal_min)}–${money(s.price.ideal_max)}, max ${money(s.price.max)} (exceptional up to ${money(s.price.exception_max)})\nMiles < ${s.hard.max_miles.toLocaleString()} · radius ${s.hard.max_distance_miles} mi (preferred ${s.distance.preferred_miles})\nFinancing: ${p.apr_pct}% · ${money(p.down_payment)} down · ${p.months} mo${p.financing_is_placeholder ? ' (PLACEHOLDERS)' : ''}\nHome ZIP set: ${p.home_zip ? 'yes' : 'NO (distance unknown)'}\nQuiet hours ${s.alerts.quiet_start}–${s.alerts.quiet_end} ET · test mode ${s.alerts.test_mode ? 'ON' : 'off'} · alerts ${s.alerts.paused ? 'PAUSED' : 'on'}\nAI cap: ${s.ai.claude_daily_cap} Claude/day (${s.ai.claude_model}) · Gemini ${s.ai.gemini_daily_cap}/day\nWeights: ${Object.entries(s.weights).map(([k, v]) => `${k} ${v}`).join(', ')}\nEverything else: settings.yaml in your GitHub repo.`, { db });
    }
    case '/set': {
      const m = arg.match(/^(.+?)\s+(\S+)$/);
      if (!m) return send(chat, 'Usage: /set max price 56000 · /set interest rate 6.9 · /set quiet start 22:30 · /set test mode off · or any settings.yaml path like /set weights.price_vs_market 22', { db });
      const name = m[1].toLowerCase().trim();
      const target = SETTING_ALIASES[name] || (name.includes('.') ? name : null);
      if (!target) return send(chat, `Unknown setting "${esc(name)}". Try: ${Object.keys(SETTING_ALIASES).slice(0, 18).join(', ')}`, { db });
      try {
        if (target.startsWith('private:')) { const v = setPrivate(target.slice(8), m[2]); ctx.priv = privateSettings(); db.action('set_private', null, target.slice(8)); return send(chat, `✅ ${esc(name)} updated (stored encrypted; never shown publicly).${target.endsWith('zip') ? '' : ` Now ${esc(v)}.`}`, { db }); }
        const { old, val } = setPublicSetting(target, m[2]); ctx.s = settings(); Object.assign(s, ctx.s); db.action('set', null, `${target}=${val}`);
        if (target.startsWith('weights.')) { const sum = Object.values(ctx.s.weights).reduce((a, b) => a + b, 0); if (sum !== 100) await send(chat, `Note: weights now add to ${sum}, not 100. Adjust another weight to rebalance.`, { db }); }
        return send(chat, `✅ ${esc(target)}: ${esc(old)} → <b>${esc(val)}</b>`, { db });
      } catch (e) { return send(chat, `❌ ${esc(e.message)}`, { db }); }
    }
    case '/pause': setPublicSetting('alerts.paused', 'true'); ctx.s = settings(); Object.assign(s, ctx.s); return send(chat, '⏸ Alerts paused. /resume to restart. (System problems are still reported.)', { db });
    case '/resume': setPublicSetting('alerts.paused', 'false'); ctx.s = settings(); Object.assign(s, ctx.s); return send(chat, '▶️ Alerts resumed.', { db });
    case '/search': db.d.queue.sweepRequested = true; return send(chat, '🔎 Full sweep requested for the next run.', { db });
    case '/market': {
      const snap = marketSnapshot(db, s);
      const lines = [`<b>Market snapshot</b> (C8 Stingray, seen last 30 days): ${snap.total} cars, ${snap.underMax} ≤ ${money(s.price.max)}`];
      for (const r of snap.rows.slice(0, 15)) lines.push(` ${esc(r.k)}: median ${money(r.median)} (${r.n})`);
      if (snap.trend != null) lines.push(`30-day median change: ${snap.trend >= 0 ? '+' : ''}${money(snap.trend)}`); else lines.push('Trend: not enough history yet.');
      return send(chat, lines.join('\n'), { db });
    }
    default: return send(chat, `Unknown command ${esc(cmd)}.\n\n${HELP}`, { db });
  }
}

/** Answer queued plain-English questions (within the daily cap). */
export async function answerQuestions(db, ctx) {
  const Q = db.d.queue.questions;
  while (Q.length) {
    const q = Q.shift();
    if (db.usage().questions >= ctx.s.ai.question_answers_per_day) { await send(ctx.priv.chat_id, `I've hit today's question limit (${ctx.s.ai.question_answers_per_day}). I'll answer "${esc(q.q.slice(0, 80))}" tomorrow.`, { db }); Q.unshift(q); break; }
    db.inc('questions');
    const cars = db.active().filter((l) => l.eval && !l.eval.filtered).sort((a, b) => (b.eval.score ?? 0) - (a.eval.score ?? 0)).slice(0, 15)
      .map((l) => ({ num: l.num, title: carTitle(l), price: l.price, miles: l.miles, score: l.eval.score ?? l.eval.ruleScore, cls: l.eval.cls, state: l.state, flags: l.eval.redFlags?.concat(l.eval.yellowFlags || []).slice(0, 4) }));
    const snap = marketSnapshot(db, ctx.s);
    const r = await aiText(db, ctx.s, `You help a private buyer hunting a used C8 Corvette Stingray (budget max ${money(ctx.s.price.max)}). Answer the question in under 150 words using ONLY the data below; say plainly when the data doesn't cover it. Never invent listings or prices. Do not mention the buyer's location.\nQuestion: ${q.q}\nTop cars: ${JSON.stringify(cars)}\nMarket: ${JSON.stringify(snap)}`, { notify: ctx.notifyOnce });
    await send(ctx.priv.chat_id, r.text ? `💬 ${esc(r.text.trim())}\n<i>(${esc(r.tier)})</i>` : '💬 No AI is available right now (cap reached or not set up), so I can\'t answer free-form questions this run. /top, /market and /car still work.', { db });
  }
}
