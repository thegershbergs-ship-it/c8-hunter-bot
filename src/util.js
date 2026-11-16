import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();
export const hash = (s, n = 12) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);

// ---- secret-safe logging: never print secrets, even partially ----
const SECRET_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GMAIL_ADDRESS', 'GMAIL_APP_PASSWORD', 'CLAUDE_CODE_OAUTH_TOKEN',
  'GEMINI_API_KEY', 'HOME_ZIP', 'LOAN_APR', 'LOAN_DOWN', 'LOAN_MONTHS', 'PRIVATE_KEY', 'GITHUB_TOKEN'];
export function redact(s) {
  let out = String(s);
  for (const k of SECRET_ENV) {
    const v = process.env[k];
    if (v && v.length >= 4) out = out.split(v).join(`[${k}]`);
  }
  out = out.replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot[TOKEN]').replace(/sk-ant-[A-Za-z0-9_-]+/g, '[CLAUDE_TOKEN]').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[GEMINI_KEY]');
  return out;
}
export const log = (...a) => console.log(redact(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
export const warn = (...a) => console.warn(redact('WARN ' + a.map((x) => (typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x))).join(' ')));

// ---- Eastern time helpers ----
export function easternParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: p.weekday };
}
export const todayKey = () => easternParts().date;
export function fmtEastern(iso) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
}
export function inQuietHours(start, end, d = new Date()) {
  const { hour, minute } = easternParts(d);
  const t = hour * 60 + minute;
  const [sh, sm] = start.split(':').map(Number), [eh, em] = end.split(':').map(Number);
  const s = sh * 60 + sm, e = eh * 60 + em;
  return s <= e ? t >= s && t < e : t >= s || t < e;
}
export const daysBetween = (a, b = new Date()) => (new Date(b) - new Date(a)) / 86400000;
export const money = (n) => (n == null || !Number.isFinite(n) ? '?' : '$' + Math.round(n).toLocaleString('en-US'));
export const miles = (n) => (n == null ? '?' : Math.round(n).toLocaleString('en-US') + ' mi');

/** fetch with timeout and up to 3 retries with growing waits for temporary errors only */
export async function fetchRetry(url, opts = {}, { retries = 3, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if ([429, 500, 502, 503, 504].includes(res.status) && i < retries) { lastErr = new Error('HTTP ' + res.status); await sleep(2000 * 2 ** i); continue; }
      return res;
    } catch (e) { lastErr = e; if (i < retries) await sleep(2000 * 2 ** i); }
  }
  throw lastErr;
}

/** Run fn; never throw; record error. Used so one failure never stops a run. */
export async function safely(label, fn, errors) {
  try { return await fn(); } catch (e) { warn(`${label}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); if (errors) errors.push(`${label}: ${redact(e.message || e)}`); return undefined; }
}

/** SSRF guard: only http(s) to public hostnames (no localhost, private, link-local or metadata addresses). */
export function isPublicHttpUrl(url) {
  let h;
  try { const x = new URL(url); if (!/^https?:$/.test(x.protocol)) return false; h = x.hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || !h.includes('.') && !h.includes(':')) return false;
  if (/^(0|10|127)\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return false;
  if (h.includes(':') && (/^(::1?|fc|fd|fe80)/.test(h) || h.startsWith('::ffff:'))) return false;
  return true;
}
