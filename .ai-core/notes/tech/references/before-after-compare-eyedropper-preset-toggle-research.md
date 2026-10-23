---
title: "Before/After 比對、取色防誤觸播放、預設 toggle 語意——調研報告"
domain: tech
tags: [before-after, wipe, eyedropper, preset-toggle, video-controls, ux-research]
status: published
created: 2026-08-24
sources:
  - https://colesclassroom.com/how-to-see-before-and-after-in-lightroom/
  - https://thelenslounge.com/adobe-lightroom-before-and-after-editing-tool/
  - https://lightroomkillertips.com/lightroom-tip-quick-and-easy-beforeafter-view/
  - https://fstoppers.com/video-editing/15-keyboard-shortcuts-speed-your-color-grading-process-davinci-resolve-666263
  - https://forum.blackmagicdesign.com/viewtopic.php?t=56206
  - https://chrisdobey.com/resolve/2018/2/15/davinci-resolve-shortcuts-wipe
  - https://www.adobe.com/learn/photoshop/in-app/see-before-and-after-views-of-an-edited-photo
  - https://community.adobe.com/questions-712/toggle-before-and-after-in-photoshop-1060082
  - https://polypane.app/blog/the-eye-dropper-api-pick-colors-from-anywhere-on-your-screen/
  - https://css-tricks.com/almanac/properties/p/pointer-events/
  - https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/apply-presets.html
  - https://www.lightroomqueen.com/community/threads/how-to-unset-a-preset-take-it-back.35869/
  - https://support.vsco.co/en/articles/12698476-using-and-managing-presets
  - https://github.com/sneas/img-comparison-slider
---

# Before/After 比對、取色防誤觸、預設 toggle 語意——調研報告

背景：Eagle-Viewer 影片/圖片檢視器在 `<video>` 上疊 WebGL canvas 做選色（`viewer/js/vc-webgl.js`、`vc-canvas.js`），CSS filter 做全域濾鏡（`vc-filters.js`），桌機＋手機皆需支援。本報告聚焦三題：Before/After 比對互動、取色模式防誤觸播放、預設清單 toggle 語意。

---

## A. Before/After 比對最佳實踐

### 各家實作盤點

| 產品 | 觸發方式 | 分割/整圖 | 手機 vs 桌機 | 是否鎖播放 |
|---|---|---|---|---|
| **Lightroom（桌機）** | `\`鍵切換整張 before/after；`Y`＝左右分割；`Shift+Y`＝左右各半分割；`Alt/Option+Y`＝上下分割；`Y\|Y` 按鈕選版面 | 整張切換 + 多種分割模式並存 | 桌機專屬鍵盤操作 | 靜態圖片無播放問題 |
| **Lightroom Mobile／Snapseed／VSCO** | **按住畫面**顯示原圖，放開恢復編輯後畫面 | 整圖切換（非分割線） | 觸控慣例：按住＝暫時查看原圖，是手機版最普遍的手勢 | N/A（靜態圖） |
| **DaVinci Resolve** | `Shift+D`＝Bypass Grade（整段效果開關）；`W`＝Wipe 分割線切換；`Option/Alt+W`＝Reference Wipe | 兩種模式並存：bypass（整段開關）+ wipe（分割線） | 桌機專屬，滑鼠拖 wipe 線 | 播放中可即時 wipe，不強制暫停 |
| **Photoshop** | 圖層面板眼睛圖示開關；`Alt+`點眼睛圖示單獨顯示某層；無內建像 Lightroom 一樣的單鍵 before/after | 整圖切換為主，Split View 需手動疊圖層 | 桌機專屬 | 靜態圖片 |

### 歸納

1. **最被採用的互動＝「按住＝原圖，放開＝目前結果」**（Lightroom Mobile/Snapseed/VSCO 一致），這是手機版的事實標準，因為觸控沒有滑鼠 hover 概念，「按住」是最低成本、最直覺的暫時對比手勢，且天然具備「放開自動恢復」不需要額外退出操作的優點。
2. **桌機更偏好「分割線 wipe + 整體切換鍵並存」**（Lightroom 的 `\` 整體切換 + `Y` 分割；Resolve 的 `Shift+D` bypass + `W` wipe）——因為桌機有精確游標，wipe 分割線能同時看到雙邊細節，而整體切換鍵用於快速全局判斷。
3. **wipe 分割線視覺慣例**：一條細線（通常白色，帶陰影增加辨識度）+ 可拖曳的把手（圓形或箭頭圖示），部分工具在分割線兩側加 "Before"/"After" 浮水印文字標籤。`img-comparison-slider`（見下方 repo 深讀）即實作了「細線 + 圓形 handle + CSS 變數可調顏色」的標準款式。
4. **是否鎖播放**：影片類工具（Resolve）不強制鎖播放，wipe 在播放中即時生效；但精細比對時使用者習慣性會暫停。純比對用途（非調色監看）建議在「進入比對模式」時自動暫停，避免動態畫面干擾分割線判讀。

### 對 Eagle-Viewer 的建議組合

- **手機**：長按（`touchstart` 持續 ~150ms 或直接按住）＝顯示原始 video（不套 WebGL 濾鏡層），放開恢復濾鏡；同時保留一個「wipe 模式」開關（工具列圖示切換），開啟後改為分割線拖曳比對。
- **桌機**：`按住滑鼠左鍵（非拖曳把手區）＝顯示原圖`（呼應 Lightroom Alt 按住），額外提供「wipe 模式」快捷鍵（比照 Resolve 的 `W`）切換成可拖曳分割線；分割線視覺＝細白線＋圓形把手＋輕微陰影，可選加 Before/After 小標籤。
- **鎖播放策略**：進入「wipe 比對模式」時自動 `video.pause()`（避免分割線兩側時間軸不同步觀感），單純「按住看原圖」則不暫停（因為只是同一時間點的效果 A/B，不涉及時間軸）。
- **退出**：放開按住／再次按快捷鍵／點擊模式圖示三態皆可退出，比照 Lightroom 的 `\` 與 Resolve 的 `Shift+D` 同鍵可逆語意。

---

## B. 取色筆／比對模式下避免點擊觸發播放

### 業界作法整理

1. **cursor 改變是硬性慣例**：進入取色模式時 `cursor: crosshair`（或自訂游標圖示），讓使用者從視覺上立刻知道目前點擊語意已改變，不會誤以為在正常播放介面。
2. **EyeDropper API 原生行為**：瀏覽器原生 `window.EyeDropper` 必須由使用者手勢觸發開啟，開啟後游標變成放大鏡＋色塊預覽，此時頁面其餘點擊事件不會穿透——瀏覽器層級接管了整個輸入焦點，直到選色完成或按 `Esc` 取消。這給的啟示是：取色期間應該有一個「明確的模式狀態」蓋過原本點擊語意，而非讓事件冒泡到底層播放器判斷。
3. **CSS `pointer-events` 的正確理解**：`pointer-events: none` 只改變「誰是事件目標（hit-test）」，不是阻止事件冒泡/傳播。也就是說，若在 video 上方疊一層取色 overlay 並設 `pointer-events: auto`，這層會攔截點擊成為 event target，不會讓事件穿透到底下 video 而觸發播放/暫停；反之若忘記設定，overlay 若是 `pointer-events: none` 則點擊會直接命中 video。
4. **capture-phase 攔截**：更保險的做法是在取色模式啟動時，於外層容器加 `addEventListener('click', handler, {capture: true})`，在 capture 階段就 `e.stopPropagation()` + `e.preventDefault()`，確保無論 DOM 結構如何都不會讓 click 冒泡到 video 的原生 play/pause 監聽器（很多播放器是在 video 或其容器上直接綁 click toggle play）。
5. **Esc 退出 + 焦點回歸**：取色/比對等「模式化」操作，離開時應將 focus 交還給觸發控制項，並確保 `keydown Escape` 全域可退出模式（無障礙基本要求）。

### 可落地的 DOM 事件策略（含觸控）

```js
// 取色模式：獨立 overlay 層攔截所有輸入，不讓事件到達 video
const colorPickOverlay = document.createElement('div');
colorPickOverlay.style.cssText = `
  position: absolute; inset: 0; z-index: 50;
  cursor: crosshair; touch-action: none;
`;

function enterColorPickMode() {
  videoContainer.appendChild(colorPickOverlay);
  document.addEventListener('keydown', onEscExit, { capture: true });
}

function exitColorPickMode() {
  colorPickOverlay.remove();
  document.removeEventListener('keydown', onEscExit, { capture: true });
}

function onEscExit(e) {
  if (e.key === 'Escape') exitColorPickMode();
}

// overlay 本身處理取色，並在 capture 階段吃掉事件，
// 即使 overlay 移除前有殘留 bubbling 也不會漏到 video
colorPickOverlay.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  e.preventDefault();
  const { clientX, clientY } = e;
  pickColorAt(clientX, clientY); // 讀 WebGL canvas 像素
}, { capture: true });

// 觸控：同一顆 pointerdown（Pointer Events 統一滑鼠/觸控）已足夠；
// 若仍用 touchstart，記得 { passive: false } 才能 preventDefault
colorPickOverlay.addEventListener('touchstart', (e) => {
  e.preventDefault();
}, { passive: false, capture: true });
```

**關鍵原則**：
- 用**獨立 overlay 層**（z-index 蓋在 video 之上）而非依賴事件冒泡判斷「目前是否取色模式」——overlay 存在期間，video 原生 click-to-play 監聽器永遠收不到事件（因為 hit-test 目標變成 overlay）。
- overlay 的事件監聽器加 `{capture: true}`，確保即使外部有其他 capture-phase 監聽器也不會搶先攔截。
- `touch-action: none` + `touchstart {passive:false}` 雙保險防止觸控滾動/縮放手勢與取色手勢衝突。
- Eagle-Viewer 現有 `vc-webgl.js` 疊在 video 上的 canvas 本身即可兼作此 overlay（只需在取色模式下把 canvas 的 pointer-events 從 `none`／穿透改為 `auto`並接管事件）。

---

## C. 預設庫（preset list）的 toggle 語意

### 各家調查結果

- **Lightroom（Classic/桌機）**：**沒有內建「再點一次取消」機制**。點縮圖即套用預設，若要復原只能 `Ctrl/Cmd+Z`（歷史記錄回溯）或手動切回「Before」快照；官方文件與社群討論皆確認這點（Lightroom Queen 論壇多篇討論「how to unset a preset」皆指向用 Undo，而非再點一次）。
- **VSCO（行動 App）**：濾鏡是「膠囊」列表，**單擊套用＋顯示強度調整介面**（再次點擊同一個濾鏡膠囊會進入「強度滑桿＋確認/取消」的詳情視圖，而非直接移除套用）；要移除是在詳情視圖點 X 或改選「Original／None」膠囊，同樣不是單純的「再點一下=取消」語意。
- **Snapseed**：濾鏡/工具採「進入編輯態→上下滑動選強度→打勾套用或叉叉取消」流程，同樣不是點擊 toggle，而是「彈出調整層」語意。

### 歸納結論

**「再點同一個 preset 就取消回到原圖」並非業界主流慣例**。三家主流工具（Lightroom/VSCO/Snapseed）都採**「點擊＝套用或進入調整態，取消要靠明確的另一個動作（Undo／選 None／叉叉）」**，而非同一顆按鈕的二態 toggle。這是因為 preset 通常會疊加/覆蓋既有的其他調整（曝光、色調等一整組設定），「再點一次退回」的語意在數值上容易產生歧義（退回到「套用前的任意狀態」還是「完全原圖」？），因此工具傾向明確分離「套用」與「復原」動作。

**active 視覺**則是共同慣例：目前套用中的 preset 通常有明顯的高亮外框／打勾／放大縮圖／背景色塊變化，讓使用者一眼確認目前狀態，但這個「active 標示」本身通常不是可點擊 toggle 的入口。

### 對 Eagle-Viewer 的建議

若 Eagle-Viewer 的控制中心「選色濾鏡」預設列表希望有「二次點擊取消」能力，屬於**比業界更友善的加分設計**而非違背慣例，可以保留（因為 Eagle-Viewer 的濾鏡目前是疊加型很少且較單純，不像 Lightroom 整組設定那麼複雜，歧義風險較低）。但建議：
1. **維持 active 視覺**（高亮框/勾號），使用者能隨時確認目前套用狀態，不需依賴「記得剛剛點過」。
2. **二次點擊取消時，明確定義「取消」的目標狀態**＝退回「套用該 preset 前一刻」的參數快照，而非籠統的「完全原圖」（除非產品邏輯本來就是單一 preset 疊加、無其他手動調整並存）。
3. 若未來允許多個 preset/濾鏡疊加，應改採 VSCO/Snapseed 模式（點擊進入強度調整態＋明確的「移除」按鈕），避免『二次點擊 toggle』語意在疊加情境下失準。

---

## 附：img-comparison-slider Repo 深讀（Before/After wipe 可移植手法）

已建立 KC 條目：`.ai-core/repos/img-comparison-slider/REPO.md`，程式碼快照於 `.ai-core/repos/img-comparison-slider/.cache/code/`，深讀筆記於 `.ai-core/repos/img-comparison-slider/references/before-after-compare-eyedropper-preset-toggle-research-deep.md`。

摘要：此 web component 用 `clip-path: inset(0 var(--exposure) 0 0)` + CSS 變數做即時分割線裁切（比 `width%`/`overflow` 方案效能與泛用性更佳，可套用在 canvas 元素），並在 `touchmove` 事件中「先觀察第一段位移方向，判定為橫向拖曳才 `preventDefault()`」，避免誤鎖頁面垂直捲動——這兩個手法直接適用於 Eagle-Viewer 若要實作 video/WebGL canvas 的 wipe 比對疊層。因為 Eagle-Viewer 的比對對象是「即時渲染中的 video + WebGL 濾鏡輸出」而非兩張靜態圖，不建議直接引入此套件，但建議自行實作時借用其分割線裁切與觸控方向鎖定的模式。

---

# 思路鏈裁定（agent-role-chain，main 2026-08-24）與落地

$$c_1: \text{比對需求發生在「調整中、尚未存檔」}\Rightarrow\text{必須即時、零步驟}\;(\text{Hold})$$
$$c_2: \text{手機慣例＝長按畫面看原圖；桌機慣例＝按住鍵（\textbackslash）＋分割 wipe}\;(\text{Hold：Lightroom Mobile/Snapseed/VSCO；Lightroom/Resolve})$$
$$c_3: \text{比對／取色時點畫面不得觸發播放}\Rightarrow\text{捕獲階段攔截＋互動鎖（含放開後寬限）}\;(\text{Hold：vid click 先於 stage click，需寬限})$$
$$c_4: \text{wipe 在 <video>+GL 上最省的實作＝同來源 clone 疊層 + clip-path}\;(\text{Hold：img-comparison-slider 深讀；比對期間鎖播放 → clone 只需 seek 同步})$$
$$c_5: \text{preset 再點取消套用非業界標準}\;(\text{Weak}) \to \text{Reframe：Eagle-Viewer 為單濾鏡模型，取消＝回原圖語意明確，採用但只在清單提供、toast 說明}$$

落地：`viewer/js/vc-compare.js`（hold／wipe／長按／互動鎖）、`vc-filters.js`（取色鎖＋600ms 寬限）、`viewer.js`（單擊／雙擊／空白鍵／手機雙擊皆受鎖；`\` 按住看原圖）、`vc-presets.js`（`vcToggleApplyFilterPreset`）。
