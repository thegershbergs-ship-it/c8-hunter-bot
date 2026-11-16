// AI layer, $0 only: 1) Claude via YOUR subscription token (claude -p), 2) Gemini free tier, 3) rules only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './config.js';
import { fetchRetry, warn, log, redact } from './util.js';

const PROMPT = () => fs.readFileSync(path.join(ROOT, 'prompts', 'evaluate.md'), 'utf8');
export const claudeConfigured = () => !!process.env.CLAUDE_CODE_OAUTH_TOKEN && process.env.DISABLE_CLAUDE !== '1';
export const geminiConfigured = () => !!process.env.GEMINI_API_KEY && process.env.DISABLE_GEMINI !== '1';

/** Which tier would be used right now. */
export function currentTier(db, s) {
  const u = db.usage();
  if (claudeConfigured() && !db.d.meta.claudeAuthBroken && u.claude < s.ai.claude_daily_cap) return 'claude';
  if (geminiConfigured() && !db.d.meta.geminiBlockedUntil?.startsWith(new Date().toISOString().slice(0, 10)) && u.gemini < s.ai.gemini_daily_cap) return 'gemini';
  return 'rules';
}

/** Listing data sent to AI (listing facts only, nothing about the owner). */
export function listingPayload(l, extra = {}) {
  return {
    title: l.title, year: l.year, variant: l.variant, trim: l.trim, body: l.body, price: l.price, miles: l.miles, vin: l.vin,
    exterior: l.extColorName, interior: l.intColorName, seller: l.sellerName, sellerType: l.sellerType, location: [l.city, l.state].filter(Boolean).join(', '),
    sellerClaimedOptions: l.optionClaims, ownersClaim: l.ownersClaim, description: (l.description || '').slice(0, 3500),
    pageTextExcerpt: (l.pageText || l.pastedText || '').slice(0, 4000), vinDecode: l.vinDecode ? { year: l.vinDecode.year, trim: l.vinDecode.trim, body: l.vinDecode.body, engine: l.vinDecode.engine } : null,
    historyReportText: (l.reportText || '').slice(0, 5000) || null, ruleScore: l.eval?.ruleScore, ...extra,
  };
}

/** Download photos to a temp dir (prioritize later photos less; listing photo order usually exterior first). */
export async function downloadPhotos(urls, max, buffers = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c8p-'));
  const files = [];
  for (const [i, b] of buffers.entries()) { const f = path.join(dir, `user${i}.jpg`); fs.writeFileSync(f, b); files.push(f); }
  // spread selection across the gallery so interior/engine/odometer shots (usually later) are included
  const pick = [];
  if (urls.length <= max) pick.push(...urls); else { const step = urls.length / max; for (let i = 0; i < max; i++) pick.push(urls[Math.floor(i * step)]); }
  for (const [i, u] of pick.entries()) {
    if (files.length >= max) break;
    try {
      const r = await fetchRetry(u, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; C8HunterBot/1.0)' } }, { retries: 1, timeoutMs: 20000 });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !/image\/(jpeg|png|webp|gif)/.test(ct)) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 5000 || buf.length > 4.5e6) continue;
      const f = path.join(dir, `p${i}.${ct.split('/')[1].split(';')[0].replace('jpeg', 'jpg')}`);
      fs.writeFileSync(f, buf); files.push(f);
    } catch { /* skip photo */ }
  }
  return { dir, files };
}

function runClaude(prompt, { model, maxTurns = 8, allowRead = false, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--model', model, '--max-turns', String(maxTurns)];
    if (allowRead) args.push('--allowedTools', 'Read');
    args.push('--disallowedTools', 'Bash,Write,Edit,WebFetch,WebSearch,NotebookEdit');
    const bin = process.env.CLAUDE_BIN || 'claude';
    const p = spawn(bin, args, { env: { ...process.env, ANTHROPIC_API_KEY: '' }, shell: process.platform === 'win32' });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('claude timed out')); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      let j = null; try { j = JSON.parse(out); } catch { /* not json */ }
      if (j && !j.is_error && j.result) return resolve(j.result);
      const msg = redact((j?.result || err || out || `exit ${code}`).toString().slice(0, 400));
      const e = new Error('claude failed: ' + msg);
      e.auth = /401|invalid bearer|authenticat|oauth|token (has )?expired|unauthori[sz]ed|login/i.test(msg);
      e.limit = /usage limit|rate limit|429|limit reached|overloaded/i.test(msg);
      reject(e);
    });
    p.stdin.end(prompt);
  });
}

async function runGemini(prompt, files, s, db) {
  const parts = [{ text: prompt }];
  for (const f of files) {
    const ext = path.extname(f).slice(1).replace('jpg', 'jpeg');
    parts.push({ inline_data: { mime_type: `image/${ext}`, data: fs.readFileSync(f).toString('base64') } });
  }
  let lastErr;
  for (const model of s.ai.gemini_models) {
    const res = await fetchRetry(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } }),
    }, { retries: 0, timeoutMs: 120000 });
    db.inc('gemini');
    const j = await res.json().catch(() => ({}));
    if (res.ok) return { text: j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '', model };
    lastErr = new Error(`gemini ${model} HTTP ${res.status}: ${j.error?.message?.slice(0, 150) || ''}`);
    if (res.status === 429) { lastErr.limit = true; break; }
    if (res.status === 400 && /api key|billing/i.test(j.error?.message || '')) { lastErr.auth = true; break; }
    // 404 = model retired -> try next model
  }
  throw lastErr;
}

export function parseJsonLoose(text) {
  const t = String(text || '').replace(/```json|```/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON in AI answer');
  return JSON.parse(t.slice(a, b + 1));
}

/** Validate/clean the structured AI answer so the program reads it reliably. */
export function cleanEval(j) {
  const arr = (x) => (Array.isArray(x) ? x.filter((y) => typeof y === 'string').map((y) => y.slice(0, 240)).slice(0, 10) : []);
  const tri = (x) => (x === true || x === false ? x : null);
  const opt = (o) => (o && typeof o === 'object' ? { value: o.value ?? null, truth: ['verified', 'claim', 'unknown'].includes(o.truth) ? o.truth : 'unknown', evidence: String(o.evidence || '').slice(0, 160) } : { value: null, truth: 'unknown' });
  const adj = Math.max(-10, Math.min(10, Math.round(Number(j.scoreAdjust) || 0)));
  const rf = j.reportFacts && typeof j.reportFacts === 'object' && Object.values(j.reportFacts).some((v) => v !== null && v !== undefined) ? j.reportFacts : null;
  return {
    analyzed: true, scoreAdjust: adj, adjustReason: String(j.adjustReason || '').slice(0, 240),
    options: Object.fromEntries(['Z51', 'MagRide', 'FrontLift', 'PerfExhaust', 'Seats'].map((k) => [k, opt(j.options?.[k])])),
    odometerPhotoMiles: Number.isFinite(Number(j.odometerPhotoMiles)) && j.odometerPhotoMiles !== null ? Number(j.odometerPhotoMiles) : null,
    vinInPhoto: typeof j.vinInPhoto === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/i.test(j.vinInPhoto) ? j.vinInPhoto.toUpperCase() : null,
    warningLights: tri(j.warningLights), perfMods: arr(j.perfMods), cosmeticMods: arr(j.cosmeticMods), trackUse: tri(j.trackUse),
    structuralDamage: j.structuralDamage ? String(j.structuralDamage).slice(0, 200) : null, tiresWorn: j.tiresWorn ? String(j.tiresWorn).slice(0, 160) : null,
    cosmeticFlaws: arr(j.cosmeticFlaws), photoQuality: String(j.photoQuality || ''), redFlags: arr(j.redFlags), yellowFlags: arr(j.yellowFlags),
    scamRisk: ['Low', 'Medium', 'High'].includes(j.scamRisk) ? j.scamRisk : 'Low', scamReasons: arr(j.scamReasons), missingInfo: arr(j.missingInfo),
    reportFacts: rf, negotiationPoints: arr(j.negotiationPoints), sellerMessage: String(j.sellerMessage || '').slice(0, 1500), recommendation: String(j.recommendation || '').slice(0, 240),
  };
}

/**
 * Evaluate one listing with the best available tier. Returns {tier, findings} or {tier:'rules'}.
 * Never throws. Records usage; flags broken auth once.
 */
export async function aiEvaluate(db, l, s, { userPhotos = [], notify } = {}) {
  let tier = currentTier(db, s);
  if (tier === 'rules') return { tier: 'rules' };
  const maxPhotos = tier === 'claude' ? Math.min(30, s.ai.claude_max_photos) : s.ai.gemini_max_photos;
  const { dir, files } = await downloadPhotos(l.photos || [], maxPhotos, userPhotos);
  try {
    const data = JSON.stringify(listingPayload(l), null, 1);
    if (tier === 'claude') {
      const prompt = `${PROMPT()}\n\n## Photos (${files.length}): read each with the Read tool\n${files.join('\n') || '(none)'}\n\n## Listing data\n${data}\n\nReturn only the JSON object.`;
      try {
        db.inc('claude');
        const text = await runClaude(prompt, { model: s.ai.claude_model, maxTurns: Math.max(4, Math.ceil(files.length / 4) + 3), allowRead: files.length > 0 });
        return { tier: 'claude', findings: cleanEval(parseJsonLoose(text)) };
      } catch (e) {
        warn('Claude evaluation failed: ' + e.message);
        if (e.auth) { db.d.meta.claudeAuthBroken = new Date().toISOString(); notify?.('claude_auth'); }
        if (e.limit) db.d.meta.claudeLimitedAt = new Date().toISOString();
        if (!geminiConfigured()) return { tier: 'rules', error: e.message };
        tier = 'gemini';
      }
    }
    if (tier === 'gemini') {
      if (db.usage().gemini >= s.ai.gemini_daily_cap) return { tier: 'rules' };
      const prompt = `${PROMPT().replace('read every image file listed below with the Read tool, if any', 'the photos are attached')}\n\n## Listing data\n${data}\n\nReturn only the JSON object.`;
      try {
        const r = await runGemini(prompt, files.slice(0, s.ai.gemini_max_photos), s, db);
        return { tier: `gemini (${r.model})`, findings: cleanEval(parseJsonLoose(r.text)) };
      } catch (e) {
        warn('Gemini evaluation failed: ' + e.message);
        if (e.limit) db.d.meta.geminiBlockedUntil = new Date().toISOString();
        if (e.auth) notify?.('gemini_auth');
        return { tier: 'rules', error: e.message };
      }
    }
    return { tier: 'rules' };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Free-form text task (deep-dive report, weekly narrative, question answers). Uses the same caps. */
export async function aiText(db, s, prompt, { notify } = {}) {
  const tier = currentTier(db, s);
  if (tier === 'claude') {
    try { db.inc('claude'); return { tier, text: await runClaude(prompt, { model: s.ai.claude_model, maxTurns: 2 }) }; }
    catch (e) { if (e.auth) { db.d.meta.claudeAuthBroken = new Date().toISOString(); notify?.('claude_auth'); } warn('claude text failed: ' + e.message); }
  }
  if (geminiConfigured() && db.usage().gemini < s.ai.gemini_daily_cap) {
    try {
      for (const model of s.ai.gemini_models) {
        const res = await fetchRetry(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }) }, { retries: 0, timeoutMs: 90000 });
        db.inc('gemini');
        if (res.ok) { const j = await res.json(); return { tier: `gemini (${model})`, text: j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '' }; }
        if (res.status === 429) break;
      }
    } catch (e) { warn('gemini text failed: ' + e.message); }
  }
  return { tier: 'rules', text: null };
}

/** Lightweight connectivity test for the token (used by /status self-test). */
export async function claudePing(s) {
  try { const t = await runClaude('Reply with exactly: OK', { model: s.ai.claude_model, maxTurns: 1, timeoutMs: 120000 }); return { ok: /OK/.test(t) }; }
  catch (e) { return { ok: false, auth: e.auth, error: e.message }; }
}
export { log };
