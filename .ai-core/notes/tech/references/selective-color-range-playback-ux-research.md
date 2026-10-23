---
title: "選色色塊一鍵套用 AB 時段播放——業界最佳實踐與 Eagle-Viewer 設計"
domain: tech
tags: [eagle-viewer, ux, video, ab-loop, selective-color, research]
status: published
created: 2026-08-23
---

# 問題

選色濾鏡（selective color）每個色塊可綁定時段（abStart/abEnd）；使用者希望點色塊即可「只播放該色塊的時段」。

# 思路鏈（agent-role-chain）

$$c_1: \text{色塊點擊主動作} = \text{選取/編輯}\;(\text{Hold：既有語意，改掉會破壞編輯流})$$
$$c_2: \text{「只播此時段」} = \text{次要動作} \Rightarrow \text{須有獨立 affordance，不能靠長按/雙擊}\;(\text{Hold：長按可發現性差、雙擊與桌面 dblclick 衝突})$$
$$c_3: \text{套用} \equiv \text{寫入播放 AB}(a{=}abStart,\,b{=}abEnd,\,active) + \text{seek}(a) + \text{play}\;(\text{Hold：沿用 SSOT，播放頁籤同步顯示})$$
$$c_4: \text{可逆性} \Rightarrow \text{再按一次＝停止循環（toggle）}\;(\text{Hold：Loop 鈕通用語彙})$$
$$c_5: \text{狀態回饋} \Rightarrow \text{色塊顯示循環中 + 進度條顯示時段範圍}\;(\text{Hold：YouTube chapters／Resolve range marker 的共同點})$$

# 業界對照

| 產品 | 模式 | 借鑑 |
|---|---|---|
| DaVinci Resolve / Premiere | 時間軸 range marker；雙擊 marker → 設 In/Out；Loop playback | 「時段 → In/Out → loop」三步合一鍵 |
| YouTube chapters | 進度條分段著色；章節列表點擊 seek；目前章節高亮 | 進度條上色塊時段標記（色＝色塊色） |
| CapCut / iOS Photos trim | 黃色時段把手；選取段落即預覽該段 | 時段可視化在進度條 |
| Frame.io / Vimeo range comment | 點評論 → 循環播放該段 | 「點項目 = 循環該段」+ 高亮項目 |
| 練習型播放器（Amazing Slow Downer、YouTube Looper） | 已存 loop 清單，一鍵套用、再按取消 | toggle 語意 |

# 設計（桌面 + 手機）

1. **色塊 chip 徽章**：有時段的 chip 右下角常駐 ▶ 徽章（取代純顯示的 ⏱）；點徽章＝套用該時段為 AB 並循環播放；循環中徽章變 ⟲ + chip 呼吸光環；再點＝停止。桌面 hover 放大；手機徽章 ≥22px 命中區、chip 34px。
2. **時段列按鈕**：選中色塊的「⏱ 時段」列新增「▶ 只播此時段／⏹ 停止循環」文字鈕（可發現性、無障礙、手機大目標）。
3. **進度條時段標記**：viewer 進度條上方疊加各色塊時段薄條（色＝色塊色，pointer-events:none），目前循環中的範圍加亮；與 YouTube chapters 同語彙。
4. **SSOT**：全部寫入 `_VCS.ab`，播放頁籤 A/B/AB 開關同步反映；選色 A/B 鈕亦對照播放頁籤 A/B（本次一併修正）。

# 延伸：色塊複製貼上（時段自動接續）

$$c_6: \text{「複製貼上」語意} = \text{Duplicate（Figma }\texttt{Ctrl+D}\text{／Photoshop Duplicate Layer／iOS 長按 context menu）} \;\neq\; \text{系統剪貼簿}\;(\text{Hold：跨 app 無意義，避免權限與 async 複雜度})$$
$$c_7: \text{時段接續律}: \text{dup.ab} = [T,\;T+len],\; T=\max\{s.abEnd\},\; len = src.abEnd - src.abStart,\; \text{夾住} \leq duration\;(\text{Hold：使用者明確描述，且與 NLE「貼到播放頭之後／append」一致})$$
$$c_8: \text{三入口}\;\{\text{⧉ 鈕（顯式、兩端共用）},\;\texttt{Ctrl/⌘+D}\text{（chip 可聚焦）},\;\text{手機長按 500ms + 震動}\}；\text{長按後 600ms 內合成 click 一律忽略（防誤觸選取/播放/刪除）}$$

實作：`vcDuplicateSelective(id)`（vc-filters.js）、`.vc-sel-dup-btn`（index.html）、chip `tabIndex/role/aria-label/onkeydown/touch*`。

# 延伸：派生 AB 的生命週期（Provenance 律）

$$c_9: \text{色塊時段} \perp \text{播放 AB}\;(\text{預設獨立；Hold：使用者明確期望})$$
$$c_{10}: \text{「只播此時段」} \Rightarrow \text{AB} := \text{derived}(\text{chip})，\text{記錄 } \texttt{ab.srcSel}\;(\text{NLE linked In/Out、Figma instance↔main 語彙})$$
$$c_{11}: \text{來源消失（✕ 取消時段／刪色塊／再按停止）} \Rightarrow \text{release}(\text{AB}=\varnothing)；\text{來源編輯} \Rightarrow \text{follow}；\text{播放頁籤手動改 AB} \Rightarrow \text{detach}(\texttt{srcSel}=null)$$

實作：`_releaseDerivedAb/_followDerivedAb`（vc-filters.js），`vcSetAbPoint/vcAbSpanEdit/vcClearAb` 清 `srcSel`（vc-playback.js），AB preset 載入亦為手動來源。

# 延伸：色塊操作面（手機誤觸）、顏色圓盤、灰階選取

$$c_{12}: \text{色塊上的微型按鈕（×／▶）} \Rightarrow \text{手機命中率低、與「選取」主動作競爭} \Rightarrow \text{Fail} \to \text{Reframe：色塊只保留「選取」，次要動作全部集中到工具列（Material chips / iOS 一致：chip 本身不疊小鈕）}$$
$$c_{13}: \text{選取有時段的色塊} \Rightarrow \text{直接套用該時段播放（派生 AB，可由時段列 ⏹ 停止）}；\text{工具列順序} = \text{顏色}\to\text{取色}\to\text{複製}\to\text{移除}$$
$$c_{14}: \text{「顏色」鈕} \to \text{顏色圓盤 popover（Figma colour popover／iOS UIColorPicker）：預覽 + 色環 + HEX/RGB 輸入 + 清除取色}；\text{透明度不適用於「選色遮罩」（遮罩強度＝選色寬度）}$$
$$c_{15}: \text{黑白灰（S<20\%）hue 不穩} \Rightarrow \text{舊版拒絕取色（Lightroom HSL 同限制）} \to \text{Reframe：Resolve Luminance Qualifier——改以「明度選取」模式（|L−L_0|<寬度 ∧ 低飽和），色調滑桿＝上色色相}$$
$$c_{16}: \text{viewer 頂列「資訊」「控制」同一 drawer} \Rightarrow \text{合併為單一「控制」入口，記憶上次 tab（手機頂列省空間）}$$
