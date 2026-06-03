---
title: "Eagle Viewer 濾鏡 Bar 深度調研：80/20 快速實現方案"
domain: tech
tags: [eagle-viewer, filter, canvas, css, image-restoration, selective-color]
status: published
created: 2026-06-02
---

# Eagle Viewer 濾鏡 Bar 深度調研

## 研究問題

依 80/20 法則，補充現有四個 bar（brightness / contrast / saturate / hue-rotate）之外，哪些 bar 可以：
1. **快速實現**（不需要 AI / 人臉偵測）
2. **改善舊照片光影退色**問題
3. **選擇性調色**（只改衣服顏色，人臉不動）

---

## 核心發現

### 一、CSS filter 天花板分析

現有實作使用 `element.style.filter`，CSS filter 共 10 個函式：

| 函式 | 現狀 | 說明 |
|---|---|---|
| `brightness()` | ✅ 已有 | |
| `contrast()` | ✅ 已有 | |
| `saturate()` | ✅ 已有 | |
| `hue-rotate()` | ✅ 已有 | |
| `blur()` | 可加 | 只需加 state 欄位 |
| `grayscale()` | 可加 | 只需加 state 欄位 |
| `sepia()` | 可加 | 只需加 state 欄位 |
| `opacity()` | 可加 | 只需加 state 欄位 |
| `invert()` | 可加 | toggle 即可 |
| `drop-shadow()` | 不適用 | 陰影用途，非調色 |

**結論**：CSS filter 層面還有 4 個可加，最容易，改動最小。

---

## 推薦方案（依優先級）

### 🟥 P0 — Temperature 色溫（最高優先，舊照修復核心）

**問題核心**：舊照片退色通常呈現黃褐色偏移（色溫偏暖），或褪色後藍移。這是 brightness/contrast 無法解決的。

**80/20 實現方式（兩層）**：

#### 方案 A：CSS 近似（最快，1小時內完成）
```js
// Warmth slider: -100 ~ +100
// 偏暖 → hue-rotate(-15deg) + sepia(15%)
// 偏冷 → hue-rotate(+15deg) + saturate(0.9)
function warmthToFilter(val) {
  if (val > 0) return `hue-rotate(${-val * 0.15}deg) sepia(${val * 0.15}%)`;
  return `hue-rotate(${-val * 0.15}deg)`;
}
```
缺點：hue-rotate 整體轉色，非真正 RGB 分離。

#### 方案 B：Canvas RGB 混合（中等，半天）
```js
// 每個像素：暖 → R+val, B-val
// 冷 → R-val, B+val
ctx.getImageData() → 像素迴圈 → putImageData()
```
效果媲美 Lightroom Temperature slider。

**建議**：先用方案 A 快速上線，Canvas 版排 P1 後端。

---

### 🟥 P0 — Highlights + Shadows 雙 Bar（光影還原）

**問題**：舊照片暗部細節消失、亮部過曝，單一 brightness 無法分別控制。

**Lightroom 標準做法**：亮部/暗部分離調整。

**Canvas 實現（半天）**：
```js
// Shadows bar: 只提亮暗部（luminance < 128 的像素）
// Highlights bar: 只降暗亮部（luminance > 128 的像素）
for (let i = 0; i < data.length; i += 4) {
  const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
  if (lum < 128) { /* 調整 shadows */ }
  else           { /* 調整 highlights */ }
}
```

**重要**：這兩個 bar 是「舊照片光影還原」的最直接工具，brightness/contrast 做不到這件事。

---

### 🟨 P1 — Sepia 復古色調（CSS，30 分鐘）

```css
filter: sepia(50%);
```

對於舊照片：
- `sepia(0)` = 正常
- `sepia(30%)` = 輕微底片感
- 反向用：先加 sepia 再用 hue-rotate 校正，可模擬「移除黃褐色偏移」效果

**狀態初始值**：`sepia: 0`，範圍 0–100

---

### 🟨 P1 — Vibrance 自然飽和度（Canvas，半天）

與 `saturate()` 的差異：
- `saturate`：所有像素等比提飽和（皮膚顏色也暴衝）
- `vibrance`：**只提升偏灰/偏淡的顏色**，已飽和的顏色不動

```js
// 每個像素：計算 max-min channel 差距
// 差距小（未飽和）→ 大力加飽和
// 差距大（已飽和）→ 輕微加或不動
const diff = max - min;
const boost = (1 - diff) * vibranceAmount;
```

效果：舊照片顏色還原更自然，不會讓皮膚變橘色。

---

### 🟩 P2 — 選擇性色相旋轉（衣服變色，不動人臉）

**結論：不需要 AI，可以做到。**

**原理**：皮膚色調（Skin hue）集中在 Hue ≈ 15°–40°（橙黃區間）。衣服通常是其他色相。

**實現方式（Canvas 色相範圍鎖定）**：
```js
// 使用者選擇：目標色相範圍（可點擊圖片取樣）
// 例：targetHue = 200°（藍色衣服），range = ±30°
// 只對落在該 hue 範圍的像素執行 hue-rotate
for (let i = 0; i < data.length; i += 4) {
  const [h, s, l] = rgbToHsl(data[i], data[i+1], data[i+2]);
  const dist = hueDist(h, targetHue);
  if (dist < hueRange) {
    const [r, g, b] = hslToRgb(h + shiftDeg, s, l);
    data[i] = r; data[i+1] = g; data[i+2] = b;
  }
}
```

**UI 設計**：
1. 點擊圖片 → 取樣目標顏色
2. Hue Shift slider：目標顏色旋轉量（-180 ~ +180°）
3. Range slider：選色寬窄（±10° ~ ±60°）

**限制**：若衣服顏色與皮膚相近（如橙色上衣），會有輕微溢色。這是無 AI 的本質限制，但對大多數場景已夠用。

---

### 🟩 P2 — Vignette 暗角（CSS overlay，30 分鐘）

```js
// 不需 Canvas，純 CSS overlay
videoContainer.style.boxShadow = `inset 0 0 ${vignetteSize}px ${vignetteIntensity}px rgba(0,0,0,${opacity})`;
```

舊照片常見暗角特徵，也常用作藝術效果。

---

## 架構建議：CSS 層 vs Canvas 層

```
┌─────────────────────────────────────────────────┐
│  CSS filter（現有 + 快速補充）                    │
│  brightness / contrast / saturate / hue-rotate  │
│  + sepia / blur / grayscale（新增，30min）        │
├─────────────────────────────────────────────────┤
│  Canvas 層（offscreen canvas → 覆蓋顯示）         │
│  Temperature / Shadows / Highlights（光影還原）  │
│  Vibrance（自然飽和）                             │
│  Selective Hue（選擇性變色）                     │
└─────────────────────────────────────────────────┘
```

**Canvas 層實作要點**：
- 使用 `OffscreenCanvas` 避免阻塞主執行緒
- debounce slider 輸入（16ms → requestAnimationFrame）
- 與現有 CSS filter 可並行（Canvas 輸出 → `<img>` src，CSS 繼續疊加）

---

## 舊照片還原一鍵預設建議

```js
const RESTORE_PRESET = {
  brightness: 1.05,
  contrast: 1.35,
  saturate: 1.25,
  hueRotate: 0,
  sepia: 8,        // 輕微復古底
  // Canvas 層
  temperature: +15, // 偏暖還原
  shadows: +20,     // 提亮暗部
  highlights: -10,  // 稍降亮部
  vibrance: +30,    // 自然補色
};
```

---

## 80/20 實現路線圖

| 優先 | 功能 | 技術 | 工時 | 效益 |
|---|---|---|---|---|
| P0 | Temperature（CSS 近似版） | CSS hue-rotate+sepia combo | 1h | ⭐⭐⭐⭐⭐ |
| P0 | Sepia slider | CSS `sepia()` | 30min | ⭐⭐⭐⭐ |
| P0 | Highlights + Shadows | Canvas 亮部/暗部分離 | 4h | ⭐⭐⭐⭐⭐ |
| P1 | Vibrance | Canvas 智慧飽和 | 3h | ⭐⭐⭐⭐ |
| P1 | Temperature（Canvas 真實版） | Canvas RGB 混合 | 3h | ⭐⭐⭐⭐ |
| P2 | Selective Hue（衣服變色） | Canvas 色相範圍鎖定 | 6h | ⭐⭐⭐ |
| P2 | Vignette 暗角 | CSS box-shadow inset | 30min | ⭐⭐⭐ |

**最快收益路徑**：
1. 立即：sepia + Temperature（CSS 近似）→ 2h，舊照修復感立竿見影
2. 本週：Highlights/Shadows → 舊照最核心需求
3. 下週：Vibrance + Selective Hue → 進階使用者需求

---

## 選擇性調色（衣服 vs 人臉）總結

**結論**：無需 AI，透過「色相範圍鎖定」可實現 80% 場景的選擇性調色。

- 皮膚色相（Hue 15°–40°）與衣服色相通常不重疊
- 使用者點擊衣服取樣目標色 → 調整 Hue Shift → 只有該色相範圍的像素變色
- 實現複雜度：Canvas 像素迴圈 + 簡單 HSL 轉換，約 6h
- 限制：橙色/膚色衣物會有輕微溢色，非 AI 本質限制
