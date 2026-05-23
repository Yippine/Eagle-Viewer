# Audit Report：Per-Video 濾鏡功能恢復

生成時間：2026-04-26

## 問題摘要

濾鏡庫 UI/UX 改版後，以下功能消失：
1. 點擊影片自動套用該影片已儲存的濾鏡
2. 濾鏡面板「此影片已存」分區
3. 濾鏡與影片的連結/取消連結（🔖 按鈕）

## SESE 審計關鍵發現

| 問題 | 嚴重度 | 處置 |
|------|--------|------|
| `videoFilterLinks` 不應走 server sync（體積無上限、merge 衝突） | High | 採純 localStorage |
| `search.js:83` 仍讀舊 key `eagle-video-{id}`（grid 篩選失效） | 高 | 改讀新 key |
| `ui-filters.js:134` 讀舊 key `eagle-presets`（preset chip 空白）| 高 | 改讀新 key |
| `vcResetFilters` 後下次開影片仍自動套用（幽靈行為）| 中 | 重置時清 lastUsed |
| 已完成舊 migration 的用戶資料已失，無法恢復 | 事實承認 | 新 migration flag 防重跑 |

## Critic 判決

- **3 個 FATAL**：search.js key 不同步、server schema 缺欄位（已用純 localStorage 規避）、migration 死區
- **5 個 MAJOR**：LWW merge、lastUsed 語義、自動連結邊界、雙軌競態、初始化競態
- 結論：採純 localStorage 後 FATAL × 3 均解除，MAJOR 大幅簡化

## 實作變更

### `viewer/js/video-controls.js`

- 新增 `_vflKey`, `_VFL_MIGRATED_KEY` 常數
- 更新 `_migrateOnce`：在刪除 `eagle-video-{id}` 前先保存 presetIds/lastUsed 到新 key
- 新增 `_migrateVideoFilterLinks()`：補跑給已完成舊 migration 的用戶
- 新增 `_loadVideoFilterData(itemId)` / `_saveVideoFilterData(itemId, data)`
- 更新 `vcInitVid`：載入影片時自動套用 lastUsed 濾鏡
- 新增 `vcToggleVideoFilterPreset(presetId)`：連結/取消連結
- 更新 `vcApplyFilterPreset`：套用時儲存 lastUsed
- 更新 `vcSaveFilterPreset`：存新濾鏡時自動連結到當前影片
- 重寫 `vcRenderFilterPresets`：分「此影片已存」和「所有濾鏡」兩區，含 🔖 按鈕
- 更新 `vcResetFilters`：重置時清除 lastUsed（解決幽靈自動套用問題）

### `viewer/js/search.js`

- `eagle-video-${i.id}` → `eagle-video-filter-${i.id}`

### `viewer/js/ui-filters.js`

- `localStorage.getItem('eagle-presets')` → `localStorage.getItem('eagle-filter-presets')`

### `viewer/js/main.js`

- Import + `window.*` 曝露 `vcToggleVideoFilterPreset`

## 資料注意事項

已完成舊版 migration（`eagle-filter-presets` 已存在）的用戶：其 `eagle-video-{id}` 資料已被舊 migration 刪除，`presetIds/lastUsed` 無法恢復。這是不可逆的歷史資料遺失，新版將從空白開始。尚未開過新版的用戶資料會被完整保留。
