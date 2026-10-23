---
name: "PixiJS Filters"
slug: "pixijs-filters"
description: "PixiJS 官方濾鏡集：HslAdjustmentFilter/ColorReplaceFilter/AdjustmentFilter GLSL+WGSL 雙後端實作（選色/取代/亮度對比調研）"
url: "https://github.com/pixijs/filters"
stars: 0
license: "MIT"
language: ["TypeScript", "GLSL", "WGSL"]
tags: ["webgl", "webgpu", "pixijs", "hsl", "color-replace", "selective-color", "shader"]
checked_at: "2026-08-23"
latest_version: "e9d1ca9"
latest_released_at: ""
tracked_version: "e9d1ca9"
version_lag: 0
default_branch: "main"
branches: ["origin", "origin/main"]
references:
  - references/hsl-colorreplace-adjustment-deep.md
related: ["webgl-color-grading"]
---

# PixiJS Filters — Eagle Viewer 調研

$$\text{目標} = \text{評估 PixiJS 官方 HSL/ColorReplace/Adjustment 濾鏡實作，供 vc-webgl.js 選色 shader 重構參考}$$

## 3W 定位
$$\text{3W} = What(\text{PixiJS 生態系官方維護的 community filter 集合，含 WebGL/WebGPU 雙後端 GLSL+WGSL 濾鏡}) + Why(\text{涵蓋色相調整/顏色取代/明暗對比三種需求，且是生產級、廣泛使用的實作，可直接借鑑其 uniform 設計與邊界處理}) + How(\text{每濾鏡一個 TS class + .frag/.wgsl 成對檔案，uniform 綁定，Filter 基底類別統一管理})$$

## 技術棧
$$\text{TechStack} = \text{TypeScript} + \text{PixiJS v8 Filter API} + \text{GLSL ES 3.0（GL 後端）} + \text{WGSL（WebGPU 後端）}$$

## 架構分析
- `src/hsl-adjustment/hsladjustment.frag`：色相旋轉用 Rodrigues 旋轉公式（非 HSL round-trip），飽和度沿用 glfx.js 公式（`resultRGB += (average - resultRGB) * ...`），並支援 `uAlpha` 混合權重與 `uColorize`（先轉灰階再賦色）雙模式。
- `src/color-replace/ColorReplaceFilter.ts` + `color-replace.frag`/`.wgsl`：以「顏色差值向量」而非純色相取代，容忍度用歐氏距離 `length(colorDiff)` + `step()` 二值判斷（非 smoothstep 軟遮罩）。
- `src/adjustment/adjustment.frag`：gamma/contrast/saturation/brightness 一次到位，對比實作是「向灰階值 mix」而非傳統 pivot-scale。

## 資料流程
$$\text{Filter} = \text{Uniform 設定}(\text{JS}) \to \text{fragment shader}(\text{逐像素}) \to \text{finalColor}$$

## API 入口
```ts
new HslAdjustmentFilter({ hue: 0.2, saturation: 0.1, lightness: 0, colorize: false, alpha: 1 })
new ColorReplaceFilter({ originalColor: 0xff0000, targetColor: 0x0000ff, tolerance: 0.4 })
new AdjustmentFilter({ gamma: 1, contrast: 1, saturation: 1, brightness: 1, red: 1, green: 1, blue: 1, alpha: 1 })
```

## 交叉比對
與 `.ai-core/repos/webgl-color-grading`（glfx.js）高度重疊——`hsladjustment.frag` 的飽和度公式直接註明取自 glfx.js `huesaturation.js`。與 Eagle-Viewer `viewer/js/vc-webgl.js` 的差異：Eagle-Viewer 用完整 HSL round-trip 做分區選色 mask，PixiJS 濾鏡均為全域套用（無分區 qualifier），故 mask 邏輯仍須自行保留，僅「調整套用」與「取代」演算法可借鑑。

## 採用決策
不直接依賴此 repo（PixiJS 綁定過重，Eagle-Viewer 為原生 WebGL1），但 `hueShift`（Rodrigues 旋轉）與 `ColorReplaceFilter` 的「保留色差向量」設計具高移植價值，詳見 references/hsl-colorreplace-adjustment-deep.md。
