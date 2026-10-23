---
name: "OKLab GLSL"
slug: "oklab-glsl"
description: "Björn Ottosson OKLab/OKLCH 色彩空間的 GLSL 轉換函式（linear sRGB ↔ OKLab），供 Eagle-Viewer 選色遮罩改用感知均勻色彩空間"
url: "https://gist.github.com/akella/059d9877b90f966c9181ffa2bc5ffd65"
stars: 0
license: ""
language: ["GLSL"]
tags: ["oklab", "oklch", "color-space", "perceptual-uniform", "shader"]
checked_at: "2026-08-23"
latest_version: "bf3004b"
latest_released_at: ""
tracked_version: "bf3004b"
version_lag: 0
default_branch: "main"
branches: ["origin", "origin/main"]
references:
  - references/oklab-oklch-conversion-deep.md
related: ["webgl-color-grading", "darktable"]
---

# OKLab GLSL — Eagle Viewer 調研

$$\text{目標} = \text{評估 OKLab/OKLCH 色彩空間 GLSL 實作，作為 HSL 選色遮罩的感知均勻升級選項}$$

## 3W 定位
$$\text{3W} = What(\text{Björn Ottosson 2020 提出的 OKLab 感知均勻色彩空間，此 gist 為 linear sRGB} \leftrightarrow \text{OKLab 的最小 GLSL 轉換函式集}) + Why(\text{HSL 色相環在感知上不均勻——如藍色色相段目視差異遠大於黃色段同等角度差異，OKLCH 的 hue 環在感知上更均勻，選色 qualifier 用 OKLCH 可讓「同樣的 width 參數」在各色相段有一致的視覺篩選範圍}) + How(\text{Oklab 由三個 3x3 矩陣（sRGB→LMS→Oklab 及逆向）+ 一個 cube-root 非線性組成，無查表、無分支，適合 fragment shader})$$

## 技術棧
$$\text{TechStack} = \text{純 GLSL 函式（無框架依賴），2 個矩陣乘法 + 1 個 cbrt/cube 非線性}$$

## 架構分析
- `oklab.glsl:1-9`：`fixedpow`/`cbrt` 輔助函式，處理負值立方根（`pow(abs(a),x)*sign(a)`，避免 GLSL `pow()` 對負底數 undefined 的問題）。
- `oklab.glsl:11-26`：`lsrgb2oklab()`——linear sRGB → LMS（3x3 矩陣）→ cube-root 非線性 → Oklab（另一個 3x3 矩陣）。
- `oklab.glsl:28-43`：`oklab2lsrgb()`——完全對稱的逆向流程（cube 而非 cbrt）。

## 資料流程
$$\text{OKLab 轉換} = \text{linearRGB} \xrightarrow{M_1} \text{LMS} \xrightarrow{\text{cbrt}} \text{LMS}' \xrightarrow{M_2} \text{Oklab}(L,a,b)$$
$$\text{OKLCH} = \text{Oklab} \to (L,\; C{=}\sqrt{a^2+b^2},\; h{=}\text{atan2}(b,a))$$

## API 入口
```glsl
vec3 lsrgb2oklab(vec3 c);   // linear sRGB -> Oklab (L, a, b)
vec3 oklab2lsrgb(vec3 c);   // Oklab -> linear sRGB
// OKLCH 需自行加 2 行：
// float C = length(oklab.yz); float h = atan(oklab.z, oklab.y);
```

## 交叉比對
Eagle-Viewer 現有 `vc-webgl.js` 用 HSL（`RGBtoHSL`/`HSLtoRGB`），若需求 (1) 要做「OKLCH 三維 qualifier」，此 gist 提供最小可用的轉換核心，但**注意**：輸入必須是 **linear sRGB**，而影片/圖片來源紋理是 **sRGB gamma-encoded**，套用前需先做 `pow(rgb, vec3(2.2))`（或精確的 sRGB EOTF 分段函式）解 gamma，轉換完再編碼回去——這是移植時最容易漏掉的步驟，否則遮罩範圍會系統性偏移。

## 採用決策
建議採用此矩陣係數作為需求 (1) OKLCH qualifier 的轉換基礎，但需自行：(a) 補 sRGB↔linear 轉換、(b) 補 OKLCH 的 C/h 極座標轉換、(c) 評估效能——每像素 2 次 3x3 矩陣 + 1 次 cbrt + 1 次 cube，比現有 HSL 轉換（純 if 分支）多了 6 次乘法但少了條件分支，GPU 上通常更快（分支發散成本 > ALU 成本）。詳見 references/oklab-oklch-conversion-deep.md。
