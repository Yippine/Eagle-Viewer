---
name: "darktable"
slug: "darktable"
description: "開源 RAW 顯影軟體：colorbalancergb（Yrg/Ych 選區調色）+ colorzones（8-band LCh qualifier LUT）+ colorbalance（lift/gamma/gain 三路校色）調研"
url: "https://github.com/darktable-org/darktable"
stars: 0
license: "GPL-3.0"
language: ["C", "OpenCL"]
tags: ["color-grading", "selective-color", "lift-gamma-gain", "colorzones", "raw-processing", "qualifier"]
checked_at: "2026-08-23"
latest_version: "08217c2"
latest_released_at: ""
tracked_version: "08217c2"
version_lag: 0
default_branch: "master"
branches: ["origin", "origin/master"]
references:
  - references/colorbalancergb-colorzones-lgg-deep.md
related: ["webgl-color-grading", "pixijs-filters"]
---

# darktable — Eagle Viewer 調研

$$\text{目標} = \text{評估專業級顯影軟體的三路校色（lift/gamma/gain）與 8-band 色相分區 qualifier 演算法，供 vc-webgl.js 選色/亮度對比架構參考}$$

## 3W 定位
$$\text{3W} = What(\text{開源 RAW 顯影／後製軟體，src/iop/ 下每個處理模組（iop = image operation）是獨立 C 檔}) + Why(\text{colorbalancergb 是業界標準「三路校色/選區調色」設計；colorzones 是 8-band hue-based qualifier + LUT 的成熟實作，兩者恰好對應 Eagle-Viewer 需求 (1)(3)}) + How(\text{CPU pixel loop（也有 OpenCL process\_cl 版本），非 GPU shader，但演算法本身色彩空間無關，可移植到 GLSL})$$

## 場景與市場
專業攝影後製（Lightroom/Capture One 競品），colorbalancergb 對標 DaVinci Resolve 的 Color Wheels + Filmlight 的 Yrg 色彩科學；colorzones 對標 Lightroom 的 HSL/Color Mixer 面板。

## 技術棧
$$\text{TechStack} = \text{C（純運算核心）} + \text{GTK（UI，不相關）} + \text{OpenCL（process\_cl 對應 GPU 加速版）} + \text{自訂色彩空間（Filmlight Yrg/Ych、CIE LCh）}$$

## 架構分析
- `src/iop/colorbalancergb.c`：`process()`（約行 660-720）在 **Yrg/Ych 色彩空間**（非 HSL）做色相旋轉（矩陣乘法）+ chroma boost + vibrance（低飽和度加成更多、高飽和度加成較少的非線性公式）+ opacity_masks（用 sigmoid `1/(1+exp(...))` 做 shadows/highlights/midtones 三段權重遮罩，而非 Eagle-Viewer 現有的 smoothstep 硬邊界）。
- `src/iop/colorzones.c`：`DT_IOP_COLORZONES_BANDS = 8`（與 Eagle-Viewer 現有 8-band selective color 巧合一致！），`process_v1()`（行 478-521）依 hue/chroma/lightness 三選一作為 `select` 索引，`lookup(d->lut[c], select)` 從預算好的 LUT 取值，再套用到 L/C/h 三通道。
- `src/iop/colorbalance.c`：經典 **lift/gamma/gain** 三路校色核心公式（行 384）：`rgb[c] = (((rgb[c] - 1) * lift[c]) + 1) * gain[c]`，再套用 `pow(rgb, gamma_inv)`。

## 資料流程
$$\text{colorzones} = \text{Lab} \to \text{LCh}(\text{select}=L/C/h) \to \text{LUT lookup（256 級預算表）} \to \text{乘/加回 L,C,h} \to \text{Lab}$$
$$\text{colorbalance(LGG)} = \text{Lab} \to \text{XYZ} \to \text{sRGB} \to (rgb-1)\cdot lift + 1) \cdot gain \to \text{clip} \to pow(\cdot, 1/gamma) \to \text{sRGB→XYZ→Lab}$$

## API 入口
- `process_v1()` / `process_v3()`（colorzones.c 行 478 / 526）：LUT-based 8-band selective adjustment 主入口
- `_apply_lgg()`（colorbalance.c 行 400 起）：lift-gamma-gain 逐像素套用

## 交叉比對
Eagle-Viewer `vc-webgl.js` 現行架構已是「8 band + hue/mode 選取」，與 darktable colorzones 的 `DT_IOP_COLORZONES_BANDS=8` 概念一致，但 darktable 用**預算 LUT**（256 級查表，CPU 端算好），Eagle-Viewer 現行是逐像素即時算 smoothstep/HSL 轉換。LGG 公式（colorbalance.c:384）是需求 (3) 的標準答案，比自製的 exposure/pivot-contrast 更完整（同時處理陰影/中間調/高光三段）。

## 採用決策
不採用整個 darktable（C 桌面應用，無法直接搬），但 `_apply_lgg` 的 LGG 公式與 colorzones 的 LUT 化 8-band 架構是需求 (1)(3) 的最佳參照範本，公式節錄見 references/colorbalancergb-colorzones-lgg-deep.md。
