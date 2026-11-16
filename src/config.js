// Settings (public, settings.yaml) + private settings (GitHub Secrets / encrypted overrides).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SETTINGS_PATH = path.join(ROOT, 'settings.yaml');
export const PRIVATE_PATH = path.join(ROOT, 'data', 'private.enc');

let _doc = null;
export function loadSettings() {
  _doc = YAML.parseDocument(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  return _doc.toJS();
}
export function settings() { if (!_doc) loadSettings(); return _doc.toJS(); }

// Friendly names for /set. Value: dotted path in settings.yaml, or "private:<key>".
export const SETTING_ALIASES = {
  'max price': 'price.max', maxprice: 'price.max', 'exception price': 'price.exception_max',
  'ideal min': 'price.ideal_min', 'ideal max': 'price.ideal_max',
  'mileage limit': 'hard.max_miles', miles: 'hard.max_miles', 'max miles': 'hard.max_miles',
  radius: 'hard.max_distance_miles', 'max distance': 'hard.max_distance_miles',
  'preferred distance': 'distance.preferred_miles',
  'quiet start': 'alerts.quiet_start', 'quiet end': 'alerts.quiet_end',
  'test mode': 'alerts.test_mode', testmode: 'alerts.test_mode',
  'ai cap': 'ai.claude_daily_cap', 'daily ai cap': 'ai.claude_daily_cap', aicap: 'ai.claude_daily_cap',
  'gemini cap': 'ai.gemini_daily_cap', 'claude model': 'ai.claude_model',
  'daily summary': 'alerts.daily_summary',
  'interest rate': 'private:apr_pct', rate: 'private:apr_pct', apr: 'private:apr_pct',
  'down payment': 'private:down_payment', down: 'private:down_payment',
  'loan length': 'private:months', months: 'private:months', term: 'private:months',
  'home zip': 'private:home_zip', zip: 'private:home_zip',
};

function coerce(old, raw) {
  const v = String(raw).trim();
  if (typeof old === 'boolean') {
    if (/^(true|on|yes|1)$/i.test(v)) return true;
    if (/^(false|off|no|0)$/i.test(v)) return false;
    throw new Error(`expected on/off, got "${v}"`);
  }
  if (typeof old === 'number') {
    const n = Number(v.replace(/[$,%]/g, '').replace(/k$/i, '000'));
    if (!Number.isFinite(n)) throw new Error(`expected a number, got "${v}"`);
    return n;
  }
  return v;
}

/** Set a public setting by dotted path; writes settings.yaml preserving comments. */
export function setPublicSetting(dotted, raw) {
  if (!_doc) loadSettings();
  const keys = dotted.split('.');
  const old = _doc.getIn(keys);
  if (old === undefined) throw new Error(`unknown setting ${dotted}`);
  if (typeof old === 'object') throw new Error(`${dotted} is a group; set one of its items`);
  if (/quiet_(start|end)$/.test(dotted) && !/^\d{1,2}:\d{2}$/.test(String(raw).trim())) throw new Error('use HH:MM, e.g. 23:00');
  const val = coerce(old, raw);
  _doc.setIn(keys, val);
  fs.writeFileSync(SETTINGS_PATH, String(_doc));
  return { old, val };
}

// ---------- private settings ----------
function key() {
  const base = process.env.PRIVATE_KEY || process.env.TELEGRAM_BOT_TOKEN;
  if (!base) return null;
  return crypto.createHash('sha256').update('c8hunter-private-v1:' + base).digest();
}
export function readPrivateOverrides() {
  const k = key();
  if (!k || !fs.existsSync(PRIVATE_PATH)) return {};
  try {
    const buf = Buffer.from(fs.readFileSync(PRIVATE_PATH, 'utf8').trim(), 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', k, iv); d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
  } catch { return {}; } // key changed (token rotated) -> overrides lost, fall back to secrets
}
export function writePrivateOverrides(obj) {
  const k = key();
  if (!k) throw new Error('no TELEGRAM_BOT_TOKEN to encrypt private settings');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  fs.mkdirSync(path.dirname(PRIVATE_PATH), { recursive: true });
  fs.writeFileSync(PRIVATE_PATH, Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') + '\n');
}

/** Private settings: encrypted overrides (from /set) > GitHub Secrets > placeholder defaults. */
export function privateSettings() {
  const s = settings();
  const o = readPrivateOverrides();
  const num = (x) => (x === undefined || x === null || x === '' ? undefined : Number(x));
  const out = {
    home_zip: o.home_zip || process.env.HOME_ZIP || null,
    apr_pct: num(o.apr_pct) ?? num(process.env.LOAN_APR) ?? s.financing_defaults.apr_pct,
    down_payment: num(o.down_payment) ?? num(process.env.LOAN_DOWN) ?? s.financing_defaults.down_payment,
    months: num(o.months) ?? num(process.env.LOAN_MONTHS) ?? s.financing_defaults.months,
    chat_id: process.env.TELEGRAM_CHAT_ID || o.chat_id || null,
  };
  out.financing_is_placeholder = !(o.apr_pct || process.env.LOAN_APR);
  return out;
}
export function setPrivate(k, raw) {
  const o = readPrivateOverrides();
  let v = String(raw).trim();
  if (k === 'home_zip') { if (!/^\d{5}$/.test(v)) throw new Error('ZIP must be 5 digits'); }
  else { const n = Number(v.replace(/[$,%]/g, '').replace(/k$/i, '000')); if (!Number.isFinite(n)) throw new Error('expected a number'); v = n; }
  o[k] = v; writePrivateOverrides(o);
  return v;
}
export function setPrivateRaw(k, v) { const o = readPrivateOverrides(); o[k] = v; writePrivateOverrides(o); }
