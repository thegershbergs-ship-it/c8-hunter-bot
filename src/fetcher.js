// Channel 2: polite, robots.txt-respecting fetch of ONE listing page at a time.
// Policy per site comes from settings.yaml (never | on_request | auto).
import { siteOf } from './listing.js';
import { sleep, fetchRetry } from './util.js';

const robotsCache = new Map();
const lastHit = new Map();
const pageCache = new Map();

export function parseRobots(txt, agent = 'c8hunterbot') {
  const groups = []; let cur = null;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const [k, ...rest] = line.split(':'); const v = rest.join(':').trim(); const key = k.toLowerCase();
    if (key === 'user-agent') { if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); }
    else if ((key === 'disallow' || key === 'allow') && cur) cur.rules.push({ allow: key === 'allow', path: v });
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && agent.includes(a))) || groups.find((g) => g.agents.includes('*'));
  return mine ? mine.rules : [];
}
export function robotsAllows(rules, pathAndQuery) {
  let best = null;
  for (const r of rules) {
    if (!r.path) continue;
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(pathAndQuery) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

async function robotsFor(origin, ua) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let rules = null; // null = robots unreachable -> treat as "not allowed" (unclear = don't automate)
  try {
    const r = await fetchRetry(origin + '/robots.txt', { headers: { 'user-agent': ua } }, { retries: 1, timeoutMs: 15000 });
    if (r.status === 404) rules = [];
    else if (r.ok) rules = parseRobots(await r.text());
  } catch { /* unreachable */ }
  robotsCache.set(origin, rules);
  return rules;
}

/**
 * Fetch a listing page if policy allows. mode: 'auto' (scheduled) or 'request' (user asked).
 * Returns {ok, html, status, reason}.
 */
export async function politeFetch(url, s, db, { mode = 'auto' } = {}) {
  const site = siteOf(url);
  const policy = s.sites[site]?.fetch || s.sites.dealer.fetch;
  if (policy === 'never') return { ok: false, reason: `${site} does not allow bots (terms/robots), so it is never fetched` };
  if (policy === 'on_request' && mode !== 'request') return { ok: false, reason: 'only fetched when you ask (Full check)' };
  if (db.usage().pages >= s.fetch.max_pages_per_run * 6) return { ok: false, reason: 'daily page budget reached' };
  if (pageCache.has(url)) return pageCache.get(url);
  const u = new URL(url);
  const ua = s.fetch.user_agent;
  const rules = await robotsFor(u.origin, ua);
  if (rules === null) return { ok: false, reason: `${u.hostname} robots.txt unreachable (blocked to bots), so not fetching` };
  if (!robotsAllows(rules, u.pathname + u.search)) return { ok: false, reason: `robots.txt disallows ${u.pathname}` };
  const wait = s.fetch.min_seconds_between_requests_same_site * 1000 - (Date.now() - (lastHit.get(u.hostname) || 0));
  if (wait > 0) await sleep(wait);
  lastHit.set(u.hostname, Date.now());
  db.inc('pages');
  let res;
  try { res = await fetchRetry(url, { headers: { 'user-agent': ua, accept: 'text/html' }, redirect: 'follow' }, { retries: 2, timeoutMs: 30000 }); }
  catch (e) { return { ok: false, reason: 'network error: ' + e.message }; }
  const html = await res.text();
  const blocked = res.status === 403 || res.status === 429 || /captcha|access denied|page unavailable|akamai-block|are you a robot|px-captcha|cf-chl/i.test(html.slice(0, 5000));
  const out = blocked ? { ok: false, status: res.status, reason: `${site} blocked the bot (HTTP ${res.status}); paste the listing text instead` }
    : res.status === 404 || res.status === 410 ? { ok: false, status: res.status, gone: true, reason: 'listing page is gone (likely sold)' }
    : !res.ok ? { ok: false, status: res.status, reason: 'HTTP ' + res.status } : { ok: true, html, status: res.status, finalUrl: res.url };
  pageCache.set(url, out);
  return out;
}
