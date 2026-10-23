'use strict';
/* ── vc-engine2.js  ▸  Engine 2（OKLCH 選色濾鏡）純函式資料層 ──────────
   純函式模組：不得 import DOM 或其他 viewer 模組，必須能在 node 直接 import。
   SSOT: .ai-core/tasks/eagle-viewer-filter-engine2/references/engine2-spec.md §1
══════════════════════════════════════════════════════════════════════*/

export const E2_FILTER_DEFAULT = Object.freeze({
  exposure: 0, contrast: 0, saturation: 0, vibrance: 0,
  hueRotate: 0, sepia: 0, sharpness: 0,
});

export const E2_SEL_DEFAULT = Object.freeze({
  mode: 'offset',
  qual: Object.freeze({ hW: 30, hSoft: 6, sC: 50, sW: 50, sSoft: 10, lC: 50, lW: 50, lSoft: 10 }),
  target: Object.freeze({ hex: '#2E8B57', strength: 100, keepL: 100 }),
  dH: 0, dC: 0, dL: 0,
  contrast: 0,
  vibrance: 0,
  sepia: 0,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ══════════════════════════════════════════════════════════════════
   v1 → v2 換算
══════════════════════════════════════════════════════════════════ */
export function e2FilterFromV1(f) {
  const b = f.brightness ?? 1;
  const c = f.contrast   ?? 1;
  const s = f.saturate   ?? 1;
  const exposure   = clamp(50 * Math.log2(b), -100, 100);
  const contrast   = clamp(c >= 1 ? 100 * (1 - 1 / c) : 100 * (c - 1), -100, 100);
  const saturation = clamp(100 * (s - 1), -100, 200);
  return {
    exposure, contrast, saturation,
    vibrance:  0,
    hueRotate: f.hueRotate ?? 0,
    sepia:     f.sepia ?? 0,
    sharpness: f.sharpness ?? 0,
  };
}

export function e2SelFromV1(item) {
  const e2 = { ...E2_SEL_DEFAULT, qual: { ...E2_SEL_DEFAULT.qual }, target: { ...E2_SEL_DEFAULT.target } };
  if (item?.mode === 'lum') {
    const targetLum = item.targetLum ?? 0;
    const range = item.range ?? 30;
    e2.qual.hW = 180;
    e2.qual.sC = 15; e2.qual.sW = 15;
    e2.qual.lC = targetLum * 100;
    e2.qual.lW = (range / 180) * 100;
  } else {
    const range = item.range ?? 30;
    e2.qual.hW = range;
    e2.qual.hSoft = 0.2 * range;
    e2.qual.sC = 50; e2.qual.sW = 50; e2.qual.sSoft = 0;
    e2.qual.lC = 50; e2.qual.lW = 50; e2.qual.lSoft = 0;
  }
  e2.mode     = 'offset';
  e2.dH       = item?.hueShift  ?? 0;
  e2.dL       = (item?.brightness ?? 0) * 100;
  e2.dC       = (item?.saturate   ?? 0) * 100;
  e2.contrast = (item?.contrast   ?? 0) * 100;
  e2.sepia    = (item?.sepia      ?? 0) * 100;
  return e2;
}

export function ensureE2(item) {
  if (item && !item.e2) item.e2 = e2SelFromV1(item);
  return item;
}

export function ensureFilter2(preset) {
  if (!preset) return preset;
  if (!preset.filter2) preset.filter2 = e2FilterFromV1(preset.filter || {});
  if (preset.engine == null) preset.engine = 1;
  if (preset.e2Auto == null) preset.e2Auto = true;
  return preset;
}

/* ══════════════════════════════════════════════════════════════════
   CSS filter 字串（engine 2）
══════════════════════════════════════════════════════════════════ */
export function e2CssFilter(f2) {
  const f = { ...E2_FILTER_DEFAULT, ...f2 };
  const brightness = Math.pow(2, f.exposure / 50);
  const c = f.contrast / 100;
  const contrast = c > 0 ? 1 / (1 - 0.99 * c) : 1 + c;
  const saturate = 1 + f.saturation / 100;
  const blurPx = f.sharpness < 0 ? Math.abs(f.sharpness) * 0.5 : 0;
  const parts = [
    `brightness(${brightness})`,
    `contrast(${contrast})`,
    `saturate(${saturate})`,
    `hue-rotate(${f.hueRotate}deg)`,
    `sepia(${f.sepia ?? 0}%)`,
  ];
  if (blurPx > 0) parts.push(`blur(${blurPx.toFixed(1)}px)`);
  return parts.join(' ');
}

export function isE2FilterDefault(f2) {
  if (!f2) return true;
  return f2.exposure === 0 && f2.contrast === 0 && f2.saturation === 0 &&
         !f2.vibrance && f2.hueRotate === 0 && !f2.sepia && !f2.sharpness;
}

export function isE2SelDefault(e2) {
  if (Array.isArray(e2)) return e2.length === 0 || e2.every(isE2SelDefault);
  if (!e2) return true;
  const d = E2_SEL_DEFAULT;
  return e2.mode === d.mode
    && e2.dH === d.dH && e2.dC === d.dC && e2.dL === d.dL
    && !e2.contrast && !e2.vibrance && !e2.sepia
    && (e2.target?.hex ?? d.target.hex) === d.target.hex
    && (e2.target?.strength ?? d.target.strength) === d.target.strength
    && (e2.target?.keepL ?? d.target.keepL) === d.target.keepL;
}

/* ══════════════════════════════════════════════════════════════════
   色彩轉換：HEX ↔ RGB ↔ OKLCH
══════════════════════════════════════════════════════════════════ */
export function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(rgb) {
  const c = rgb.map(v => clamp(Math.round(v), 0, 255));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}

function _srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function _linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
const _cbrt = (x) => Math.sign(x) * Math.pow(Math.abs(x), 1 / 3);

/** srgbToOklch([r,g,b] 0..1) → {L 0..1, C 0..0.4, h deg} */
export function srgbToOklch(rgbIn) {
  const [r, g, b] = rgbIn.map(_srgbToLinear);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = _cbrt(l), m_ = _cbrt(m), s_ = _cbrt(s);
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  const C = Math.sqrt(a * a + bb * bb);
  let h = Math.atan2(bb, a) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

/** oklchToSrgb({L,C,h}) → [r,g,b] 0..1 clamp */
export function oklchToSrgb({ L, C, h }) {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const bb = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * bb;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [r, g, b].map(v => clamp(_linearToSrgb(v), 0, 1));
}
