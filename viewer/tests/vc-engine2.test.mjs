import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  E2_FILTER_DEFAULT, E2_SEL_DEFAULT,
  e2FilterFromV1, e2SelFromV1, ensureE2, ensureFilter2,
  e2CssFilter, isE2FilterDefault, isE2SelDefault,
  hexToRgb, rgbToHex, srgbToOklch, oklchToSrgb,
} from '../js/vc-engine2.js';

test('e2FilterFromV1: identity v1 filter → default v2', () => {
  const f2 = e2FilterFromV1({ brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, sepia: 0, sharpness: 0 });
  assert.equal(f2.exposure, 0);
  assert.equal(f2.contrast, 0);
  assert.equal(f2.saturation, 0);
  assert.equal(f2.hueRotate, 0);
  assert.equal(f2.sepia, 0);
  assert.equal(f2.sharpness, 0);
});

test('e2FilterFromV1: brightness/contrast/saturate clamp', () => {
  const f2 = e2FilterFromV1({ brightness: 4, contrast: 100, saturate: 100 });
  assert.ok(f2.exposure <= 100);
  assert.ok(f2.contrast <= 100);
  assert.ok(f2.saturation <= 200);
  const f2b = e2FilterFromV1({ brightness: 0.001, contrast: 0.001, saturate: 0 });
  assert.ok(f2b.exposure >= -100);
  assert.ok(f2b.contrast >= -100);
  assert.ok(f2b.saturation >= -100);
});

test('e2SelFromV1: hue mode mapping', () => {
  const e2 = e2SelFromV1({ mode: 'hue', range: 40, hueShift: 10, brightness: 0.2, saturate: -0.3, contrast: 0.5, sepia: 0.1 });
  assert.equal(e2.qual.hW, 40);
  assert.equal(e2.qual.hSoft, 8);
  assert.equal(e2.qual.sC, 50);
  assert.equal(e2.qual.sW, 50);
  assert.equal(e2.qual.lC, 50);
  assert.equal(e2.qual.lW, 50);
  assert.equal(e2.mode, 'offset');
  assert.equal(e2.dH, 10);
  assert.equal(e2.dL, 20);
  assert.equal(e2.dC, -30);
  assert.equal(e2.contrast, 50);
  assert.equal(e2.sepia, 10);
});

test('e2SelFromV1: lum mode mapping', () => {
  const e2 = e2SelFromV1({ mode: 'lum', range: 90, targetLum: 0.5, hueShift: 0, brightness: 0, saturate: 0, contrast: 0, sepia: 0 });
  assert.equal(e2.qual.hW, 180);
  assert.equal(e2.qual.sC, 15);
  assert.equal(e2.qual.sW, 15);
  assert.equal(e2.qual.lC, 50);
  assert.equal(e2.qual.lW, 50);
});

test('ensureE2 is idempotent and does not mutate other fields', () => {
  const item = { id: 'a', mode: 'hue', range: 30, hueShift: 0, brightness: 0, saturate: 0, contrast: 0, sepia: 0, targetHue: 120 };
  ensureE2(item);
  assert.ok(item.e2);
  const e2Ref = item.e2;
  ensureE2(item);
  assert.equal(item.e2, e2Ref); // 冪等：不重新產生
  assert.equal(item.targetHue, 120);
});

test('ensureFilter2 idempotent, sets engine/e2Auto defaults', () => {
  const preset = { filter: { brightness: 1, contrast: 1, saturate: 1, hueRotate: 0 } };
  ensureFilter2(preset);
  assert.ok(preset.filter2);
  assert.equal(preset.engine, 1);
  assert.equal(preset.e2Auto, true);
  const f2Ref = preset.filter2;
  ensureFilter2(preset);
  assert.equal(preset.filter2, f2Ref);
});

test('e2CssFilter: default produces neutral css string', () => {
  const css = e2CssFilter(E2_FILTER_DEFAULT);
  assert.match(css, /brightness\(1\)/);
  assert.match(css, /contrast\(1\)/);
  assert.match(css, /saturate\(1\)/);
  assert.match(css, /hue-rotate\(0deg\)/);
  assert.match(css, /sepia\(0%\)/);
  assert.doesNotMatch(css, /blur/);
});

test('e2CssFilter: sharpness<0 adds blur like v1', () => {
  const css = e2CssFilter({ ...E2_FILTER_DEFAULT, sharpness: -4 });
  assert.match(css, /blur\(2\.0px\)/);
});

test('e2CssFilter: contrast negative branch', () => {
  const css = e2CssFilter({ ...E2_FILTER_DEFAULT, contrast: -50 });
  assert.match(css, /contrast\(0\.5\)/);
});

test('isE2FilterDefault / isE2SelDefault', () => {
  assert.equal(isE2FilterDefault(E2_FILTER_DEFAULT), true);
  assert.equal(isE2FilterDefault({ ...E2_FILTER_DEFAULT, exposure: 5 }), false);
  assert.equal(isE2SelDefault(E2_SEL_DEFAULT), true);
  assert.equal(isE2SelDefault({ ...E2_SEL_DEFAULT, dH: 5 }), false);
  assert.equal(isE2SelDefault([]), true);
  assert.equal(isE2SelDefault([{ ...E2_SEL_DEFAULT }]), true);
});

test('hexToRgb / rgbToHex round trip', () => {
  assert.deepEqual(hexToRgb('#2E8B57'), [46, 139, 87]);
  assert.equal(rgbToHex([46, 139, 87]), '#2e8b57');
  assert.equal(rgbToHex(hexToRgb('#FFFFFF')), '#ffffff');
  assert.equal(rgbToHex(hexToRgb('#000000')), '#000000');
});

test('OKLCH round trip error < 1e-3', () => {
  const hexes = ['#2E8B57', '#000000', '#FFFFFF', '#FF0000'];
  for (const hex of hexes) {
    const rgb01 = hexToRgb(hex).map(v => v / 255);
    const lch = srgbToOklch(rgb01);
    const back = oklchToSrgb(lch);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(back[i] - rgb01[i]) < 1e-3,
        `${hex} channel ${i}: ${back[i]} vs ${rgb01[i]}`);
    }
  }
});

test('srgbToOklch: black L=0, white L=1', () => {
  const black = srgbToOklch([0, 0, 0]);
  assert.ok(Math.abs(black.L) < 1e-6);
  const white = srgbToOklch([1, 1, 1]);
  assert.ok(Math.abs(white.L - 1) < 1e-3);
});
