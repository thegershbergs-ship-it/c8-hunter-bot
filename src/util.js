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

// ---------------- SSRF protection ----------------
// Every outbound fetch of a URL that came from a listing/email/page goes through safeFetch():
//  - IP-literal hosts are classified with ipaddr.js (only global 'unicast' allowed; IPv4-mapped IPv6 unwrapped;
//    NAT64/6to4/ULA/link-local/loopback/private/CGNAT/reserved all denied),
//  - hostnames are checked INSIDE the connection's DNS lookup hook, so the validated address is the one connected to
//    (no DNS-rebinding window), for every hop and every retry,
//  - redirects are followed manually (max 5) and each hop is re-validated.
import ipaddr from 'ipaddr.js';
import dns from 'node:dns';
import { Agent, fetch as ufetch } from 'undici';

export function isPublicIp(addr) {
  if (!ipaddr.isValid(addr)) return false;
  let ip = ipaddr.parse(addr);
  if (ip.kind() === 'ipv6') {
    if (ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    else {
      // Deny by default: only global unicast IPv6 (2000::/3), excluding NAT64 (64:ff9b::/96, 64:ff9b:1::/48 are outside
      // 2000::/3 anyway), 6to4 (2002::/16) and Teredo (2001::/32), which embed other addresses.
      if (!ip.match(ipaddr.parseCIDR('2000::/3'))) return false;
      if (ip.match(ipaddr.parseCIDR('2002::/16')) || ip.match(ipaddr.parseCIDR('2001::/32'))) return false;
      return ip.range() === 'unicast';
    }
  }
  return ip.range() === 'unicast';
}

/** Cheap syntactic check (scheme, obvious local names, IP literals). */
export function isPublicHttpUrl(url) {
  let h;
  try { const x = new URL(url); if (!/^https?:$/.test(x.protocol)) return false; h = x.hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (!h || h === 'localhost' || /\.(localhost|internal|local|lan|home|corp)$/.test(h)) return false;
  if (ipaddr.isValid(h)) return isPublicIp(h);
  if (/^\d+$/.test(h) || /^0x/i.test(h)) return false; // integer/hex IP forms
  return h.includes('.');
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => !isPublicIp(a.address))) return cb(Object.assign(new Error('blocked non-public address'), { code: 'EBLOCKED' }));
    if (options && options.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  });
}
const safeAgent = new Agent({ connect: { lookup: safeLookup } });
export const ssrfAgent = safeAgent;

/** Kept for callers that only want a yes/no before doing work (the real enforcement is in safeFetch). */
export async function isPublicHttpUrlResolved(url) {
  if (!isPublicHttpUrl(url)) return false;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host)) return isPublicIp(host);
  return new Promise((res) => safeLookup(host, { all: true }, (e) => res(!e)));
}

/** fetch with the SSRF-safe agent; validates every redirect hop; up to 3 retries on temporary errors. */
export async function safeFetch(url, opts = {}, { retries = 3, timeoutMs = 30000 } = {}) {
  let cur = url;
  for (let hop = 0; hop <= 5; hop++) {
    if (!isPublicHttpUrl(cur)) throw new Error('blocked non-public address');
    let res, lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        res = await ufetch(cur, { ...opts, redirect: 'manual', dispatcher: safeAgent, signal: AbortSignal.timeout(timeoutMs) });
        if ([429, 500, 502, 503, 504].includes(res.status) && i < retries) { await sleep(2000 * 2 ** i); continue; }
        break;
      } catch (e) { lastErr = e; if (e?.cause?.code === 'EBLOCKED' || i >= retries) throw e; await sleep(2000 * 2 ** i); }
    }
    if (!res) throw lastErr;
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) return res;
    try { await res.body?.cancel(); } catch { /* ignore */ }
    cur = new URL(loc, cur).href;
  }
  throw new Error('too many redirects');
}
