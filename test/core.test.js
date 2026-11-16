import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidVin, vinCheckDigit, quickDecode, findVins } from '../src/vin.js';
import { hardFilter, monthlyPayment, textRedFlags, positiveMention, transportEstimate } from '../src/rules.js';
import { drivingMiles, zipToLatLon } from '../src/geo.js';
import { DB } from '../src/db.js';
import { upsertObservation, canonicalUrl, siteOf } from '../src/listing.js';
import { scoreListing, classify } from '../src/score.js';
import { parseText } from '../src/extract.js';
import { settings } from '../src/config.js';
import { fairValue } from '../src/market.js';
import { negotiationBrief } from '../src/negotiate.js';

const s = settings();
const fresh = () => new DB(JSON.parse(JSON.stringify({ version: 1, listings: {}, auctions: [], alertsSent: [], actions: [], sources: {}, usage: {}, telegram: { offset: 0 }, queue: { fullCheck: [], deepDive: [], draft: [], checklist: [], links: [], questions: [] }, cache: { vin: {}, recalls: {} }, notices: {}, meta: { lastRun: {} } })));

test('VIN check digit: real valid VINs', () => {
  // Real VINs: published C8 listing (1G1YC2D43R5111928) and NHTSA's documented example (1HGCM82633A004352).
  assert.equal(isValidVin('1G1YC2D43R5111928'), true);
  assert.equal(isValidVin('1HGCM82633A004352'), true);
  assert.equal(isValidVin('11111111111111111'), true); // all-ones is mathematically valid (check digit 1)
});
test('VIN check digit: invalid/malformed', () => {
  assert.equal(isValidVin('1G1YC2D44R5111928'), false); // check digit altered
  assert.equal(isValidVin('1G1YC2D43R511192'), false);  // 16 chars
  assert.equal(isValidVin('1G1YC2D43R51119O8'), false); // contains O
  assert.equal(vinCheckDigit('1G1YC2D40R5111928'), '3');
});
test('quickDecode C8 patterns', () => {
  const d = quickDecode('1G1YC2D43R5111928');
  assert.deepEqual([d.year, d.trim, d.body, d.variant], [2024, '3LT', 'coupe', 'Stingray']);
  assert.equal(quickDecode('1G1YD2D31P5600001').variant, 'Z06');
  assert.equal(quickDecode('1G1YB3D40M5100001').body, 'convertible');
  assert.equal(quickDecode('1G1Y62D45L5111573').trim, '1LT'); assert.equal(quickDecode('1G1Y82D47L5118051').trim, '3LT');
  assert.equal(isValidVin('1G1Y62D45L5111573'), true); assert.equal(isValidVin('1G1YB2D49M5114862'), true); assert.equal(isValidVin('1G1YC3D4XN5115006'), true);
});
test('findVins prefers valid VINs', () => {
  assert.equal(findVins('VIN: 1G1YC2D44R5111928 or 1G1YC2D43R5111928')[0], '1G1YC2D43R5111928');
});

const base = { model: 'Corvette', year: 2021, price: 54000, miles: 20000 };
test('hard filters', () => {
  assert.equal(hardFilter(base, s).pass, true);
  assert.equal(hardFilter({ ...base, year: 2019 }, s).pass, false);
  assert.equal(hardFilter({ ...base, price: 58600 }, s).pass, false);
  assert.equal(hardFilter({ ...base, price: 58000 }, s).overBudget, 500);
  assert.equal(hardFilter({ ...base, miles: 50000 }, s).pass, false);
  assert.equal(hardFilter(base, s, { distance: 800 }).pass, false);
  assert.equal(hardFilter(base, s, { distance: 700 }).pass, true);
  assert.equal(hardFilter({ ...base, description: 'Rebuilt title, runs great' }, s).pass, false);
  assert.equal(hardFilter({ ...base, description: 'Clean title, never flooded, no tune, no accidents' }, s).pass, true);
  assert.equal(hardFilter({ ...base, description: 'E85 tune with cold air intake' }, s).pass, false);
  assert.equal(hardFilter({ ...base, description: 'airbags deployed in 2023' }, s).pass, false);
  assert.equal(hardFilter({ ...base, model: 'Camaro' }, s).pass, false);
});
test('negation-aware red flags', () => {
  assert.equal(positiveMention('no supercharger here', /supercharg(ed|er)/i), null);
  assert.ok(textRedFlags('Lemon buyback').length);
  assert.equal(textRedFlags('Not a lemon buyback, never salvage').length, 0);
});

test('distance: Philadelphia to Manhattan ~ 100 mi est. driving', () => {
  assert.ok(zipToLatLon('19103'));
  const d = drivingMiles('19103', '10001', 1.2);
  assert.ok(d > 85 && d < 115, String(d));
  assert.equal(drivingMiles('19103', '99999'), null);
});
test('monthly payment', () => {
  // $54,000 - $10,000 down at 7.5% for 72 months ≈ $760.75
  assert.ok(Math.abs(monthlyPayment(54000, { apr_pct: 7.5, down_payment: 10000, months: 72 }) - 760.75) < 1);
  assert.equal(Math.round(monthlyPayment(46000, { apr_pct: 0, down_payment: 10000, months: 72 })), 500);
  assert.equal(monthlyPayment(9000, { apr_pct: 7.5, down_payment: 10000, months: 72 }), 0);
});
test('transport estimate', () => {
  const t = transportEstimate(600, s.transport);
  assert.equal(Math.round(t.open), 450); assert.equal(Math.round(t.enclosed), 690);
});

test('dedupe: VIN, link, close match; price history; odometer decrease', () => {
  const db = fresh();
  const a = upsertObservation(db, { vin: '1G1YC2D43R5111928', price: 56000, miles: 12000 }, { url: 'https://www.cars.com/vehicledetail/1/?utm_source=x', source: 'email:carscom' });
  assert.equal(a.isNew, true);
  const b = upsertObservation(db, { vin: '1G1YC2D43R5111928', price: 55000, miles: 12000 }, { url: 'https://www.autotrader.com/cars-for-sale/vehicle/2', source: 'email:autotrader' });
  assert.equal(b.isNew, false); assert.equal(db.listings.length, 1);
  assert.equal(b.listing.links.length, 2); assert.equal(b.listing.price, 55000);
  const c = upsertObservation(db, { price: 54500 }, { url: 'https://www.cars.com/vehicledetail/1/' });
  assert.equal(c.isNew, false); assert.equal(c.listing.priceHistory.length, 3);
  const d = upsertObservation(db, { vin: '1G1YC2D43R5111928', miles: 9000 }, { url: 'https://dealer.example/x' });
  assert.ok(d.changes.includes('mileage DECREASED'));
  // close match without VIN
  upsertObservation(db, { year: 2021, trim: '2LT', miles: 20000, city: 'Boston', price: 53000, extColorName: 'Torch Red' }, { url: 'https://a.example/1' });
  const e = upsertObservation(db, { year: 2021, trim: '2LT', miles: 20050, city: 'Boston', price: 52000, extColorName: 'Torch Red' }, { url: 'https://b.example/2' });
  assert.equal(e.isNew, false);
  assert.equal(db.listings.length, 2);
});
test('canonical url & site detection', () => {
  assert.equal(canonicalUrl('https://www.cargurus.com/x?utm_source=a&id=5#top'), 'https://www.cargurus.com/x?id=5');
  assert.equal(siteOf('https://www.facebook.com/marketplace/item/1'), 'facebook');
  assert.equal(siteOf('https://www.someChevyDealer.com/used/1'), 'dealer');
});

test('parseText pulls fields from an alert snippet', () => {
  const p = parseText('2021 Chevrolet Corvette Stingray 2LT Coupe · 18,452 mi · $54,995 · Torch Red · Exterior: Torch Red, Interior: Jet Black · Z51, front lift · Smithtown, NY 11787 · One owner');
  assert.equal(p.year, 2021); assert.equal(p.trim, '2LT'); assert.equal(p.body, 'coupe');
  assert.equal(p.miles, 18452); assert.equal(p.price, 54995); assert.equal(p.state, 'NY'); assert.equal(p.zip, '11787');
  assert.equal(p.optionClaims.Z51, true); assert.equal(p.optionClaims.FrontLift, true); assert.equal(p.ownersClaim, 1);
  assert.match(p.extColorName, /Torch Red/);
});

function scored(l, extra = {}) {
  const ev = scoreListing(l, { s, fv: extra.fv ?? { mid: 56000, low: 54000, high: 58000, enough: true, comps: [] }, distance: extra.distance ?? 200 });
  return { ev, c: classify(ev, l, s, extra.ai || 0) };
}
const great = () => ({
  id: 'x', vin: '1G1YC2D43R5111928', vinValid: true, year: 2021, variant: 'Stingray', trim: '3LT', body: 'coupe', price: 51000, miles: 8000, extColor: 'red', intColor: 'black',
  sellerType: 'franchise', sellerName: 'Best Chevrolet', optionClaims: {}, links: [], photos: Array(20).fill('p'), mileageHistory: [{ miles: 8000 }, { miles: 8000 }],
  reportFacts: { owners: 1, accidents: 0, titleClean: true, serviceRecords: 6 }, historyReportUrl: 'x', description: 'One owner, dealer serviced, all records',
  aiFindings: { analyzed: true, warningLights: false, trackUse: false, perfMods: [], options: { Z51: { value: true, truth: 'verified' }, MagRide: { value: true, truth: 'verified' }, FrontLift: { value: true, truth: 'verified' }, Seats: { value: 'GT2', truth: 'verified' } } },
  history: { serious: [], mismatches: [], checks: { title: { value: 'No title brands on report', truth: 'verified' }, accidents: { value: 'No accidents reported on the report', truth: 'verified' }, odometer: { value: 'Consistent across 2 observations', truth: 'verified' } } },
});
test('scoring: an excellent verified car is Exceptional', () => {
  const { ev, c } = scored(great());
  assert.ok(ev.ruleScore >= 85, JSON.stringify(ev.breakdown) + ev.ruleScore);
  assert.equal(ev.confidence, 'High'); assert.equal(c.cls, 'Exceptional');
});
test('scoring: a red flag forces Reject regardless of score', () => {
  const l = great(); l.history.serious = ['Odometer inconsistency: mileage went down'];
  assert.equal(scored(l).c.cls, 'Reject');
  const l2 = great(); l2.aiFindings.perfMods = ['aftermarket supercharger'];
  assert.equal(scored(l2).c.cls, 'Reject');
});
test('scoring: High scam risk forces Reject', () => {
  const l = great(); l.description = 'I am deployed overseas, payment by gift cards only';
  const { ev, c } = scored(l);
  assert.equal(ev.scam.level, 'High'); assert.equal(c.cls, 'Reject');
});
test('scoring: no VIN caps at Watchlist; unknowns lower confidence', () => {
  const l = great(); l.vin = null; l.vinValid = null;
  const { c } = scored(l); assert.equal(c.cls, 'Watchlist');
  const bare = { id: 'y', year: 2021, price: 54000, miles: 20000, links: [], optionClaims: {} };
  assert.equal(scored(bare, { fv: null, distance: null }).ev.confidence, 'Low');
});
test('scoring: over budget only allowed when exceptional, labeled', () => {
  const l = great(); l.price = 58000;
  const { c } = scored(l, { fv: { mid: 62000, low: 60000, high: 64000, enough: true, comps: [] } });
  if (c.cls === 'Exceptional') assert.ok(c.notes.some((n) => /NEEDS YOUR APPROVAL/.test(n)));
  else assert.equal(c.cls, 'Reject');
});
test('fair value: not enough data path, and with comparables', () => {
  const db = fresh();
  const l = { id: 't', year: 2021, trim: '2LT', body: 'coupe', miles: 20000, price: 55000 };
  assert.equal(fairValue(db, l, s).enough, false);
  for (let i = 0; i < 6; i++) db.put({ id: 'c' + i, year: 2021, trim: '2LT', body: 'coupe', variant: 'Stingray', miles: 15000 + i * 2000, price: 54000 + i * 500, lastSeen: new Date().toISOString(), links: [{ url: 'https://ex/' + i }] });
  const fv = fairValue(db, l, s);
  assert.equal(fv.enough, true); assert.ok(fv.low < fv.high); assert.ok(fv.comps.every((c) => c.url));
  const nb = negotiationBrief({ ...l, priceHistory: [{ at: new Date().toISOString(), price: 55000 }], firstSeen: new Date().toISOString() }, { fv, distance: 300, s });
  assert.ok(nb.opening <= nb.target && nb.target <= nb.walk);
});
