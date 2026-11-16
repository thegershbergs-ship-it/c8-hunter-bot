// Entry point: node src/main.js quick|sweep|digest|selftest|testalert
import { loadSettings, privateSettings, settings } from './config.js';
import { DB } from './db.js';
import { log, warn, nowIso, safely, easternParts, inQuietHours, money, daysBetween, fmtEastern } from './util.js';
import { tgConfigured, send, esc, setCommands } from './telegram.js';
import { processUpdates, answerQuestions } from './bot.js';
import { emailConfigured, readAlertInbox } from './email.js';
import { evaluate, maybeAlert, sendCarAlert, ingestEmailListing, fullCheckUrl, sendEmailMatch, distanceFor, quickScore } from './pipeline.js';
import { upsertObservation, markLikelySold, siteOf, canonicalUrl } from './listing.js';
import { parseText } from './extract.js';
import { deepDive, inspectionChecklist, sellerDraft, weeklyDigest } from './reports.js';
import { carTitle, shortLine, formatCarAlert, buttons } from './alerts.js';
import { fairValue } from './market.js';
import { negotiationBrief } from './negotiate.js';
import { claudeConfigured, geminiConfigured, claudePing, currentTier, aiText } from './ai.js';

const mode = process.argv[2] || 'quick';
const db = DB.load();
const errors = [];
const ctx = { s: loadSettings(), priv: privateSettings(), errors, db };
const stats = { mode, start: nowIso(), emails: 0, newListings: 0, alerts: 0, evaluated: 0, ai: 0 };

const NOTICES = {
  claude_auth: `🔑 <b>Your Claude token stopped working</b> (expired, revoked or rejected). The bot switched to the backup AI / rules for now.\nFix (5 min):\n1. On your computer open a terminal (PowerShell).\n2. Run: <code>claude setup-token</code> and approve in the browser.\n3. Copy the long token it prints.\n4. GitHub → your repo → Settings → Secrets and variables → Actions → <b>CLAUDE_CODE_OAUTH_TOKEN</b> → Update → paste → Save.\nI'll detect the fix automatically within a day (or send /search).`,
  gemini_auth: '🔑 The Gemini backup key was rejected. Create a new free key at aistudio.google.com (no billing!) and update the GEMINI_API_KEY secret. The bot keeps working without it.',
};
async function notifyOnce(key, text) {
  if (!db.noticeChanged(key, 'broken') || !ctx.priv.chat_id) return;
  await safely('notice', () => send(ctx.priv.chat_id, text || NOTICES[key] || key, { db }));
}
async function notifyRecovered(key, text) {
  const n = db.d.notices[key];
  if (n?.state === 'broken') { db.noticeChanged(key, 'ok'); if (ctx.priv.chat_id) await safely('notice', () => send(ctx.priv.chat_id, text, { db })); }
}
ctx.notifyOnce = (k) => notifyOnce(k);

async function sourceResult(name, ok, err) {
  if (ok) { const { recovered } = db.sourceOk(name); if (recovered) await notifyRecovered(`source:${name}`, `✅ Source <b>${esc(name)}</b> is working again.`); }
  else { const { wentDown } = db.sourceFail(name, err); if (wentDown) await notifyOnce(`source:${name}`, `🔴 Source <b>${esc(name)}</b> failed 3 times in a row and is marked DOWN: ${esc(String(err).slice(0, 200))}\nI'll test it once a day and tell you when it recovers. See TROUBLESHOOTING.md.`); }
}

// ---------------- work steps ----------------
async function stepTelegram() {
  if (!tgConfigured()) return;
  try { await processUpdates(db, ctx); await sourceResult('telegram', true); }
  catch (e) { await sourceResult('telegram', false, e.message); throw e; }
}

async function stepEmail() {
  if (!emailConfigured()) { db.d.sources['alert-inbox'] = { status: 'NOT SET UP', failCount: 0 }; return; }
  if (!db.sourceShouldRun('alert-inbox')) return;
  let results;
  try { results = await readAlertInbox(db); await sourceResult('alert-inbox', true); }
  catch (e) {
    const auth = /auth|credential|password|login|AUTHENTICATIONFAILED/i.test(e.message + (e.responseText || ''));
    await sourceResult('alert-inbox', false, auth ? 'Gmail rejected the app password (revoked or changed?)' : e.message);
    return;
  }
  stats.emails += results.length;
  for (const r of results) {
    const srcName = `email:${r.site}`;
    if (r.parseFailed) {
      const s = (db.d.sources[srcName] ||= { failCount: 0, status: 'OK' });
      s.parseFails = (s.parseFails || 0) + 1; s.degraded = true; s.status = 'DEGRADED';
      await notifyOnce(`parse:${r.site}`, `🟡 I couldn't read a <b>${esc(r.site)}</b> alert email (format may have changed). Saved a sample for fixing; other sites keep running.`);
      continue;
    }
    if (r.site !== 'unknown') { const s = (db.d.sources[srcName] ||= { failCount: 0 }); s.degraded = false; db.sourceOk(srcName); await notifyRecovered(`parse:${r.site}`, `✅ ${esc(r.site)} alert emails are parsing again.`); }
    for (const a of r.auctions) if (!db.d.auctions.some((x) => x.url === a.url)) db.d.auctions.push(a);
    for (const item of r.listings) {
      const res = await safely(`ingest ${item.url}`, () => ingestEmailListing(db, item, ctx, { site: r.site }), errors);
      if (res?.isNew) stats.newListings++;
    }
  }
}

async function stepQueues() {
  const Q = db.d.queue, chat = ctx.priv.chat_id;
  if (!chat) return;
  // pasted links
  while (Q.links.length) {
    const { url, note } = Q.links.shift();
    await safely('pasted link', async () => {
      const r = await fullCheckUrl(db, url, ctx);
      if (r.ok) {
        if (note) r.l.pastedText = note;
        r.l.recheck = r.l.recheck || false;
        const res = await evaluate(db, r.l, ctx, { force: true });
        await sendCarAlert(db, r.l, enrich(res), ctx);
        stats.evaluated++;
      } else {
        const { listing: l } = upsertObservation(db, parseText(note || ''), { url, source: 'pasted', dataLevel: 'pasted' });
        if (note) l.pastedText = note;
        db.d.telegram.awaiting = { id: l.id, at: nowIso(), url };
        await send(chat, `📋 I can't open that page automatically (${esc(r.reason)}).\nPlease <b>paste the listing text</b> (title, price, miles, description, seller) and <b>send the photos</b> right here. I'll evaluate it at the next run.\nStill missing: ${missingFields(l).join(', ')}`, { db });
      }
    }, errors);
  }
  // pasted text/photos for an awaiting car
  const aw = db.d.telegram.awaiting;
  if (aw?.dirty) {
    aw.dirty = false;
    const l = db.get(aw.id);
    if (l) await safely('pasted content', async () => {
      upsertObservation(db, { ...parseText(l.pastedText || ''), description: l.pastedText }, { url: aw.url, source: 'pasted', dataLevel: 'pasted' });
      const res = await evaluate(db, l, ctx, { force: true });
      await sendCarAlert(db, l, enrich(res), ctx);
      const miss = missingFields(l);
      if (miss.length) await send(chat, `Still missing for #${l.num}: ${miss.join(', ')}. Send more text/photos anytime today and I'll re-check.`, { db });
      stats.evaluated++;
    }, errors);
  }
  // Full check (from email matches)
  while (Q.fullCheck.length) {
    const l = db.get(Q.fullCheck.shift()); if (!l) continue;
    await safely('full check', async () => {
      const url = l.links?.[0]?.url;
      const r = url ? await fullCheckUrl(db, url, ctx, { existing: l }) : { ok: false, needPaste: true, reason: 'no link' };
      const car = r.ok ? r.l : l;
      if (!r.ok) {
        db.d.telegram.awaiting = { id: l.id, at: nowIso(), url };
        if (r.gone) return send(chat, `#${l.num}: the listing page is gone, so it's likely sold.`, { db });
        return send(chat, `📋 #${l.num}: ${esc(r.reason)}.\nOpen <a href="${esc(url || '')}">the listing</a>, then <b>paste its text and send its photos here</b>. I'll do the full check at the next run.`, { db });
      }
      const res = await evaluate(db, car, ctx, { force: true });
      await sendCarAlert(db, car, enrich(res), ctx);
      stats.evaluated++;
    }, errors);
  }
  for (const id of Q.deepDive.splice(0)) { const l = db.get(id); if (l) await safely('deep dive', async () => { const res = enrich({ l, distance: distanceFor(l, ctx) }); await send(chat, await deepDive(db, l, res, ctx), { db }); }, errors); }
  for (const id of Q.checklist.splice(0)) { const l = db.get(id); if (l) await safely('checklist', () => send(chat, `<b>🧰 Inspection checklist: #${l.num} ${esc(carTitle(l))}</b>\n${inspectionChecklist(l).map((x) => '☐ ' + esc(x)).join('\n')}`, { db }), errors); }
  for (const id of Q.draft.splice(0)) { const l = db.get(id); if (l) await safely('draft', () => send(chat, `<b>✉️ Draft for #${l.num}</b> (copy & send it yourself; I never contact sellers):\n\n<code>${esc(sellerDraft(l))}</code>`, { db }), errors); }
}

function enrich(res) {
  const l = res.l;
  const distance = res.distance ?? distanceFor(l, ctx);
  const fv = res.fv || (l.year ? fairValue(db, l, ctx.s) : null);
  const nb = res.nb || (l.price ? negotiationBrief(l, { fv, distance, s: ctx.s }) : null);
  return { ...res, distance, fv, nb };
}

function missingFields(l) {
  const m = [];
  for (const [k, n] of [['vin', 'VIN'], ['price', 'price'], ['miles', 'mileage'], ['year', 'model year'], ['trim', 'trim (1LT/2LT/3LT)'], ['extColorName', 'exterior color'], ['city', 'location']]) if (!l[k]) m.push(n);
  if (!(l.photos?.length || l.userPhotoIds?.length)) m.push('photos');
  if (!l.historyReportUrl) m.push('history report link');
  return m;
}

/** Watchlisted cars: one page re-check per day (you asked to track them). */
async function stepWatchlist() {
  for (const l of db.listings.filter((x) => x.watch && x.status === 'active' && !x.userRejected)) {
    if (l.lastChecked && daysBetween(l.lastChecked) < 1) continue;
    const url = l.links?.find((k) => (ctx.s.sites[k.site]?.fetch || ctx.s.sites.dealer.fetch) !== 'never')?.url;
    if (!url) continue;
    await safely('watch recheck', async () => {
      const oldPrice = l.price, oldMiles = l.miles;
      const r = await fullCheckUrl(db, url, ctx, { existing: l });
      l.lastChecked = nowIso();
      if (!r.ok) {
        if (r.gone) { l.status = 'likely_sold'; await send(ctx.priv.chat_id, `📭 Watched car #${l.num} ${esc(carTitle(l))}: listing removed, likely sold (last ask ${money(l.price)}).`, { db }); }
        return;
      }
      l.lastSeen = nowIso();
      const changes = [];
      if (oldPrice && r.l.price && r.l.price < oldPrice) changes.push(`price drop ${money(oldPrice)} → ${money(r.l.price)}`);
      if (oldMiles != null && r.l.miles != null && r.l.miles !== oldMiles) changes.push(`mileage ${oldMiles} → ${r.l.miles}`);
      if (changes.length) {
        const res = await evaluate(db, r.l, ctx);
        await send(ctx.priv.chat_id, `⭐ Watched #${l.num} ${esc(carTitle(l))}: ${esc(changes.join('; '))}. Now ${res.cls} ${l.eval.score}/100.`, { db });
        if (res.cls === 'Strong' || res.cls === 'Exceptional') await maybeAlert(db, enrich(res), ctx, { changes });
      }
    }, errors);
  }
}

/** Automatic direct sources (only those allowed by robots + terms). */
async function stepDirectSources() {
  const { DIRECT_SOURCES, runDirectSource } = await import('./sources.js');
  for (const name of Object.keys(DIRECT_SOURCES)) {
    if ((ctx.s.sites[name]?.fetch) !== 'auto' || !db.sourceShouldRun(name)) continue;
    let r;
    try { r = await runDirectSource(db, name, ctx); await sourceResult(name, true); }
    catch (e) { await sourceResult(name, false, e.message); continue; }
    if (r.degraded) { db.d.sources[name].degraded = true; db.d.sources[name].status = 'DEGRADED'; await notifyOnce(`degraded:${name}`, `🟡 ${esc(name)}: extraction quality dropped (mileage/year missing on most new listings). The site layout may have changed.`); }
    stats.newListings += r.fresh.length;
    for (const l of r.fresh) {
      const res = await safely(`evaluate ${l.id}`, () => evaluate(db, l, ctx), errors);
      if (res) { stats.evaluated++; await safely('alert', () => maybeAlert(db, enrich(res), ctx), errors); }
    }
  }
}

/** Re-run AI review for cars that were scored by rules only (cap permitting), best first. */
async function stepPendingAI() {
  const pending = db.active().filter((l) => l.eval?.aiPending && !l.userRejected && l.dataLevel !== 'email').sort((a, b) => b.eval.ruleScore - a.eval.ruleScore);
  for (const l of pending) {
    if (currentTier(db, ctx.s) === 'rules') break;
    const before = l.eval.cls;
    const res = await safely('ai pending', () => evaluate(db, l, ctx), errors);
    if (res && res.cls !== before) await maybeAlert(db, enrich(res), ctx, { changes: [`AI review: ${before} → ${res.cls}`] });
  }
}

async function stepPendingAlerts() {
  const s = ctx.s;
  if (s.alerts.paused || inQuietHours(s.alerts.quiet_start, s.alerts.quiet_end) || !ctx.priv.chat_id) return;
  for (const id of (db.d.meta.pendingAlerts || []).splice(0)) { const l = db.get(id); if (l && l.status === 'active' && !l.userRejected) await safely('pending alert', () => sendCarAlert(db, l, enrich({ l }), ctx), errors); }
  for (const id of (db.d.meta.pendingMatches || []).splice(0)) { const l = db.get(id); if (l && !l.matchSent && !l.userRejected) await safely('pending match', () => sendEmailMatch(db, l, ctx), errors); }
  // daily summary of Watchlist-class cars
  const { hour, date } = easternParts();
  if (s.alerts.daily_summary && hour >= s.alerts.daily_summary_hour && db.d.meta.lastSummary !== date) {
    const ids = (db.d.meta.dailySummary || []).splice(0);
    db.d.meta.lastSummary = date;
    const cars = ids.map((i) => db.get(i)).filter((l) => l && l.status === 'active' && !l.userRejected);
    if (cars.length) {
      await send(ctx.priv.chat_id, `${s.alerts.test_mode ? '[TEST] ' : ''}<b>👀 Today's Watchlist-class cars</b>\n${cars.map((l) => shortLine(db, l, { distance: distanceFor(l, ctx) })).join('\n')}\nUse /car N for details.`, { db });
      for (const l of cars) db.d.alertsSent.push({ id: l.id, at: nowIso(), kind: 'summary', cls: l.eval?.cls, price: l.price });
    }
  }
}

async function stepClaudeHealth() {
  if (!claudeConfigured() || !db.d.meta.claudeAuthBroken) return;
  if (daysBetween(db.d.meta.claudeAuthBroken) < 0.9 && !db.d.queue.sweepRequested) return;
  const r = await claudePing(ctx.s);
  if (r.ok) { db.d.meta.claudeAuthBroken = null; await notifyRecovered('claude_auth', '✅ Claude token works again. AI evaluations are back on your subscription.'); }
  else db.d.meta.claudeAuthBroken = nowIso();
}

async function stepHousekeeping() {
  markLikelySold(db, ctx.s.market.likely_sold_after_days_missing);
  const n = db.archiveOld(ctx.s.market.archive_after_days);
  if (n) log(`archived ${n} old listings`);
  // trim logs
  db.d.alertsSent = db.d.alertsSent.slice(-3000);
  db.d.meta.runLog = (db.d.meta.runLog || []).slice(-60);
  for (const d of Object.keys(db.d.usage)) if (daysBetween(d) > 60) delete db.d.usage[d];
}

function topCars(n = 5) {
  return db.active().filter((l) => !l.userRejected && l.eval && !l.eval.filtered && l.eval.cls !== 'Reject').sort((a, b) => (b.eval.score ?? b.eval.ruleScore) - (a.eval.score ?? a.eval.ruleScore)).slice(0, n);
}

// ---------------- modes ----------------
async function run() {
  log(`=== C8 Hunter ${mode} run (${fmtEastern(nowIso())}) ===`);
  if (mode === 'quick' || mode === 'sweep') {
    await safely('telegram', stepTelegram, errors);
    await safely('claude health', stepClaudeHealth, errors);
    await safely('email', stepEmail, errors);
    await safely('queues', stepQueues, errors);
    await safely('watchlist', stepWatchlist, errors);
    if (mode === 'sweep' || db.d.queue.sweepRequested) {
      db.d.queue.sweepRequested = false;
      await safely('direct sources', stepDirectSources, errors);
      await safely('pending AI', stepPendingAI, errors);
      await safely('housekeeping', stepHousekeeping, errors);
      db.d.meta.lastRun.sweep = nowIso();
    }
    await safely('pending alerts', stepPendingAlerts, errors);
    await safely('questions', () => answerQuestions(db, ctx), errors);
    db.d.meta.lastRun.quick = nowIso();
  } else if (mode === 'digest') {
    await safely('telegram', stepTelegram, errors);
    const top = topCars().map((l) => ({ l, distance: distanceFor(l, ctx) }));
    const watch = db.listings.filter((l) => l.watch).map((l) => ({ l, distance: distanceFor(l, ctx) }));
    if (ctx.priv.chat_id) await safely('digest', async () => send(ctx.priv.chat_id, await weeklyDigest(db, ctx, { top, watch, lastTop: db.d.meta.lastTop }), { db }), errors);
    db.d.meta.lastTop = top.map((x) => x.l.id);
    db.d.meta.lastRun.digest = nowIso();
  } else if (mode === 'selftest') {
    await selfTest();
  } else if (mode === 'testalert') {
    await testAlert();
  } else throw new Error('unknown mode ' + mode);
}

async function selfTest() {
  const lines = ['<b>🧪 Self-test</b>'];
  const ok = (b) => (b ? '✅' : '❌');
  lines.push(`${ok(tgConfigured())} Telegram token${ctx.priv.chat_id ? ' · chat linked' : ' · chat NOT linked yet (send /start to your bot)'}`);
  if (tgConfigured()) { await safely('commands', setCommands, errors); await safely('telegram', stepTelegram, errors); }
  if (emailConfigured()) {
    try { const { ImapFlow } = await import('imapflow'); const c = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: process.env.GMAIL_ADDRESS, pass: process.env.GMAIL_APP_PASSWORD }, logger: false }); await c.connect(); const st = await c.status('INBOX', { messages: true, unseen: true }); await c.logout(); lines.push(`✅ Alert inbox connected (${st.messages} emails, ${st.unseen} unread)`); }
    catch (e) { lines.push(`❌ Alert inbox: ${esc(e.message)} (check the app password / 2-step verification)`); }
  } else lines.push('❌ Alert inbox not set up (GMAIL_ADDRESS / GMAIL_APP_PASSWORD secrets)');
  if (claudeConfigured()) { const r = await claudePing(ctx.s); db.inc('claude'); lines.push(r.ok ? '✅ Claude (your subscription) answered' : `❌ Claude: ${esc((r.error || '').slice(0, 200))}`); if (r.ok) db.d.meta.claudeAuthBroken = null; }
  else lines.push('➖ Claude token not set (CLAUDE_CODE_OAUTH_TOKEN). AI will use Gemini/rules.');
  if (geminiConfigured()) { const r = await aiText(db, { ...ctx.s, ai: { ...ctx.s.ai, claude_daily_cap: 0 } }, 'Reply with exactly: OK'); lines.push(r.text && /OK/.test(r.text) ? `✅ Gemini backup answered (${esc(r.tier)})` : '❌ Gemini backup did not answer'); }
  else lines.push('➖ Gemini backup not set (optional)');
  lines.push(`${ok(!!ctx.priv.home_zip)} Home ZIP ${ctx.priv.home_zip ? 'set' : 'NOT set: distances unknown'} · financing ${ctx.priv.financing_is_placeholder ? 'using PLACEHOLDERS' : 'set'}`);
  // NHTSA
  try { const { nhtsaRecalls } = await import('./history.js'); const r = await nhtsaRecalls(db, 2021); lines.push(`✅ NHTSA recalls API (${r.length} for 2021)`); } catch (e) { lines.push('❌ NHTSA: ' + esc(e.message)); }
  log(lines.join('\n').replace(/<[^>]+>/g, ''));
  if (ctx.priv.chat_id) await send(ctx.priv.chat_id, lines.join('\n'), { db });
}

/** A sample alert with all buttons, from a clearly fake demo car (marked TEST, never stored as market data). */
async function testAlert() {
  if (!ctx.priv.chat_id) { log('No chat linked yet: send /start to your bot, then run again.'); return; }
  const demo = { id: 'DEMO', num: 0, year: 2021, variant: 'Stingray', trim: '2LT', body: 'coupe', price: 54900, miles: 14250, extColorName: 'Torch Red', intColorName: 'Jet Black', city: 'Demo City', state: 'NY', sellerName: 'Demo Chevrolet', sellerType: 'franchise', firstSeen: nowIso(), links: [{ url: 'https://example.com/demo-listing', site: 'demo' }], photos: [], optionClaims: { Z51: true, FrontLift: true },
    optionsResolved: { Z51: { value: true, truth: 'claim' }, MagRide: { value: null, truth: 'unknown' }, FrontLift: { value: true, truth: 'claim' }, PerfExhaust: { value: true, truth: 'claim' }, Seats: { value: 'GT2', truth: 'claim' } },
    history: { checks: { vin: { value: 'DEMO: no real VIN', truth: 'unknown' } }, recalls: [] }, priceHistory: [],
    eval: { cls: 'Strong', score: 80, confidence: 'Medium', notes: ['THIS IS A DEMO ALERT: buttons work but the car is fake'], scam: { level: 'Low', reasons: [] }, redFlags: [], yellowFlags: [], unknowns: ['VIN', 'history report'], sellerType: 'franchise', tier: 'rules' } };
  db.put(demo); demo.status = 'demo';
  const text = formatCarAlert(db, demo, { s: { ...ctx.s, alerts: { ...ctx.s.alerts, test_mode: true } }, priv: ctx.priv, distance: null, fv: null, nb: { opening: 52500, target: 53500, walk: 54900, drops: [] }, testMode: true });
  await send(ctx.priv.chat_id, text, { buttons: buttons(demo), db });
}

let exitCode = 0;
try { await run(); } catch (e) { warn('run failed: ' + e.stack); errors.push(e.message); exitCode = 1; }
finally {
  stats.end = nowIso(); stats.errors = errors.length; stats.claudeToday = db.usage().claude;
  db.d.meta.runLog = [...(db.d.meta.runLog || []), { ...stats, errorSamples: errors.slice(0, 3).map((x) => String(x).slice(0, 160)) }].slice(-60);
  try { db.save(); log('database saved'); } catch (e) { warn('DB SAVE FAILED: ' + e.message); exitCode = 1; }
  log(`summary: mode=${mode} emails=${stats.emails} new=${stats.newListings} evaluated=${stats.evaluated} claudeToday=${stats.claudeToday} errors=${errors.length}`);
  for (const e of errors.slice(0, 10)) log('  error: ' + e);
}
process.exit(exitCode);
