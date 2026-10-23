---
created: 2026-08-23
topic: colorbalancergb-colorzones-lift-gamma-gain
slug: darktable
source_url: https://github.com/darktable-org/darktable
content_provenance: external_fetched
---

# darktable 深讀：colorbalancergb / colorzones / lift-gamma-gain（source: `.cache/code`, HEAD 08217c2, master, sparse-checkout `src/iop`）

## 1. Lift-Gamma-Gain 標準公式（`src/iop/colorbalance.c:365-395`）

```c
static void _process_lgg(...)
{
  for(size_t k = 0; k < npixels; k++)
  {
    // Lab -> XYZ -> sRGB
    for_each_channel(c)
    {
      // lift gamma gain - apply lift and gain
      rgb[c] = ((( rgb[c] - one[c]) * lift[c]) + one[c]) * gain[c];
    }
    dt_vector_max(rgb, rgb, zero);          // 先 clip 負值，pow 才安全
    dt_vector_powf(rgb, gamma_inv, rgb);    // lift gamma gain - apply gamma
    // sRGB -> XYZ -> Lab
  }
}
```

**公式本質**：`out = pow(max((rgb - 1) * lift + 1, 0), 1/gamma) * ` — 注意 gain 是先乘在 lift 步驟內（`* gain[c]` 在 lift 公式尾端），gamma 是最後一步單獨的 `pow`。GLSL 移植（可直接用於需求 3 exposure/pivot/LGG）：

```glsl
vec3 applyLGG(vec3 rgb, vec3 lift, vec3 gammaInv, vec3 gain) {
    rgb = ((rgb - 1.0) * lift + 1.0) * gain;
    rgb = max(rgb, 0.0);
    return pow(rgb, gammaInv);   // gammaInv = 1.0 / gamma
}
```

`lift`/`gamma`/`gain` 各為 vec3（每通道獨立，可做冷暖分離調色），若只需整體亮度控制可用純量廣播成 vec3。這比目前 `vc-webgl.js` 單一 `uContrast[i]` scalar 更完整：lift 控制暗部偏移（類似 shadow lift）、gain 控制整體增益（類似 highlight gain）、gamma 控制中間調曲率——三者組合可涵蓋 exposure + pivot-contrast 的效果範圍，且是業界標準三路校色語彙（DaVinci Resolve、Baselight 等調色軟體通用）。

## 2. Vibrance / Chroma Boost 非線性公式（`src/iop/colorbalancergb.c:711-713`）

```c
const float chroma_boost = d->chroma_global + scalar_product(opacities, chroma);
const float vibrance = d->vibrance * (1.0f - powf(Ych[1], fabsf(d->vibrance)));
const float chroma_factor = MAX(1.f + chroma_boost + vibrance, 0.f);
Ych[1] *= chroma_factor;   // Ych[1] = chroma
```

**關鍵**：`vibrance` 項用 `1 - pow(chroma, |vibrance|)`——chroma 值愈低（愈接近灰）该項愈接近 1（全額加成），chroma 值愈高（已經很飽和）該項愈接近 0（幾乎不加成）。這是「vibrance ≠ saturation」的標準實作：只加成低飽和度像素，避免高飽和度區域過曝死色。GLSL 移植：

```glsl
float vibranceBoost(float chroma, float vibrance) {
    return vibrance * (1.0 - pow(clamp(chroma, 0.0, 1.0), abs(vibrance)));
}
// 套用：hsl.y *= max(1.0 + chromaBoost + vibranceBoost(hsl.y, uVibrance[i]), 0.0);
```
可作為 Eagle-Viewer 選色遮罩內「飽和度調整」的加強版，取代現行 `clamp(hsl.y + uDeltaS[i], 0, 1)` 的簡單加法，讓高飽和度已達極限的像素不會被線性疊加推爆。

## 3. Shadows/Midtones/Highlights Opacity Mask（sigmoid，非 smoothstep）（`src/iop/colorbalancergb.c:556-563`）

```c
const float x_offset = (x - mask_grey_fulcrum);
const float x_offset_norm = x_offset / mask_grey_fulcrum;
const float alpha = 1.f / (1.f + expf(x_offset_norm * shadows_weight));    // shadows opacity
const float beta  = 1.f / (1.f + expf(-x_offset_norm * highlights_weight)); // highlights opacity
const float gamma = expf(-sqf(x_offset) * midtones_weight / 4.f) * sqf(alpha_comp) * sqf(beta_comp) * 8.f; // midtones opacity
```

**可移植點**：Eagle-Viewer 現行明度模式選取用 `smoothstep(uRange*0.8, uRange, dl)` 硬邊界式遮罩。darktable 用 sigmoid（`1/(1+exp(...))`）做陰影/高光兩端的**無限延伸但漸近**遮罩，中間調用高斯型 `exp(-x²)` 遮罩——三者相加不會超過 1（有 `alpha_comp`/`beta_comp` 互補項歸一化）。若 Eagle-Viewer 要做「更平滑、更符合人眼感知的明度分區」，sigmoid+gaussian 組合比 smoothstep 更自然，但計算成本略高（exp 比 smoothstep 貴）；建議僅在使用者主動選擇「精細模式」時啟用。

## 4. colorzones 8-band LUT 架構（`src/iop/colorzones.c`）

```c
#define DT_IOP_COLORZONES_BANDS 8   // 與 Eagle-Viewer 現行 8 band 選色巧合一致

// process_v1() 行 478-521：
float select = 0.0f;
switch(d->channel) {
  case DT_IOP_COLORZONES_L: select = LCh[0] * 0.01f; break;
  case DT_IOP_COLORZONES_C: select = LCh[1] * normalize_C; break;
  case DT_IOP_COLORZONES_h: default: select = LCh[2]; break;
}
select = CLAMP(select, 0.f, 1.f);

LCh[0] *= powf(2.0f, 4.0f * (lookup(d->lut[0], select) - .5f));  // 明度：指數縮放
LCh[1] *= 2.f * lookup(d->lut[1], select);                        // 彩度：線性縮放
LCh[2] += lookup(d->lut[2], select) - .5f;                        // 色相：加法位移
```

**架構要點**：`d->lut[0..2]` 是**CPU 端預先用 spline 插值算好的 256 級查表**（對應 curves.js 的 LUT 化思路），fragment shader（若移植到 GPU）只需 1 次 texture lookup 取代整條 spline 曲線運算。且三通道（L/C/h）用不同的套用公式：明度用 `pow(2, 4*(v-0.5))`（指數，範圍更大）、彩度用線性倍率、色相用加法位移——這與 Eagle-Viewer 現有「僅支援加法式 HSL 位移」形成對比，**建議**明度调整改用指數縮放（`powf(2, ...)` 型式，效果類似 exposure stop 概念）而非目前的線性加法，會更符合人眼對亮度的感知曲線。

## 5. 總結：對 Eagle-Viewer 需求的映射

| Eagle-Viewer 需求 | darktable 對應技巧 | 檔案:行號 |
|---|---|---|
| (1) HSL/OKLCH 三維 qualifier | colorzones `DT_IOP_COLORZONES_BANDS=8` + LUT 化 select | colorzones.c:478-521 |
| (1) 更平滑遮罩 | sigmoid+gaussian opacity mask（陰影/中間調/高光） | colorbalancergb.c:556-563 |
| (2) 目標色取代保留紋理 | （darktable 無直接對應，参考 pixijs ColorReplaceFilter） | — |
| (3) 更好亮度/對比 | lift-gamma-gain 標準公式 | colorbalance.c:365-395 |
| (3) 飽和度防爆 | vibrance 非線性加成 | colorbalancergb.c:711-713 |
