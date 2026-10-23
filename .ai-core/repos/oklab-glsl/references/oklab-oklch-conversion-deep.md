---
created: 2026-08-23
topic: oklab-oklch-conversion
slug: oklab-glsl
source_url: https://gist.github.com/akella/059d9877b90f966c9181ffa2bc5ffd65
content_provenance: external_fetched
---

# OKLab GLSL 深讀（source: `.cache/code`, HEAD bf3004b, main）

## 全文（僅 43 行，完整節錄，`oklab.glsl:1-43`）

```glsl
float fixedpow(float a, float x) { return pow(abs(a), x) * sign(a); }
float cbrt(float a) { return fixedpow(a, 0.3333333333); }

vec3 lsrgb2oklab(vec3 c)
{
    float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
    float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
    float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
    float l_ = cbrt(l), m_ = cbrt(m), s_ = cbrt(s);
    return vec3(
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    );
}

vec3 oklab2lsrgb(vec3 c)
{
    float l_ = c.r + 0.3963377774 * c.g + 0.2158037573 * c.b;
    float m_ = c.r - 0.1055613458 * c.g - 0.0638541728 * c.b;
    float s_ = c.r - 0.0894841775 * c.g - 1.2914855480 * c.b;
    float l = l_*l_*l_, m = m_*m_*m_, s = s_*s_*s_;
    return vec3(
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    );
}
```

## Eagle-Viewer 移植方案：OKLCH qualifier 完整套件

需求 (1) 要「HSL/OKLCH 三維 qualifier（hue/sat/lum 各自 center+width+softness）」，OKLCH 版本需要在上述基礎上補三段：

```glsl
// 1. sRGB (texture 讀出的值) -> linear sRGB（gist 未附，必須自補，否則轉換系統性偏移）
vec3 srgb2linear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linear2srgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
}

// 2. Oklab -> OKLCH 極座標
vec3 oklab2oklch(vec3 lab) {
    float C = length(lab.yz);
    float h = atan(lab.z, lab.y) / (2.0 * 3.14159265) ; // 正規化到 [-0.5, 0.5]，可再 +0.5 對齊 [0,1]
    return vec3(lab.x, C, fract(h + 1.0));
}
vec3 oklch2oklab(vec3 lch) {
    float angle = lch.z * 2.0 * 3.14159265;
    return vec3(lch.x, lch.y * cos(angle), lch.y * sin(angle));
}

// 3. 選色遮罩（呼應現有 vc-webgl.js 的 hueDist + smoothstep 架構，僅改色彩空間）
vec3 rgb2oklch(vec3 rgb) { return oklab2oklch(lsrgb2oklab(srgb2linear(rgb))); }
vec3 oklch2rgb(vec3 lch) { return linear2srgb(oklab2lsrgb(oklch2oklab(lch))); }

float hueDistOklch(float h1, float h2) { float d = abs(h1 - h2); return min(d, 1.0 - d); } // 與現有 hueDist 同構
```

**與現有 `vc-webgl.js` 架構的整合點**：`RGBtoHSL`/`HSLtoRGB` 直接替換為 `rgb2oklch`/`oklch2rgb`，`hueDist` 函式簽名不變（OKLCH 的 hue 也是 [0,1] 環狀值），現有的 `mask = 1.0 - smoothstep(uRange*0.8, uRange, hueDist(...))` 遮罩邏輯可完全複用，只是輸入色彩空間換了。三維 qualifier（hue/sat/lum 各自 center+width+softness）在 OKLCH 下對應 `lch.z`（hue）/`lch.y`（chroma，即飽和度類比）/`lch.x`（lightness）三個獨立 mask，可用 `min()` 或乘積合成複合遮罩。

**效能與正確性權衡**：
- 每像素成本：2 次 3x3 矩陣 + 1 次 cbrt/cube + 1 次 sRGB↔linear（含 `mix`+`step`，實務上會有分支發散但 GLSL 編譯器通常轉成無分支的 select）+ 1 次 atan/cos/sin（極座標）。比現有 HSL 版本（`RGBtoHSL` 內建 3 個 if-else 找 maxC）運算量更大，但無條件分支發散問題，在 GPU 上大機率總體更快或持平。
- **必須注意色域裁切**：OKLCH 的 chroma 若調整過大，轉回 sRGB 後可能超出 [0,1] gamut，需要 `clamp()` 或做 gamut mapping（darktable colorbalancergb.c 有 `gamut_check_Yrg()` 範例，OKLCH 目前無現成的簡易 gamut clip，最簡單做法是轉換後直接 clamp rgb 到 [0,1]，會犧牲一些色相準確度但不會出現裁切色斑）。

## 建議

若 Eagle-Viewer 決定導入 OKLCH，**建議採漸進式**：先只在「遮罩判斷」（qualifier 的 hue/sat/lum 三維篩選）換成 OKLCH（視覺篩選範圍更符合人眼直覺），但「調整套用」（推色相/加飽和度）階段仍可保留 HSL 或視覺測試結果決定，避免一次全面替換造成既有濾鏡預設值全部跑掉（現有使用者存的濾鏡連結 preset 都是 HSL 參數）。
