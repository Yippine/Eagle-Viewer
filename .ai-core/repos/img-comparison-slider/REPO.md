---
name: "img-comparison-slider"
slug: "img-comparison-slider"
description: "Web Component（HTMLElement + Shadow DOM）clip-path 分割線 before/after 比對元件，支援拖曳/hover/鍵盤/觸控。"
url: "https://github.com/sneas/img-comparison-slider"
stars: 0
license: "MIT"
language: ["TypeScript", "SCSS"]
tags: ["before-after", "compare", "web-component", "slider", "wipe"]
checked_at: "2026-08-24"
latest_version: ""
latest_released_at: ""
tracked_version: ""
version_lag: null
default_branch: "main"
branches: []
references: ["before-after-compare-eyedropper-preset-toggle-research.md"]
related: []
---

# img-comparison-slider

$$\text{Repo}_{core} = 3W(\text{What/Why/How}) + Decision(\text{採用理由 + 替代方案比較})$$

## 3W 定位
- **What**：原生 Web Component `<img-comparison-slider>`，用 clip-path 做左右（或上下）分割線 wipe 比對，內建把手（handle）+ 拖曳/hover/鍵盤/觸控互動。
- **Why**：解決「兩張圖（或畫面）疊放比對」的標準化 UI 需求，免框架、可直接嵌入任何 DOM（含 `<video>` 容器）。
- **How**：`attachShadow` 建立 Shadow DOM，`clip-path: inset(0 var(--exposure) 0 0)` 依 CSS 變數即時裁切覆蓋層；`ResizeObserver` 維持尺寸；`touchstart/touchmove(passive:false)/touchend` 手動判斷拖曳方向後 `preventDefault()` 鎖定捲動。

## 場景與市場
攝影師/修圖工具网站常用的 before/after 展示元件（marketing 頁面、產品比較頁），npm 週下載量中等，非商用巨頭維護但穩定（MIT，語意化版本，semantic-release 自動發布）。

## 技術棧
- TypeScript + Web Components（無框架依賴，`extends HTMLElement`）
- SCSS（`adoptedStyleSheets` 注入 Shadow DOM）
- Rollup/webpack build，monorepo（`packages/img-comparison-slider` + `packages/www` 展示站）
- Jest + Playwright（e2e，未深讀）

## 架構分析
核心檔案 `packages/img-comparison-slider/src/index.ts`（469 行）：
- `HTMLImgComparisonSliderElement extends HTMLElement`，`constructor()` 中 `attachShadow({mode:'open'})` + `template.html`（`#first`/`#handle` 兩個 slot 容器）。
- 狀態：`exposure`（0–100，對應分割線位置）、`slideOnHover`、`slideDirection`（horizontal/vertical）、`keyboard`（enabled/disabled）、`dragByHandle`。
- Attribute↔Property 雙向綁定：`observedAttributes = ['hover','direction']` + `attributeChangedCallback`。
- 拖曳判斷 `isElementAffected(this.handleElement, e)`（`src/isElementAffected.ts`）：當 `handle=true` 時只有點在把手上才觸發拖曳，避免整個元件全域可拖。
- 觸控方向鎖定：`onTouchMove` 在 `hasTouchMoved` 為 false 前，比較 `offsetX`/`offsetY` 判斷手勢是否屬於分割線方向；一旦判定為「比對拖曳」，才 `e.preventDefault()` 鎖定頁面捲動（`isTouchComparing`），這是「先觀察方向再決定要不要 preventDefault」的關鍵模式，避免誤鎖垂直捲動頁面的觸控手勢。
- 鍵盤：`ArrowLeft/ArrowRight` 走 `startSlideAnimation` 以 `slideAnimationPeriod = 1000/60` 逐幀位移，`onKeyUp` 停止。
- CSS 核心：`.first-overlay-container { clip-path: inset(0 var(--exposure) 0 0); transition: clip-path var(--transition-time); }`，`--exposure` 由 JS `style.setProperty` 動態更新，`enableTransition()` 短暫套用 100ms transition 讓點擊跳轉平滑、拖曳時关閉 transition 避免延遲感。

## 資料流程
```
pointer/touch/keyboard event
  → slideToPage(point) / slide(increment)
  → setExposure() 計算 exposure(0-100)
  → CSS var(--exposure) 更新
  → clip-path 裁切 overlay，視覺呈現分割
  → dispatchEvent('slide')（外部可監聽同步狀態）
```

## 使用者操作流程
拖曳把手／整個元件（依 `handle` 屬性）→ 即時 clip-path 分割；`hover=true` 時滑鼠移動即同步（免點擊/免放開，適合桌面快速掃視）；觸控：判斷第一段位移方向決定是否進入比對模式並鎖頁面捲動；鍵盤：聚焦後方向鍵微調。

## API 入口
```html
<img-comparison-slider handle="true" hover="false" direction="horizontal" keyboard="enabled">
  <img slot="first" src="before.jpg" />
  <img slot="second" src="after.jpg" />
</img-comparison-slider>
```
`value`（get/set，0–100 分割位置）、`slide` 事件、CSS 變數 `--divider-width/--divider-color/--default-handle-*` 可覆寫視覺。

## 交叉比對
Eagle-Viewer 目前架構：`<video>` + 疊 WebGL canvas（選色）+ CSS filter（全域濾鏡），無現成 before/after wipe 元件（`viewer/js/vc-*` 系列）。此 repo 的 clip-path + Shadow DOM 模式**可移植概念但不可直接套用**——因為 Eagle-Viewer 需要 wipe 兩個「即時渲染中的畫面」（原始 video vs. WebGL 濾鏡輸出），而非兩張靜態 `<img>`；直接用此元件會要求把 video/canvas 各自包成一張「快照圖」，不利即時播放同步。**更適合的做法**：借用其「clip-path + CSS 變數 + 觸控方向鎖定」手法，自寫 wipe overlay（一層在原始 video 上、一層在濾鏡 canvas 上，藉由共用容器 + clip-path 而非重建圖片）。

## 競品比較
- `NUKnightLab/juxtapose`：偏靜態圖片新聞排版用（iframe 嵌入式），互動更「厚重」，不適合疊在 `<video>` 上做即時濾鏡比對。
- `img-comparison-slider`：輕量 Web Component，clip-path 方案效能較佳、觸控處理更細緻（方向鎖定），是本次調研兩者中更適合 Eagle-Viewer 情境者。

## 採用決策
**不直接引入套件**（Eagle-Viewer 已有 vanilla JS 架構，且比對對象是 video+canvas 而非兩張圖，引入外部 web component 反而增加整合複雜度），但**借鏡其三個實作模式**：
1. `clip-path: inset()` + CSS 變數做 wipe 分割線（比用兩層 `overflow:hidden` + `width%` 更平滑，且可對 canvas/video 通用）。
2. 觸控 `onTouchMove` 中先判斷方向、再決定 `preventDefault()`，避免誤鎖垂直滑動。
3. `hover` 模式（滑鼠移動即同步，不需按住）可作為桌機「快速掃視」的替代／補充手勢。
