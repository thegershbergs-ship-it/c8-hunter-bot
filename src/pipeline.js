// Evaluation pipeline: filters -> history -> score -> AI -> class -> alert decision.
import { hardFilter } from './rules.js';
import { runHistory } from './history.js';
import { scoreListing, classify, photoDupes, resolveOptions } from './score.js';
import { fairValue } from './market.js';
import { negotiationBrief } from './negotiate.js';
import { aiEvaluate } from './ai.js';
import { drivingMiles, STATE_CENTROIDS } from './geo.js';
import { generationCheck, upsertObservation } from './listing.js';
import { parsePage } from './extract.js';
import { politeFetch } from './fetcher.js';
import { send, sendPhotos, downloadFile } from './telegram.js';
import { formatCarAlert, formatEmailMatch, emailMatchButtons, buttons, carTitle } from './alerts.js';
import { nowIso, inQuietHours, warn, money, log } from './util.js';

export function distanceFor(l, ctx) {
  const rf = ctx.s.distance.road_factor;
  if (!ctx.priv.home_zip) return null;
  if (l.zip) { const d = drivingMiles(ctx.priv.home_zip, l.zip, rf); if (d != null) return d; }
  if (l.state && STATE_CENTROIDS[l.state]) { const d = drivingMiles(ctx.priv.home_zip, STATE_CENTROIDS[l.state], rf); return d; } // rough (state centroid)
  return null;
}

/** Cheap rule-only pass (used for email-only cars and to decide AI eligibility). */
export function quickScore(db, l, ctx) {
  const distance = distanceFor(l, ctx);
  const hf = hardFilter(l, ctx.s, { distance });
  const gen = generationCheck(l);
  if (gen === 'not_c8') hf.pass = false, hf.reasons.push('not a C8 Corvette');
  l.failReasons = hf.reasons;
  const fv = l.year ? fairValue(db, l, ctx.s) : null;
  const ev = scoreListing(l, { s: ctx.s, fv, distance, dupes: photoDupes(db, l) });
  return { hf, fv, ev, distance };
}

/**
 * Full evaluation. opts.ai: allow AI; opts.force: user asked (bypass threshold).
 * Stores l.eval; returns {l, cls, fv, nb, distance}.
 */
export async function evaluate(db, l, ctx, opts = {}) {
  const errors = ctx.errors || [];
  const s = ctx.s;
  let { hf, distance } = quickScore(db, l, ctx);
  if (!hf.pass) { setEval(l, { ruleScore: 0, score: 0, cls: 'Reject', confidence: 'High', notes: hf.reasons, redFlags: hf.reasons, yellowFlags: [], unknowns: [], scam: { level: 'Low', reasons: [] }, tier: 'rules', filtered: true }); return { l, cls: 'Reject', distance }; }
  if (l.vin) await runHistory(db, l, { errors });
  else l.history = { at: nowIso(), checks: { vin: { value: 'No VIN in listing: ask the seller (first question in the draft)', truth: 'unknown' } }, recalls: [], mismatches: [], serious: [] };
  // re-run filters with VIN-decoded truth
  ({ hf } = quickScore(db, l, ctx));
  if (!hf.pass) { setEval(l, { ruleScore: 0, score: 0, cls: 'Reject', confidence: 'High', notes: hf.reasons, redFlags: hf.reasons, yellowFlags: [], unknowns: [], scam: { level: 'Low', reasons: [] }, tier: 'rules', filtered: true }); return { l, cls: 'Reject', distance }; }
  let fv = fairValue(db, l, s);
  let ev = scoreListing(l, { s, fv, distance, dupes: photoDupes(db, l) });
  let tier = 'rules', aiAdjust = 0, aiReason = null;
  const eligible = opts.force || ev.ruleScore >= s.classes.ai_threshold;
  if (opts.ai !== false && eligible && !ev.redFlags.length) {
    const userPhotos = [];
    for (const fid of (l.userPhotoIds || []).slice(0, 12)) { try { userPhotos.push(await downloadFile(fid)); } catch (e) { warn('user photo: ' + e.message); } }
    const r = await aiEvaluate(db, l, s, { userPhotos, notify: ctx.notifyOnce });
    tier = r.tier;
    if (r.findings) {
      const f = r.findings;
      l.aiFindings = f; l.aiAt = nowIso();
      if (f.reportFacts && l.reportText) { l.reportFacts = f.reportFacts; l.reportRead = true; }
      if (f.odometerPhotoMiles != null) l.odometerPhoto = f.odometerPhotoMiles;
      if (f.vinInPhoto && !l.vin) { l.vin = f.vinInPhoto; l.vinFromPhoto = true; }
      else if (f.vinInPhoto && l.vin && f.vinInPhoto !== l.vin) (l.flags ||= []).push('vin_photo_mismatch');
      aiAdjust = f.scoreAdjust; aiReason = f.adjustReason;
      if (l.vinFromPhoto && l.vin) { const { isValidVin } = await import('./vin.js'); l.vinValid = isValidVin(l.vin); await runHistory(db, l, { errors }); }
      // re-score with AI findings (options verified from photos, mods, warning lights...)
      fv = fairValue(db, l, s);
      ev = scoreListing(l, { s, fv, distance, dupes: photoDupes(db, l) });
      if ((l.flags || []).includes('vin_photo_mismatch')) ev.redFlags.push('VIN visible in photos differs from the listed VIN');
      for (const rf of f.redFlags || []) if (!ev.yellowFlags.includes(rf)) ev.yellowFlags.unshift(`AI: ${rf}`);
    } else if (r.error) errors.push('AI: ' + r.error);
  } else resolveOptions(l);
  const c = classify(ev, l, s, aiAdjust);
  setEval(l, { ...ev, ...c, aiAdjust, aiReason, tier, recommendation: l.aiFindings?.recommendation, aiPending: tier === 'rules' && eligible });
  const nb = c.cls === 'Strong' || c.cls === 'Exceptional' || opts.force ? negotiationBrief(l, { fv, distance, s }) : null;
  return { l, cls: c.cls, fv, nb, distance };
}

function setEval(l, ev) {
  const prev = l.eval;
  l.evalHistory = [...(l.evalHistory || []), ...(prev ? [{ at: prev.at, score: prev.score, cls: prev.cls }] : [])].slice(-10);
  l.eval = { ...ev, at: nowIso() };
}

const RANK = { Reject: 0, Watchlist: 1, Strong: 2, Exceptional: 3 };

/** Decide whether to alert and send (or queue for after quiet hours). */
export async function maybeAlert(db, res, ctx, { changes = [], forceSend = false, replyTo } = {}) {
  const { l, cls } = res;
  const s = ctx.s;
  if (!ctx.priv.chat_id) return;
  if (cls !== 'Strong' && cls !== 'Exceptional' && !forceSend) {
    if (cls === 'Watchlist' && !db.d.alertsSent.some((a) => a.id === l.id && a.kind === 'summary')) (db.d.meta.dailySummary ||= []).includes(l.id) || db.d.meta.dailySummary.push(l.id);
    return;
  }
  const prev = [...db.d.alertsSent].reverse().find((a) => a.id === l.id && a.kind === 'car');
  let changeNote = null;
  if (prev && !forceSend) {
    const better = RANK[cls] > RANK[prev.cls];
    const cheaper = l.price && prev.price && l.price < prev.price;
    const material = changes.filter((c) => /DECREASED|relisted|different seller/.test(c));
    if (!better && !cheaper && !material.length) return;
    changeNote = [better && `class ${prev.cls} → ${cls}`, cheaper && `price ${money(prev.price)} → ${money(l.price)}`, ...material].filter(Boolean).join('; ');
  }
  if (s.alerts.paused && !forceSend) return;
  const quiet = inQuietHours(s.alerts.quiet_start, s.alerts.quiet_end);
  if (quiet && !forceSend && !(cls === 'Exceptional' && s.alerts.exceptional_ignores_quiet)) {
    const p = (db.d.meta.pendingAlerts ||= []);
    if (!p.includes(l.id)) p.push(l.id);
    return;
  }
  await sendCarAlert(db, l, res, ctx, { changeNote, replyTo });
}

export async function sendCarAlert(db, l, res, ctx, { changeNote, replyTo } = {}) {
  const text = formatCarAlert(db, l, { s: ctx.s, priv: ctx.priv, distance: res.distance, fv: res.fv, nb: res.nb, testMode: ctx.s.alerts.test_mode, changeNote });
  await sendPhotos(ctx.priv.chat_id, bestPhotos(l), `#${l.num} ${carTitle(l)}`);
  await send(ctx.priv.chat_id, text, { buttons: buttons(l), replyTo, db });
  db.d.alertsSent.push({ id: l.id, at: nowIso(), kind: 'car', cls: l.eval.cls, score: l.eval.score, price: l.price, reason: changeNote || 'new' });
}

function bestPhotos(l) {
  const p = l.photos || [];
  if (p.length <= 3) return p;
  return [p[0], p[Math.floor(p.length / 3)], p[Math.floor((2 * p.length) / 3)]];
}

/** Ingest one observation from an alert email. */
export async function ingestEmailListing(db, item, ctx, { site }) {
  const { listing: l, isNew, changes } = upsertObservation(db, item.fields, { url: item.url, source: `email:${site}`, dataLevel: 'email' });
  if (l.userRejected) return { l, skipped: true };
  const policy = ctx.s.sites[item.site]?.fetch || ctx.s.sites.dealer.fetch;
  // AUTO fetch only where you explicitly allowed it in settings.yaml
  if (policy === 'auto' && (isNew || changes.length) && l.dataLevel === 'email') {
    const r = await politeFetch(item.url, ctx.s, db, { mode: 'auto' });
    if (r.ok) upsertObservation(db, parsePage(r.html, item.url), { url: item.url, source: `page:${item.site}`, dataLevel: 'page' });
  }
  if (l.dataLevel !== 'email') {
    if (isNew || changes.length || !l.eval) { const res = await evaluate(db, l, ctx); await maybeAlert(db, res, ctx, { changes }); }
    return { l };
  }
  // email-only: quick rule score, short ping if promising
  const { hf, ev, distance } = quickScore(db, l, ctx);
  l.eval = { ...ev, score: ev.ruleScore, cls: hf.pass ? 'Unverified' : 'Reject', tier: 'rules', at: nowIso(), filtered: !hf.pass, notes: hf.reasons };
  const priceDrop = changes.find((c) => /price drop/.test(c));
  if (hf.pass && ev.ruleScore >= ctx.s.alerts.email_match_min_prescore && !ctx.s.alerts.paused && ctx.priv.chat_id && (isNew || priceDrop) && !l.matchSent) {
    if (inQuietHours(ctx.s.alerts.quiet_start, ctx.s.alerts.quiet_end)) { (db.d.meta.pendingMatches ||= []).includes(l.id) || db.d.meta.pendingMatches.push(l.id); }
    else await sendEmailMatch(db, l, ctx, distance);
  }
  return { l, isNew };
}
export async function sendEmailMatch(db, l, ctx, distance = distanceFor(l, ctx)) {
  await send(ctx.priv.chat_id, formatEmailMatch(db, l, { distance, priv: ctx.priv, testMode: ctx.s.alerts.test_mode }), { buttons: emailMatchButtons(l), db });
  l.matchSent = nowIso();
  db.d.alertsSent.push({ id: l.id, at: nowIso(), kind: 'match', price: l.price, reason: 'email match' });
}

/**
 * User-requested full check of a listing URL (Full check button or pasted link).
 * Returns {ok, l, needPaste, reason}.
 */
export async function fullCheckUrl(db, url, ctx, { existing } = {}) {
  const r = await politeFetch(url, ctx.s, db, { mode: 'request' });
  if (!r.ok) {
    if (r.gone && existing) { existing.status = 'likely_sold'; existing.soldClueAt = nowIso(); }
    return { ok: false, needPaste: !r.gone, reason: r.reason, gone: r.gone };
  }
  const fields = parsePage(r.html, url);
  // Dealers often redirect a sold car's URL to another car or to their inventory page.
  const isCorvette = /corvette/i.test(`${fields.title || ''} ${fields.trimName || ''}`) || (fields.vin && fields.vin.startsWith('1G1Y'));
  const wrongVin = existing?.vin && fields.vin && fields.vin !== existing.vin;
  if (!isCorvette || wrongVin) {
    if (existing) { existing.status = 'likely_sold'; existing.soldClueAt = nowIso(); }
    return { ok: false, gone: true, reason: 'the page now shows a different vehicle (the car is likely sold)' };
  }
  const { listing: l, changes } = upsertObservation(db, fields, { url, source: 'page', dataLevel: 'page' });
  l.lastChecked = nowIso();
  if (l.historyReportUrl && !l.reportText) {
    const hr = await politeFetch(l.historyReportUrl, ctx.s, db, { mode: 'request' });
    if (hr.ok) { const p = parsePage(hr.html, l.historyReportUrl); l.reportText = p.pageText?.slice(0, 6000); }
  }
  log(`full check: ${url} -> ${carTitle(l)} ${money(l.price)}`);
  return { ok: true, l, changes };
}
