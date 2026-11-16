// VIN utilities: check digit, quick C8 pattern decode (offline), extraction from text.
const TRANSLIT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const YEAR_CODES = { L: 2020, M: 2021, N: 2022, P: 2023, R: 2024, S: 2025, T: 2026, V: 2027, W: 2028, X: 2029, Y: 2030 };

export function normalizeVin(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

export function vinCheckDigit(vin) {
  vin = normalizeVin(vin);
  if (vin.length !== 17 || /[IOQ]/.test(vin)) return null;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const val = /\d/.test(ch) ? Number(ch) : TRANSLIT[ch];
    if (val === undefined) return null;
    sum += val * WEIGHTS[i];
  }
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

/** true = valid, false = invalid check digit / malformed */
export function isValidVin(vin) {
  vin = normalizeVin(vin);
  const cd = vinCheckDigit(vin);
  return cd !== null && vin[8] === cd;
}

/** Offline decode of a Corvette C8 VIN pattern (verified against NHTSA vPIC 2026-11-16). */
export function quickDecode(vin) {
  vin = normalizeVin(vin);
  if (vin.length !== 17) return null;
  const out = { isCorvette: vin.startsWith('1G1Y'), year: YEAR_CODES[vin[9]] || null, body: null, trim: null, variant: null };
  if (!out.isCorvette) return out;
  out.body = vin[5] === '2' ? 'coupe' : vin[5] === '3' ? 'convertible' : null;
  const p5 = vin[4], p8 = vin[7];
  // 2020 used 6/7/8 for 1LT/2LT/3LT; 2021+ use A/B/C (verified with NHTSA vPIC 2026-11-16)
  if (p8 === '4' && 'ABC678'.includes(p5)) { out.variant = 'Stingray'; out.trim = { A: '1LT', B: '2LT', C: '3LT', 6: '1LT', 7: '2LT', 8: '3LT' }[p5]; }
  else if (p8 === '3') out.variant = 'Z06';
  else out.variant = 'other';
  return out;
}

/** Find candidate VINs in arbitrary text; returns valid ones first. */
export function findVins(text) {
  const found = new Set();
  const re = /\b([A-HJ-NPR-Z0-9]{17})\b/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const v = m[1].toUpperCase();
    if (/[A-Z]/.test(v) && /\d/.test(v)) found.add(v);
  }
  return [...found].sort((a, b) => Number(isValidVin(b)) - Number(isValidVin(a)));
}
