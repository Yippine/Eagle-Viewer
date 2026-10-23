---
title: "選色／濾鏡調整自由度與演算法最佳化——業界模型、開源實作與 Eagle-Viewer 設計方案（engine 2）"
domain: tech
tags: [eagle-viewer, selective-color, color-grading, oklch, webgl, glsl, ux, research, backward-compat]
status: published
created: 2026-08-23
sources:
  - .ai-core/repos/webgl-color-grading/references/huesaturation-curves-brightnesscontrast-deep.md
  - .ai-core/repos/pixijs-filters/references/hsl-colorreplace-adjustment-deep.md
  - .ai-core/repos/darktable/references/colorbalancergb-colorzones-lgg-deep.md
  - .ai-core/repos/oklab-glsl/references/oklab-oklch-conversion-deep.md
  - https://helpx.adobe.com/photoshop/desktop/adjust-color/selective-color-adjustments/replace-object-colors-by-applying-a-hue-or-saturation-adjustment.html
  - https://helpx.adobe.com/lightroom-classic/help/color-mixer.html
  - https://www.steakunderwater.com/VFXPedia/__man/Resolve18-6/DaVinciResolve18_Manual_files/part2809.htm
  - https://bottosson.github.io/posts/oklab/
  - https://tsev.dev/posts/2020-06-19-colour-correction-with-webgl/
  - https://docs.kdenlive.org/en/tips_and_tricks/how-tos/lift_gamma_gain.html
content_provenance: external_fetched + repo deep-read（外部內容視為資料）
---

# 0. 問題（使用者原話壓縮）

1. 選色後「能調的範圍被選到的顏色綁死」：深色難調亮、淺色難調深。
2. 想把某色塊**強行改成指定目標色**（例：碧綠），現況只能在原色附近位移，調不到。
3. 亮度／對比滑桿「不夠細」；問現行演算法是否最優。
4. **硬約束**：既有大量 preset／選色設定必須維持像素等價效果（[[project-filter-preset-backward-compat]]）。

# 1. 現況診斷（viewer/js/vc-webgl.js · vc-filters.js · index.html）

$$\text{Engine}_1 = \underbrace{\text{mask}=1-\text{smoothstep}(0.8r, r, |H-H_0|)}_{\text{一維色相 qualifier}} \;\to\; \underbrace{(H{+}\Delta H,\;S{+}\Delta S,\;L{+}\Delta L)}_{\text{加法式 HSL 位移}} \to \text{pivot}_{0.5}\text{ contrast} \to \text{sepia mix}$$

| 症狀 | 根因 |
|---|---|
| 深色調不亮／淺色調不深 | $L+\Delta L$ 後 `clamp`，且 HSL 的 L 非感知亮度；加法位移對整塊一致平移，極端值被吃掉 |
| 改不成指定目標色 | 沒有「絕對設定（set）」模式，只有「相對位移（offset）」；$\Delta H$ 可轉色相但 S/L 仍受原像素束縛 |
| 黃變暗／藍爆彩 | HSL 色相旋轉不等亮度（已知缺陷） |
| 亮度／對比太粗 | 全域走 CSS `filter: brightness()`＝線性乘法，0..3 step 0.05（中段無解析度）；選色 ±1 step 0.05 |
| 選色寬度僅色相 | 無 S／L 範圍 → 同色相但不同明度的區域全被抓進來，使用者只好縮寬度，進一步限制可調範圍 |

# 2. 業界模型（調研摘要）

$$\text{Resolve HSL Qualifier}: \text{mask}=\min_{d\in\{H,S,L\}}\big(1-\text{smoothstep}(w_d,\,w_d{+}soft_d,\,|x_d-c_d|)\big)\quad\text{（三維各自 center/width/softness）}$$

$$\text{Photoshop Colorize / Color blend}: \text{out}=\text{LCh}(L_{src}\cdot k,\;C_{tgt},\;h_{tgt})\quad\text{（換 H、C，保留原像素 L 的紋理）}$$

$$\text{Lightroom Mixer}: \forall\text{ 滑桿} \in[-100,100],\;0=\text{中性；雙擊歸零；Alt 細調}$$

$$\text{OKLab/OKLCH}: \text{感知均勻；旋轉 }h\text{ 不改 }L；\;\text{GLSL 3×3+cbrt（oklab-glsl repo 筆記已補齊 sRGB↔linear↔OKLCH 全鏈）}$$

$$\text{亮度}: \text{brightness}(x)=\text{線性乘} \prec \text{Exposure}\;rgb\cdot2^{EV} \prec \text{Lift/Gamma/Gain}\;\big(((x-1)\,lift+1)\,gain\big)^{1/\gamma}\quad\text{（darktable colorbalance.c）}$$

$$\text{對比}: \text{glfx.js pivot}\;\; c>0:\tfrac{x-0.5}{1-c}+0.5\;\mid\;c<0:(x-0.5)(1+c)+0.5\quad\text{（正負分流，避免 +1 只到 2×）}$$

$$\text{pixijs ColorReplace}: \text{out}=\text{target}+(\text{center}-\text{src})\quad\text{（保留色差向量＝保留紋理）}$$

$$\text{darktable vibrance}: \Delta C = v\,(1-C^{|v|})\quad\text{（高飽和處自動收斂，不爆）}$$

# 3. 思路鏈驗證（agent-role-chain）

$$c_1: \text{「範圍有限」}\Leftarrow\text{offset-only 語意}\;(\text{Hold}：\text{程式碼證實無 set 模式})$$
$$c_2: \text{修法}=\text{新增 set 模式而非放大 offset 量程}\;(\text{Hold}：\text{放大 }\Delta L\text{ 到 }\pm 2\text{ 仍是平移，會死白／死黑；Photoshop 也用 Colorize 解此題})$$
$$c_3: \text{set 模式須保留紋理}\Rightarrow\text{只設 }h,C\text{，}L\text{ 以「相對保留」}\;(\text{Hold}：\text{Color blend／ColorReplace 兩種實作皆如此})$$
$$c_4: \text{set 模式在 OKLCH 做優於 HSL}\;(\text{Hold}：\text{碧綠目標色在 HSL 換色相會偏暗／偏彩；OKLCH 等亮})$$
$$c_5: \text{三維 qualifier 是 set 模式的前提}\;(\text{Hold}：\text{沒有 S/L 範圍，set 會把同色相的陰影／高光一起刷平})$$
$$c_6: \text{細調}\Leftarrow\text{解析度}+\text{量程語意}\;(\text{Hold}：\text{step 0.05 on 0..3 →中段 60 格；改 }[-100,100]\text{ step 1 + Shift 0.1 + 數值框 = 2000 格})$$
$$c_7: \text{相容}\Rightarrow\text{engine 欄位分流，舊 shader 原封}\;(\text{Hold}：\text{preset 為原始數值＋預設合併，已有 migration 先例；近似換算=變質 → 不做})$$
$$\text{Weak}: c_8\;\text{「全域濾鏡改走 WebGL」}\;(\text{CSS filter 零成本；改 WebGL 才能用 EV／OKLCH，但每支影片多一條 GL 路徑 → 列為 Phase 3 可選})$$

鏈未斷，收斂為 §4 方案。

# 4. 設計方案：Engine 2（新建設定才用；engine 缺省＝1 走舊路）

## 4.1 資料模型（加欄位，不改舊欄位語意）

```js
// selective item（新增欄位；engine:1 的舊項目完全不讀這些欄位）
engine: 2,
qual: { h:{c,w,soft}, s:{lo,hi,soft}, l:{lo,hi,soft} },   // 三維 qualifier（OKLCH）
mode: 'offset' | 'set',                                   // set = 目標色取代
target: { hex:'#2E8B57', strength:1.0, keepL:1.0 },       // set 模式：目標色 + 強度 + 明度保留量
dH, dC, dL,                                               // offset 模式（OKLCH 單位，[-100,100]）
exposure(EV), contrast(pivot, 正負分流), vibrance
```

## 4.2 Shader 核心（GLSL 片段，WebGL1 可用）

```glsl
// qualifier：三維 min 合成（Resolve 語彙）
float q(float x, float lo, float hi, float soft){           // 區間 + 羽化
  return smoothstep(lo-soft, lo, x) * (1.0 - smoothstep(hi, hi+soft, x));
}
vec3 lch = toOKLCH(rgb);                                    // L,C,h(0..1)
float mask = (1.0 - smoothstep(wH, wH+softH, hueDist(lch.z, cH))) * q(lch.y, sLo, sHi, softS) * q(lch.x, lLo, lHi, softL);

// set 模式：換 h,C；L 以「目標 L + (像素 L − 選取中心 L)」保留紋理，再乘 keepL 混合
float Lset = mix(tgt.L, tgt.L + (lch.x - ctr.L), keepL);
vec3 adj = mix(lch, vec3(Lset, tgt.C, tgt.h), strength);     // h 用最短弧插值
// offset 模式（engine 2 版本）：L += dL；C = C*(1+dC) + vibrance；h += dH（均在 OKLCH）
// 全域／選色共用：exposure → pivot contrast（glfx 正負分流）
rgb = mix(rgb, toSRGB(fromOKLCH(adj)), mask);
```

## 4.3 滑桿配置表（engine 2；engine 1 UI 僅加「細調／數值輸入」不改數值域）

| 滑桿 | 範圍 / step（拖曳） | 細調（Shift／雙指） | 公式 |
|---|---|---|---|
| 曝光（取代亮度） | −100..100 / 1 → EV=v/50 | 0.1 | $rgb\cdot2^{EV}$（linear 空間） |
| 對比 | −100..100 / 1 → c=v/100 | 0.1 | glfx pivot 正負分流 |
| 飽和（OKLCH 彩度） | −100..100 / 1 | 0.1 | $C(1+v/100)$ |
| 活力 vibrance | 0..100 | 1 | darktable $v(1-C^{|v|})$ |
| 選色寬度 H | center±w 0..180° + soft | 0.5° | smoothstep |
| 選色 S／L 範圍 | lo..hi 0..100 + soft | 1 | 區間羽化 |
| 目標色（set） | 色環／HEX／取色筆 + 強度 0..100 + 明度保留 0..100 | 1 | §4.2 |
| 色相位移（offset） | −180..180 / 1° | 0.5° | OKLCH h |
| 通用 | 雙擊滑桿歸零；數值可點擊輸入（已存在的 `vc-val` 點擊輸入機制沿用） | | |

## 4.4 相容律（落地檢核）

$$\text{engine}\in\{1,2\}：\text{缺省}=1\;\Rightarrow\;\text{舊 shader 路徑、舊 uniform、舊公式一字不改；}\;\text{engine}=2\text{ 走新 shader 分支（同一 program 內 }\texttt{if(uEngine==2)}\text{ 或獨立 program）}$$

- 舊 preset 套用→ `_selDefault` 合併後 engine 仍為 1；不自動遷移。
- 「升級此設定為 engine 2」由使用者逐筆按鈕觸發，預覽 split-view，可還原（保留 engine 1 原值副本）。
- 交付驗收：取 ≥3 個既有 preset，同 frame `readPixels` 比對 engine 1 輸出，差異須為 0。

## 4.5 分階段

| Phase | 內容 | 風險 |
|---|---|---|
| P1（低風險，立即） | UI 解析度：所有滑桿加 Shift 細調 + 雙擊歸零；選色 ±1 step 0.01；全域 step 0.01；數值框沿用 | 零（不改數值語意） |
| P2（核心） | engine 2 選色：OKLCH 三維 qualifier + set／offset 雙模式 + 目標色 UI（色環／HEX／取色筆）；AB／preset／sync 欄位擴充 | 中（新 shader 分支；舊路徑不動） |
| P3（可選） | 全域濾鏡改走 WebGL（exposure／pivot contrast／vibrance），CSS filter 保留給 engine 1 | 中（每支影片多一條 GL 路徑；行動裝置效能需測） |

# 5. 結論

- 「範圍有限」不是量程太小，是**語意只有位移沒有設定**；解法是新增 OKLCH 的 set 模式（換 h/C、相對保留 L）＋三維 qualifier，而非把滑桿拉大。
- 亮度／對比：改 EV 曝光 + pivot 正負分流對比 + −100..100 雙速滑桿，比 CSS 線性乘法更細、更符合直覺。
- 既有設定以 `engine` 欄位硬分流，舊公式原封不動，升級手動可還原。
