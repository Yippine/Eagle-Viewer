---
title: "img-comparison-slider 深讀筆記——clip-path wipe 手法可移植性"
domain: tech
tags: [before-after, wipe, clip-path, web-component, touch]
status: published
created: 2026-08-24
sources:
  - https://github.com/sneas/img-comparison-slider
---

# img-comparison-slider 深讀筆記

程式碼路徑：`.ai-core/repos/img-comparison-slider/.cache/code/packages/img-comparison-slider/src/`

## 核心機制摘要（見 REPO.md 架構分析節，此處補充落地細節）

### 1. clip-path wipe（`src/styles.scss`）
```scss
.first-overlay-container {
  position: relative;
  clip-path: inset(0 var(--exposure) 0 0);
  transition: clip-path var(--transition-time);
  height: 100%;
}
```
`--exposure` 由 JS 動態 `setProperty`，取值為「距右邊界的裁切量」（`100 - exposure%`）。這個手法可直接套用在 Eagle-Viewer 的 video/canvas 疊層結構：外層容器 `position:relative`，「after 層」（濾鏡輸出，WebGL canvas）用 `clip-path: inset(...)` 依滑桿位置裁切，蓋在「before 層」（原始 `<video>`）之上，兩層共用同一份播放時間軸（同一個 video element 或用 `currentTime` 同步的第二個 video），避免快照圖不同步問題。

### 2. 觸控方向鎖定（`src/index.ts` L262-296，`onTouchMove`）
```ts
private onTouchMove = (e: TouchEvent) => {
  if (this.touchStartPoint === null) return;
  const currentPoint = getTouchPagePoint(e);
  if (this.isTouchComparing) {
    this.slideToPage(currentPoint);
    e.preventDefault();
    return false;
  }
  if (!this.hasTouchMoved) {
    const offsetY = Math.abs(currentPoint.y - this.touchStartPoint.y);
    const offsetX = Math.abs(currentPoint.x - this.touchStartPoint.x);
    if (
      (this.slideDirection === 'horizontal' && offsetY < offsetX) ||
      (this.slideDirection === 'vertical' && offsetY > offsetX)
    ) {
      this.isTouchComparing = true;
      this.focus();
      this.slideToPage(currentPoint);
      e.preventDefault();
      return false;
    }
    this.hasTouchMoved = true;
  }
};
```
關鍵：`touchmove` listener 註冊為 `{passive: false}`（見 connectedCallback），但只在「判定為橫向拖曳」時才呼叫 `preventDefault()`；一開始（`touchstart`）不鎖定，等第一次 `touchmove` 有足夠位移量才判斷方向。這避免了「使用者想垂直滑動頁面卻被 wipe 元件整個吃掉手勢」的常見 bug，可直接套用在 Eagle-Viewer 手機版 wipe 比對疊層。

### 3. handle 命中判斷（`src/isElementAffected.ts`）
用 `handle=true` 屬性時，只有點在把手（分割線上的圓形把手 DOM）才會觸發拖曳；否則整個元件表面拖曳皆有效。Eagle-Viewer 若要支援「拖任意處=wipe、點擊=其他行為（如取色）」共存，可採此模式：先判斷點擊目標是否落在 wipe handle 的命中區（可加大 hit-area 但視覺仍是細線），非 handle 區域則放行給下層的取色 canvas 事件。

### 4. hover 模式（免按住）
`hover=true` 時綁定 `mousemove`，滑鼠移動即同步分割線位置，不需要按住拖曳。這是「桌機快速掃視」的另一種常見互動（相對於 Lightroom 的按住/放開），Eagle-Viewer 可考慮作為選配模式（例如控制中心切換「按住比對」vs「移動即比對」）。

## 對 Eagle-Viewer 落地建議
不直接引入此套件（video+WebGL 即時疊層情境不同於靜態雙圖），但抽取以下三個模式自行實作：
1. `clip-path: inset()` 分割線裁切，取代目前可能用的 `width%`/`overflow` 方案（效能與可讀性更佳，且可用於 canvas 元素）。
2. `touchmove` 方向判定後才 `preventDefault()` 的節流邏輯，寫入 `viewer/js/viewer-touch.js` 或新建 wipe 手勢模組。
3. `handle` 命中區判斷模式，用於「wipe 拖曳 vs 取色點擊」共存時的事件分派。
