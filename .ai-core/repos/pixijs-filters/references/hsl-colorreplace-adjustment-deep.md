---
created: 2026-08-23
topic: hsl-colorreplace-adjustment
slug: pixijs-filters
source_url: https://github.com/pixijs/filters
content_provenance: external_fetched
---

# pixijs/filters 深讀：HSL / ColorReplace / Adjustment（source: `.cache/code`, HEAD e9d1ca9, main）

## 1. HslAdjustmentFilter（`src/hsl-adjustment/hsladjustment.frag:16-26`）

**Rodrigues 旋轉公式做色相位移**（比 RGB↔HSL round-trip 省分支）：

```glsl
const vec3 k = vec3(0.57735, 0.57735, 0.57735); // 正規化 (1,1,1) 軸
vec3 hueShift(vec3 color, float angle) {
    float cosAngle = cos(angle);
    return vec3(
        color * cosAngle +
        cross(k, color) * sin(angle) +
        k * dot(k, color) * (1.0 - cosAngle)
    );
}
```

飽和度、亮度處理（`hsladjustment.frag:45-56`）：
```glsl
float average = (resultRGB.r + resultRGB.g + resultRGB.b) / 3.0;
if (saturation > 0.) {
    resultRGB += (average - resultRGB) * (1. - 1. / (1.001 - saturation));
} else {
    resultRGB -= (average - resultRGB) * saturation;
}
resultRGB = mix(resultRGB, vec3(ceil(lightness)) * color.a, abs(lightness));
```

**可移植點**：Eagle-Viewer `vc-webgl.js` 目前每個 selection band 都要完整跑 `RGBtoHSL`→調整→`HSLtoRGB`（含大量 if/branch 的 `hue2rgb`）。若 8 個 band 中有多個只做「純色相旋轉、無需分區判斷飽和度/明度」的簡單需求，可用 Rodrigues 公式替代，省去兩次完整色彩空間轉換。但 Eagle-Viewer 的分區 qualifier（hue center+width+softness）必須先算出 hue/sat/lum 才能判斷遮罩範圍，所以此技巧只在「套用」階段有意義，「判斷」階段仍需 HSL。

## 2. ColorReplaceFilter（`src/color-replace/color-replace.frag:9-14`）

**關鍵設計：保留色差向量（color-diff-preserving replace），而非直接覆寫成目標色**：

```glsl
uniform vec3 uOriginalColor;
uniform vec3 uTargetColor;
uniform float uTolerance;

void main(void) {
    vec4 c = texture(uTexture, vTextureCoord);
    vec3 colorDiff = uOriginalColor - (c.rgb / max(c.a, 0.0000000001));
    float colorDistance = length(colorDiff);
    float doReplace = step(colorDistance, uTolerance);
    finalColor = vec4(mix(c.rgb, (uTargetColor + colorDiff) * c.a, doReplace), c.a);
}
```

邏輯拆解：
1. `colorDiff = original - actualColor`：像素實際顏色與「篩選基準色」的差值（愈接近 `originalColor` 該值愈趨近 0）。
2. `colorDistance = length(colorDiff)`：歐氏距離，`step(colorDistance, uTolerance)` 做**硬遮罩**（非 smoothstep 軟邊界）。
3. **`uTargetColor + colorDiff`**——這是核心技巧：不是直接把像素設成 `targetColor`，而是把原本「像素與基準色的微小差異」疊加回目標色上，等於是把整個容忍度範圍內的顏色叢集平移到目標色附近，**同時保留原本像素間的細微色彩差異（含亮度紋理的隱式保留）**。

**對需求 (2)「目標色取代模式」的直接映射**：這正是「把遮罩內像素推到指定目標色並保留明度紋理」的現成解法之一，且比「取代 hue/sat 保留 L」（HSL 方案）更通用——因為它在 RGB 空間直接保留三通道的相對差異，不只是明度一個維度。Eagle-Viewer 可將此技巧與現有的 HSL qualifier mask 結合：

```glsl
// mask 沿用現有 hueDist/smoothstep 遮罩邏輯（軟邊界），套用時：
vec3 colorDiff = uQualifierCenterRGB[i] - rgb;       // 篩選中心色 (RGB) 與實際像素差
vec3 replaced  = uTargetColorRGB[i] + colorDiff;      // 平移到目標色，保留原始色差（含明度紋理）
rgb = mix(rgb, clamp(replaced, 0.0, 1.0), mask);      // 用現有 smoothstep mask 做軟混合，而非 step 硬遮罩
```
此法比「HSLtoRGB(vec3(targetHue, targetSat, hsl.z))」更能保留局部色彩變化（不只明度，連同飽和度的細微差異都保留），是需求 (2) 的優先候選公式。

## 3. AdjustmentFilter（`src/adjustment/adjustment.frag:11-28`）

```glsl
vec3 rgb = pow(c.rgb, vec3(1. / uGamma));
rgb = mix(vec3(.5), mix(vec3(dot(vec3(.2125, .7154, .0721), rgb)), rgb, uSaturation), uContrast);
rgb.r *= uColor.r; rgb.g *= uColor.g; rgb.b *= uColor.b;
c.rgb = rgb * uBrightness;
```

**注意**：這裡的 contrast 不是 pivot-at-0.5 縮放，而是「向灰階中點 0.5 做 mix」——效果類似但數學形式不同（`mix(0.5, x, contrast)` 等於 `0.5 + contrast*(x-0.5)`，contrast>1 時會超出 [0,1] 需 clamp，且沒有 glfx.js 正負分流的除法版本）。飽和度用 luma dot-product 灰階值做 mix，是標準且比 glfx.js 的「平均值」灰階更準確（luma 加權而非算術平均）。

**可移植點**：Eagle-Viewer 若要在 selective color 之外疊加「全域飽和度」，建議用 luma-weighted 灰階（`dot(vec3(.2125,.7154,.0721), rgb)`）取代現有 `(r+g+b)/3` 算術平均，感知上更準確。gamma 用 `pow(c.rgb, vec3(1./uGamma))` 是標準 gamma 校正，可直接用於需求 (3) 的 lift-gamma-gain 中間段。
