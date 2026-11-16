import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAlertEmail, unwrapTracking } from '../src/email.js';
import { isPublicHttpUrl } from '../src/util.js';
import { parseRobots, robotsAllows } from '../src/fetcher.js';
import { cleanEval, parseJsonLoose } from '../src/ai.js';

// Synthetic samples shaped like real alert emails (card per car: title, price, miles, location, link).
const card = (href, title, price, miles, loc) => `<table><tr><td><a href="${href}"><img alt="${title}"></a></td><td><a href="${href}">${title}</a><br>${price}<br>${miles}<br>${loc}</td></tr></table>`;
const mail = (from, subject, body) => ({ from: { text: from }, subject, html: `<html><body>${body}<a href="https://www.example.com/unsubscribe?u=1">Unsubscribe</a></body></html>`, date: new Date() });

test('Autotrader-style alert: two cars parsed', async () => {
  const m = mail('Autotrader <alerts@autotrader.com>', '2 new matches for your saved search',
    card('https://www.autotrader.com/cars-for-sale/vehicle/781234567?utm_source=email', '2021 Chevrolet Corvette Stingray 2LT Coupe', '$54,995', '18,452 miles', 'Smithtown, NY 11787')
    + card('https://www.autotrader.com/cars-for-sale/vehicle/781234568', '2020 Chevrolet Corvette Stingray 1LT', '$52,500', '31,200 miles', 'Hartford, CT'));
  const r = await parseAlertEmail(m, { resolve: async (x) => x });
  assert.equal(r.site, 'autotrader'); assert.equal(r.listings.length, 2);
  const a = r.listings[0].fields;
  assert.equal(a.year, 2021); assert.equal(a.trim, '2LT'); assert.equal(a.price, 54995); assert.equal(a.miles, 18452); assert.equal(a.state, 'NY');
});
test('CarGurus-style alert with tracking redirect resolved', async () => {
  const m = mail('CarGurus <noreply@cargurus.com>', 'New Corvette listings', card('https://click.cargurus.com/ls/click?upn=abc', '2022 Chevrolet Corvette Stingray 3LT Convertible', '$57,900', '12,004 mi', 'Albany, NY'));
  const r = await parseAlertEmail(m, { resolve: async () => 'https://www.cargurus.com/Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action?#listing=412345678' });
  assert.equal(r.site, 'cargurus'); assert.equal(r.listings.length, 1); assert.equal(r.listings[0].fields.body, 'convertible');
});
test('Cars.com-style alert; tracking param unwrapped without a network call', async () => {
  const href = 'https://email.cars.com/c?url=' + encodeURIComponent('https://www.cars.com/vehicledetail/abc-123/');
  assert.equal(unwrapTracking(href), 'https://www.cars.com/vehicledetail/abc-123/');
  const r = await parseAlertEmail(mail('Cars.com <alerts@cars.com>', 'Price drop', card(href, '2021 Chevrolet Corvette 1LT', '$51,250', '22,100 mi.', 'Providence, RI')), { resolve: async () => { throw new Error('should not resolve'); } });
  assert.equal(r.listings[0].url, 'https://www.cars.com/vehicledetail/abc-123/'); assert.equal(r.listings[0].fields.price, 51250);
});
test('BaT-style result email becomes an auction sold price', async () => {
  const r = await parseAlertEmail(mail('Bring a Trailer <noreply@bringatrailer.com>', 'Results', card('https://bringatrailer.com/listing/2021-chevrolet-corvette-stingray-coupe-42/', '8k-Mile 2021 Chevrolet Corvette Stingray Coupe 2LT', 'Sold for USD $61,000', '8,100 miles', '')), { resolve: async (x) => x });
  assert.equal(r.auctions.length, 1); assert.equal(r.auctions[0].price, 61000); assert.equal(r.auctions[0].sold, true);
});
test('email with no listing links from a known site is detectable as a parse failure', async () => {
  const r = await parseAlertEmail(mail('Autotrader <alerts@autotrader.com>', 'Your saved search', '<p>Nothing</p>'), { resolve: async (x) => x });
  assert.equal(r.listings.length, 0);
});

test('SSRF guard', () => {
  for (const bad of ['http://169.254.169.254/latest', 'http://localhost/x', 'http://127.0.0.1', 'https://10.1.2.3', 'https://192.168.0.1', 'file:///etc/passwd', 'http://[::1]/']) assert.equal(isPublicHttpUrl(bad), false, bad);
  assert.equal(isPublicHttpUrl('https://usedcorvettesforsale.com/x.html'), true);
});
test('robots.txt parsing', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /used-cars-for-sale/listing/*\nAllow: /used-cars-for-sale/listing/ok\n');
  assert.equal(robotsAllows(rules, '/used-cars-for-sale/listing/123'), false);
  assert.equal(robotsAllows(rules, '/used-cars-for-sale/listing/ok'), true);
  assert.equal(robotsAllows(rules, '/cars'), true);
});
test('AI answer parsing is defensive', () => {
  const j = parseJsonLoose('Here you go ```json {"scoreAdjust": 25, "options": {"Z51": {"value": true, "truth": "bogus"}}, "scamRisk": "Extreme", "perfMods": ["tune", 5]} ```');
  const c = cleanEval(j);
  assert.equal(c.scoreAdjust, 10); assert.equal(c.options.Z51.truth, 'unknown'); assert.equal(c.scamRisk, 'Low'); assert.deepEqual(c.perfMods, ['tune']);
  assert.equal(c.options.MagRide.value, null);
});

test('SSRF: IP classification incl. mapped/NAT64/6to4 and DNS-resolved blocking', async () => {
  const { isPublicIp, safeFetch } = await import('../src/util.js');
  for (const bad of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '0.0.0.0', '::7f00:1', '64:ff9b:1::7f00:1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '100::1']) assert.equal(isPublicIp(bad), false, bad);
  assert.equal(isPublicIp('8.8.8.8'), true); assert.equal(isPublicIp('2607:f8b0:4004:800::200e'), true);
  assert.equal(isPublicHttpUrl('http://2130706433/'), false);
  await assert.rejects(safeFetch('http://localtest.me/', {}, { retries: 0, timeoutMs: 5000 }));
});
