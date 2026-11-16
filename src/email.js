// Channel 1: read marketplace alert emails from the dedicated Gmail inbox (IMAP + app password).
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { ROOT } from './config.js';
import { siteOf } from './listing.js';
import { parseText } from './extract.js';
import { findVins } from './vin.js';
import { warn, log, redact, hash, isPublicHttpUrlResolved } from './util.js';

export const PROCESSED_LABEL = 'c8bot-processed';

// Per-site alert parsers: how to recognize the sender and which links are listings.
export const SITE_PARSERS = {
  autotrader: { from: /autotrader/i, listing: /autotrader\.com\/cars-for-sale\/vehicle\/(\d+)/i },
  carscom: { from: /cars\.com/i, listing: /cars\.com\/vehicledetail\/([\w-]+)/i },
  cargurus: { from: /cargurus/i, listing: /cargurus\.com\/.*(?:listing=|\/details\/|inventorylisting.*#listing=|\/link\/)(\d{6,})/i },
  carmax: { from: /carmax/i, listing: /carmax\.com\/car\/(\d+)/i },
  carvana: { from: /carvana/i, listing: /carvana\.com\/vehicle\/(\d+)/i },
  truecar: { from: /truecar/i, listing: /truecar\.com\/used-cars-for-sale\/listing\/([A-HJ-NPR-Z0-9]{17})/i },
  edmunds: { from: /edmunds/i, listing: /edmunds\.com\/.*\/vin\/([A-HJ-NPR-Z0-9]{17})/i },
  bringatrailer: { from: /bringatrailer|bring a trailer/i, listing: /bringatrailer\.com\/listing\/([\w-]+)/i },
  carsandbids: { from: /carsandbids|cars & bids/i, listing: /carsandbids\.com\/auctions\/(\w+)/i },
  chevrolet: { from: /chevrolet|gmcertified|gm certified/i, listing: /(chevrolet\.com|gmcertified\.com).*([A-HJ-NPR-Z0-9]{17})/i },
  facebook: { from: /facebook/i, listing: /facebook\.com\/marketplace\/item\/(\d+)/i },
};

export const emailConfigured = () => !!(process.env.GMAIL_ADDRESS && process.env.GMAIL_APP_PASSWORD);

/** Decode common tracking redirects that carry the destination in a query param. */
export function unwrapTracking(href) {
  try {
    const u = new URL(href);
    for (const k of ['url', 'u', 'redirect', 'redirect_url', 'target', 'dest', 'destination', 'r', 'link', 'l']) {
      const v = u.searchParams.get(k);
      if (v && /^https?:\/\//i.test(decodeURIComponent(v))) return decodeURIComponent(v);
    }
  } catch { /* ignore */ }
  return href;
}

/** Follow redirects with HEAD-like requests (no page content fetched) to find the real listing URL. */
export async function resolveRedirect(href, hops = 5) {
  let cur = href;
  for (let i = 0; i < hops; i++) {
    if (!(await isPublicHttpUrlResolved(cur))) return cur;
    let res;
    try { res = await fetch(cur, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; C8HunterBot/1.0)' } }); } catch { return cur; }
    const loc = res.headers.get('location');
    try { await res.body?.cancel(); } catch { /* ignore */ }
    if (!loc || res.status < 300 || res.status >= 400) return cur;
    cur = new URL(loc, cur).href;
  }
  return cur;
}

const isListing = (url) => Object.values(SITE_PARSERS).some((p) => p.listing.test(url)) || findVins(url).length > 0;

/**
 * Parse one alert email into listing observations + auction results.
 * Pure function apart from optional redirect resolution.
 */
export async function parseAlertEmail(mail, { resolve = resolveRedirect } = {}) {
  const from = `${mail.from?.text || ''} ${mail.subject || ''}`;
  const site = Object.entries(SITE_PARSERS).find(([, p]) => p.from.test(from))?.[0] || 'unknown';
  // add spaces at line breaks / cell ends so text from adjacent cells doesn't run together ("$54,99518,452 mi")
  const html = (mail.html || (mail.textAsHtml ?? '')).replace(/<br\s*\/?>/gi, ' ').replace(/<\/(td|th|div|p|tr|li|span|h[1-6]|a)>/gi, ' </$1>');
  const $ = cheerio.load(html || `<pre>${mail.text || ''}</pre>`);
  const byUrl = new Map();
  const anchors = $('a[href]').toArray();
  for (const a of anchors) {
    let href = $(a).attr('href') || '';
    if (!/^https?:/i.test(href)) continue;
    href = unwrapTracking(href);
    let real = href;
    if (!isListing(href)) {
      // tracking link from a known car site's email: resolve, but only links that look like listing CTAs
      const label = $(a).text().trim() + ' ' + ($(a).find('img').attr('alt') || '');
      if (site === 'unknown' || /unsubscribe|privacy|preferences|terms|help|app store|google play|facebook\.com\/(?!marketplace)|twitter|instagram/i.test(href + ' ' + label)) continue;
      if (!/\$|\bmi\b|miles|corvette|stingray|view|see (this )?(car|listing|details)/i.test(label + ' ' + blockText($, a))) continue;
      real = await resolve(href);
      if (!isListing(real)) continue;
    }
    const block = blockText($, a);
    const prev = byUrl.get(real);
    if (!prev || block.length > prev.length) byUrl.set(real, block);
  }
  // plain-text fallback
  if (!byUrl.size && mail.text) for (const m of mail.text.matchAll(/https?:\/\/\S+/g)) { const u = unwrapTracking(m[0].replace(/[)>.,]+$/, '')); if (isListing(u)) byUrl.set(u, mail.text.slice(Math.max(0, m.index - 400), m.index + 100)); }
  const listings = [], auctions = [];
  for (const [url, block] of byUrl) {
    const f = parseText(block);
    const sold = block.match(/\b(Sold|Bid) (?:for|to) (?:USD )?\$\s?([\d,]+)/i);
    if (sold && /corvette/i.test(block)) auctions.push({ title: block.slice(0, 120), year: f.year, trim: f.trim, body: f.body, miles: f.miles, price: Number(sold[2].replace(/,/g, '')), sold: /sold/i.test(sold[1]), date: (mail.date || new Date()).toISOString(), url, source: siteOf(url) });
    else listings.push({ url, site: siteOf(url), fields: { ...f, emailSnippet: block.slice(0, 600) } });
  }
  return { site, listings, auctions, subject: mail.subject || '' };
}

function blockText($, a) {
  let el = $(a), best = $(a).text();
  for (let i = 0; i < 8; i++) {
    el = el.parent(); if (!el.length) break;
    const t = el.text().replace(/\s+/g, ' ').trim();
    if (t.length > 900) break;
    best = t;
    if (/\$\s?\d/.test(t) && /\b(mi|miles)\b/i.test(t) && t.length > 60) break;
  }
  return best.replace(/\s+/g, ' ').trim();
}

/** Save a failed email sample with personal info stripped (for later debugging). */
export function saveFailedSample(kind, content) {
  const dir = path.join(ROOT, 'data', 'failed');
  fs.mkdirSync(dir, { recursive: true });
  let c = redact(String(content));
  if (process.env.GMAIL_ADDRESS) c = c.split(process.env.GMAIL_ADDRESS).join('[ALERT_INBOX]');
  c = c.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/\b(unsubscribe|token|uid|user|subscriber|email|e|s|k)=[^&"'\s]+/gi, '$1=[x]');
  const files = fs.readdirSync(dir).sort();
  while (files.length >= 20) fs.rmSync(path.join(dir, files.shift()));
  fs.writeFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}-${kind}-${hash(c, 6)}.html`), c.slice(0, 200000));
}

/** Read unread alert emails, return parsed results. Moves processed mail to the label. */
export async function readAlertInbox(db, { max = 60 } = {}) {
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: process.env.GMAIL_ADDRESS, pass: process.env.GMAIL_APP_PASSWORD }, logger: false });
  await client.connect();
  const results = [];
  try {
    const list = await client.list();
    if (!list.some((m) => m.path === PROCESSED_LABEL)) await client.mailboxCreate(PROCESSED_LABEL);
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids.slice(0, max)) {
        try {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          const mail = await simpleParser(msg.source);
          db.inc('emails');
          const parsed = await parseAlertEmail(mail);
          parsed.uid = uid;
          if (!parsed.listings.length && !parsed.auctions.length && parsed.site !== 'unknown' && !/verify|confirm|welcome|password|security|account|sign in/i.test(parsed.subject)) {
            parsed.parseFailed = true; saveFailedSample(parsed.site, mail.html || mail.text || '');
          }
          results.push(parsed);
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          await client.messageMove(String(uid), PROCESSED_LABEL, { uid: true });
        } catch (e) { warn(`email uid ${uid}: ${e.message}`); }
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
  log(`email: read ${results.length} alert emails`);
  return results;
}
