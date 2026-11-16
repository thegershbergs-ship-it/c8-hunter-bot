// Single-file JSON database stored in the repo (data/db.json). Saved after every run.
// PRIVACY: never store distance-from-home, monthly payments, chat ids or anything about the owner here.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from './config.js';
import { nowIso, todayKey, daysBetween } from './util.js';

export const DB_PATH = path.join(ROOT, 'data', 'db.json');

const EMPTY = () => ({
  version: 1,
  listings: {},          // id -> listing
  auctions: [],          // sold/bid-to results pasted or from emails {title, year, trim, miles, price, sold, date, url, source}
  alertsSent: [],        // {id, at, kind, cls, score, price, reason}
  actions: [],           // {at, type, id, value}
  sources: {},           // name -> {lastSuccess, lastError, lastErrorAt, failCount, status, lastTest, degraded}
  usage: {},             // date -> counters
  telegram: { offset: 0, awaiting: null, lastChatName: null },
  queue: { fullCheck: [], deepDive: [], draft: [], checklist: [], links: [], questions: [], sweepRequested: false },
  cache: { vin: {}, recalls: {} },
  notices: {},           // dedupe of system messages: key -> {at, state}
  meta: { created: nowIso(), lastRun: {}, runLog: [] },
});

export class DB {
  constructor(data) { this.d = data; }
  static load(p = DB_PATH) {
    if (!fs.existsSync(p)) return new DB(EMPTY());
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const e = EMPTY();
    for (const k of Object.keys(e)) if (d[k] === undefined) d[k] = e[k];
    for (const k of Object.keys(e.queue)) if (d.queue[k] === undefined) d.queue[k] = e.queue[k];
    return new DB(d);
  }
  save(p = DB_PATH) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.d, null, 1));
    fs.renameSync(tmp, p);
  }

  // ---- listings ----
  get listings() { return Object.values(this.d.listings); }
  get(id) { return this.d.listings[id]; }
  put(l) { this.d.listings[l.id] = l; return l; }
  active() { return this.listings.filter((l) => l.status === 'active'); }

  // ---- usage counters (per Eastern date) ----
  usage(day = todayKey()) { return (this.d.usage[day] ||= { claude: 0, gemini: 0, emails: 0, pages: 0, questions: 0, telegramSent: 0, nhtsa: 0 }); }
  inc(counter, n = 1) { const u = this.usage(); u[counter] = (u[counter] || 0) + n; return u[counter]; }

  // ---- source health ----
  sourceOk(name, info = {}) {
    const s = (this.d.sources[name] ||= { failCount: 0, status: 'OK' });
    const recovered = s.status === 'DOWN';
    Object.assign(s, { lastSuccess: nowIso(), failCount: 0, status: s.degraded ? 'DEGRADED' : 'OK', ...info });
    return { recovered };
  }
  sourceFail(name, err) {
    const s = (this.d.sources[name] ||= { failCount: 0, status: 'OK' });
    s.failCount = (s.failCount || 0) + 1; s.lastError = String(err).slice(0, 300); s.lastErrorAt = nowIso();
    const wentDown = s.failCount >= 3 && s.status !== 'DOWN';
    if (s.failCount >= 3) s.status = 'DOWN';
    return { wentDown };
  }
  sourceShouldRun(name) {
    const s = this.d.sources[name];
    if (!s || s.status !== 'DOWN') return true;
    if (!s.lastTest || daysBetween(s.lastTest) >= 1) { s.lastTest = nowIso(); return true; } // one daily test while DOWN
    return false;
  }

  // ---- notices: send each system message once per state change ----
  noticeChanged(key, state) {
    const n = this.d.notices[key];
    if (n && n.state === state) return false;
    this.d.notices[key] = { at: nowIso(), state };
    return true;
  }

  action(type, id, value) { this.d.actions.push({ at: nowIso(), type, id, value }); }

  /** Move listings unseen for > N days into a compressed archive file (kept as price history). */
  archiveOld(days = 180) {
    const old = this.listings.filter((l) => l.status !== 'active' && daysBetween(l.lastSeen || l.firstSeen) > days);
    if (!old.length) return 0;
    const f = path.join(ROOT, 'data', 'archive.jsonl.gz');
    const prev = fs.existsSync(f) ? zlib.gunzipSync(fs.readFileSync(f)).toString('utf8') : '';
    fs.writeFileSync(f, zlib.gzipSync(prev + old.map((l) => JSON.stringify(l)).join('\n') + '\n'));
    for (const l of old) delete this.d.listings[l.id];
    return old.length;
  }
  /** Archived listings (for comparables). */
  static archived() {
    const f = path.join(ROOT, 'data', 'archive.jsonl.gz');
    if (!fs.existsSync(f)) return [];
    return zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
  }
}
