// Negotiation brief built ONLY from real evidence. Never invents leverage.
import { positionInRange } from './market.js';
import { transportEstimate } from './rules.js';
import { daysBetween, money } from './util.js';

export function negotiationBrief(l, { fv, distance, s }) {
  const price = l.price;
  const ph = l.priceHistory || [];
  const firstSeen = l.firstSeen;
  const dom = l.marketSignals?.daysOnMarket ?? Math.round(daysBetween(firstSeen));
  const domSource = l.marketSignals?.daysOnMarket != null ? `${l.marketSignals.source || 'site'} shows` : 'bot first saw it';
  const drops = ph.filter((x, i) => i > 0 && x.price < ph[i - 1].price).map((x, i) => ({ at: x.at.slice(0, 10), from: ph[ph.indexOf(x) - 1].price, to: x.price }));
  const points = [];
  const pos = fv?.mid && price ? positionInRange(price, fv) : null;
  const cheaper = (fv?.comps || []).filter((c) => c.adjusted < price).sort((a, b) => a.adjusted - b.adjusted).slice(0, 2);
  for (const c of cheaper) points.push(`Comparable ${c.title}, ${c.miles?.toLocaleString()} mi at ${money(c.price)} (≈${money(c.adjusted)} adjusted to this car): ${c.url || ''}`.trim());
  if (dom >= 30) points.push(`On the market ~${dom} days (${domSource}). Longer listings usually have room.`);
  if (drops.length) points.push(`Already dropped ${drops.length}× (last ${money(drops.at(-1).from)}→${money(drops.at(-1).to)} on ${drops.at(-1).at}): seller is motivated.`);
  if (!l.reportFacts?.serviceRecords && !/records/i.test(l.description || '')) points.push('No service records shown. Ask for them; missing records justify a lower price (DCT fluid service matters).');
  const ai = l.aiFindings || {};
  if (ai.tiresWorn) points.push(`Photos suggest worn tires (${ai.tiresWorn}). A C8 set runs ~$1,500–2,000.`);
  for (const f of ai.cosmeticFlaws || []) points.push(`Visible flaw in photos: ${f}`);
  if (l.miles > 20000 && l.year) points.push('Check whether the first DCT fluid/filter service has been done; if not, ask the seller to do it or reduce the price.');
  const tr = transportEstimate(distance, s.transport);
  if (tr && distance > 150) points.push(`Distance: shipping ≈ ${money(tr.open)} open / ${money(tr.enclosed)} enclosed (rough estimate). Factor that into the price.`);

  let opening = null, target = null, walk = null, reasoning = [];
  if (price) {
    if (fv?.mid) {
      const lowEnd = fv.low;
      target = Math.round(Math.min(price, (fv.mid + fv.low) / 2) / 250) * 250;
      opening = Math.round(Math.min(price * 0.97, lowEnd * 0.98) / 250) * 250;
      walk = Math.round(Math.min(price, fv.high) / 250) * 250;
      reasoning.push(`Fair range ${money(fv.low)}–${money(fv.high)}${fv.enough ? '' : ' (thin data, treat loosely)'}; asking sits at ${pos != null ? pos + '%' : '?'} of the range.`);
    } else {
      opening = Math.round((price * 0.95) / 250) * 250; target = Math.round((price * 0.97) / 250) * 250; walk = price;
      reasoning.push('No reliable fair value yet, so these are generic 3–5% asks.');
    }
    if (dom >= 45 || drops.length >= 2) { opening = Math.round((opening * 0.99) / 250) * 250; reasoning.push('Time on market supports a slightly lower open.'); }
  }
  const flexibility = dom >= 30 || drops.length || cheaper.length || (pos != null && pos > 50);
  return {
    dom, domSource, drops, positionPct: pos, opening, target, walk, reasoning: reasoning.join(' '), points: points.slice(0, 5),
    noEvidence: !flexibility ? 'No real evidence of price flexibility yet. If it is a great car, a clean offer near asking may be the right move.' : null,
    dealerTips: (l.sellerType || '') !== 'private' ? ['Negotiate the OUT-THE-DOOR price, not the monthly payment', 'Refuse add-ons (protection packages, nitrogen, etching)', 'Bring your own financing pre-approval to compare against the dealer rate'] : [],
    transport: tr,
  };
}
