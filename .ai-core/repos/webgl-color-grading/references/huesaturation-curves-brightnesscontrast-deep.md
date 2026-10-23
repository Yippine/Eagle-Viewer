---
created: 2026-08-23
topic: huesaturation-curves-brightnesscontrast
slug: webgl-color-grading
source_url: https://github.com/evanw/glfx.js
content_provenance: external_fetched
---

# glfx.js 選色/曲線/亮度對比 深讀（source: `.cache/code`）

$$\text{Provenance} = \text{git clone --depth 1 https://github.com/evanw/glfx.js} \to \texttt{.cache/code}\text{（HEAD 86ae72a, master）}$$

## 1. HueSaturation（`src/filters/adjust/huesaturation.js:13-51`）

**核心機制**：不走 HSL round-trip，而是把「色相旋轉」表示成 RGB 立方體對角線（灰階線 (1,1,1)）為軸的旋轉矩陣，一次矩陣乘法完成全圖色相位移：

```glsl
float angle = hue * 3.14159265;
float s = sin(angle), c = cos(angle);
vec3 weights = (vec3(2.0 * c, -sqrt(3.0) * s - c, sqrt(3.0) * s - c) + 1.0) / 3.0;
color.rgb = vec3(
    dot(color.rgb, weights.xyz),
    dot(color.rgb, weights.zxy),
    dot(color.rgb, weights.yzx)
);
```

飽和度採「向/離平均值縮放」，且正負飽和用不同公式（正向用倒數避免除以 0 附近爆掉）：

```glsl
float average = (color.r + color.g + color.b) / 3.0;
if (saturation > 0.0) {
    color.rgb += (average - color.rgb) * (1.0 - 1.0 / (1.001 - saturation));
} else {
    color.rgb += (average - color.rgb) * (-saturation);
}
```

**對 Eagle-Viewer 的可移植點**：目前 `viewer/js/vc-webgl.js:60-64` 用 `RGBtoHSL`/`HSLtoRGB` 兩個完整轉換函式（含 branch-heavy `hue2rgb`）做全域位移，每像素要做 6 個 if/三角判斷。若只是「整體色相旋轉」需求（非分區 qualifier），矩陣旋轉法在 fragment shader 內分支更少、更適合行動裝置 GPU。但 Eagle-Viewer 需要「分區遮罩」（8 個 selective color band），矩陣法無法區分色相子集合，仍需 HSL/hueDist 遮罩邏輯——**建議**：遮罩判斷（mask 計算）維持現有 `RGBtoHSL` 求 hue/sat/lum，但「套用調整」時對於純色相旋轉可切換成矩陣法以省 ALU；不影響需求 (1)(2)(3) 的架構決策，屬效能微優化選項。

## 2. Curves（`src/filters/adjust/curves.js:1-64`）

**核心機制**：CPU 端用 Catmull-Rom 類 spline（`SplineInterpolator`）把使用者定義的控制點插值成 256 級 LUT，再把 R/G/B 三條 LUT 打包進一張 `256×1` RGBA 貼圖，shader 端純粹是 3 次 texture lookup（無條件分支）：

```glsl
uniform sampler2D map;   // 256x1 LUT texture, r/g/b channel per color
void main() {
    vec4 color = texture2D(texture, texCoord);
    color.r = texture2D(map, vec2(color.r)).r;
    color.g = texture2D(map, vec2(color.g)).g;
    color.b = texture2D(map, vec2(color.b)).b;
    gl_FragColor = color;
}
```

**對 Eagle-Viewer 的可移植點**：這是需求 (3)「更好的亮度/對比演算法」的關鍵手法——**LUT-based tone curve**。若要實作 exposure / pivot contrast / lift-gamma-gain，與其把公式塞進 fragment shader 逐像素算 pow/exp（尤其 lift-gamma-gain 涉及 3 段公式 + gamma pow，成本高且在 8-band selective color loop 內會被乘 8 次），更好的做法是：CPU/JS 端依 exposure/pivot-contrast/LGG 參數算出 256 級 1D LUT（一張小紋理，只在參數變動時更新，不必每幀重算），fragment shader 內只做一次 `texture2D` lookup。這對 `vc-webgl.js` 目前每 selection band 都重算 `uContrast[i]` 的簡易 pivot-contrast（`newRgb = clamp(0.5 + (1.0+uContrast[i])*(newRgb-0.5))`）是直接可升級路徑：LUT 可容納非線性 lift-gamma-gain 曲線而不增加 shader 分支數。

## 3. BrightnessContrast（`src/filters/adjust/brightnesscontrast.js:7-31`）

**核心機制**：brightness 為加法位移，contrast 為「以 0.5 為 pivot 的縮放」，且正負 contrast 用不同縮放方向避免除以 0：

```glsl
color.rgb += brightness;
if (contrast > 0.0) {
    color.rgb = (color.rgb - 0.5) / (1.0 - contrast) + 0.5;
} else {
    color.rgb = (color.rgb - 0.5) * (1.0 + contrast) + 0.5;
}
```

**對 Eagle-Viewer 的可移植點**：這正是「pivot contrast」的標準寫法，且與 Eagle-Viewer 現有 `vc-webgl.js` 的 `uContrast[i]` 分支（`newRgb = clamp(0.5 + (1.0 + uContrast[i]) * (newRgb - 0.5))`）幾乎同構，但現有實作只用了「負向」那條公式（線性縮放），未區分正向時的除法版本（正向除法在高對比時能保留更多動態範圍，不會像線性乘法一樣把中間調直接拉平到死黑/死白）。**建議**：把現有單一公式换成 glfx.js 的正負分流版本，可用 `uContrast[i] > 0.0 ? (rgb-0.5)/(1.0-uContrast[i])+0.5 : (rgb-0.5)*(1.0+uContrast[i])+0.5`，成本增加僅一個條件分支。exposure 建議另加一層 `rgb *= pow(2.0, uExposure[i])`（相機曝光值語意，乘法而非加法，對高光/陰影更自然），置於 pivot-contrast 之前。

## 4. 三律彙整：Eagle-Viewer shader 重構建議次序

$$\text{PipelineOrder} = \text{Exposure(mult)} \to \text{PivotContrast(scale@0.5, 正負分流)} \to \text{LiftGammaGain(LUT 化)} \to \text{HSLQualifierMask(維持現有 RGBtoHSL)} \to \text{TargetColorReplace(需求2，新增)}$$

- Exposure/LGG 若逐像素算，在 8-band loop 內成本會乘 8；LUT 化（256×1 texture，僅參數變動時 CPU 重算）可把每 band 成本壓到 1 次 texture2D。
- Contrast 正負分流公式可直接複製 `brightnesscontrast.js:16-20`。
- 「目標色取代」（需求 2）glfx.js 沒有對應濾鏡，需另尋 pixijs `ColorReplaceFilter` 或自行設計：建議在遮罩內把 `hsl.z`（明度）保留、`hsl.x/hsl.y` 直接覆寫為目標色的 hue/sat（即用現有 `HSLtoRGB(vec3(targetHue, targetSat, hsl.z))` 一行即可達成「保留明度紋理」效果）。
