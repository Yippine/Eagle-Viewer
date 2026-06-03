---
item: eagle-viewer-analysis
date: 2026-05-23
status: complete
---

# Item 2: Eagle Viewer 現況深度分析

## 目錄結構

```
Eagle-Viewer/
├── viewer/                   # 主應用目錄（Python server + 前端）
│   ├── serve.py              # 後端主程式（1153 行，Python stdlib）
│   ├── tray.py               # System Tray 啟動器（173 行，pystray）
│   ├── index.html            # 單頁前端入口（502 行）
│   ├── style.css             # 主 CSS 入口
│   ├── manifest.json         # PWA manifest
│   ├── icon.svg / icon.ico   # 應用圖示
│   ├── make_icon.py          # 圖示生成腳本
│   ├── js/                   # 前端 ES Module（13 個模組）
│   │   ├── main.js           # 應用入口點（622 行）
│   │   ├── state.js          # 全域狀態中心（28 行）
│   │   ├── api.js            # Server API 呼叫（70 行）
│   │   ├── grid.js           # Grid 渲染 / Masonry / 無限滾動（297 行）
│   │   ├── renderer.js       # 卡片 HTML 建構（120 行）
│   │   ├── search.js         # 搜尋查詢解析 + 篩選邏輯（90 行）
│   │   ├── ui-filters.js     # Domain / Tag / Preset 篩選 UI（167 行）
│   │   ├── video-controls.js # 影片三模組控制（1397 行）
│   │   ├── player-desktop.js # 桌面沉浸式播放器（330 行）
│   │   ├── player-mobile.js  # 手機 TikTok 風格播放器（363 行）
│   │   ├── modal.js          # Lightbox 圖片/影片預覽（217 行）
│   │   ├── stats.js          # 觀看統計面板（254 行）
│   │   ├── shuffle.js        # Seed-based 洗牌系統（60 行）
│   │   └── utils.js          # 常數 + 純工具函式（41 行）
│   └── css/                  # 拆分 CSS 模組（10 個檔案，1774 行）
│       ├── tokens.css        # CSS Custom Properties（36 行）
│       ├── header.css        # Header + Filters（174 行）
│       ├── grid.css          # Grid + Card 樣式（185 行）
│       ├── filters.css       # Domain / Tag / Preset Chip（134 行）
│       ├── modal.css         # Lightbox（69 行）
│       ├── stats.css         # 統計面板（225 行）
│       ├── video-controls.css# 影片控制面板（544 行）
│       ├── player-desktop.css# 桌面播放器（171 行）
│       ├── player-mobile.css # 手機播放器（190 行）
│       └── responsive.css    # RWD 斷點（46 行）
├── data/                     # 已提取的 JSON 索引 + 設定
│   ├── config.json           # 資源庫路徑設定（手動維護）
│   ├── user_data.json        # 使用者濾鏡 Preset + Transform Snapshot
│   ├── 1 - Handsome.library/ # 每個資源庫的 data 子目錄
│   │   ├── urls_data.json    # 提取後的 item 索引
│   │   ├── views.json        # 觀看紀錄
│   │   └── .index_manifest.json # mtime 增量索引快照
│   └── ...（其餘 4 個資源庫同上結構）
├── scripts/
│   └── create_shortcut.ps1  # Windows 桌面捷徑建立腳本
├── logs/
│   ├── eagle_viewer.log      # Server + tray 日誌
│   └── eagle_viewer.pid      # PID 管理
├── start.bat                 # 除錯啟動腳本
└── start.vbs                 # 靜默啟動腳本（無 console 視窗）
```

## 技術棧

### 後端
| 組件 | 技術 | 版本 |
|------|------|------|
| Runtime | Python | 3.x（stdlib only，無外部依賴） |
| HTTP Server | `http.server.BaseHTTPRequestHandler` + `ThreadingMixIn` | stdlib |
| GUI Tray | `pystray` | 外部依賴 |
| 圖示生成 | `Pillow` (PIL) | 外部依賴 |
| 並發模型 | Thread-per-request，per-library Lock | stdlib |

### 前端
| 組件 | 技術 |
|------|------|
| 框架 | 無框架 Vanilla JS（ES Modules, 'use strict'） |
| 樣式 | Pure CSS（自訂 CSS Custom Properties，無 TailwindCSS） |
| 頁面模型 | SPA（單一 index.html，動態 DOM 操作） |
| 模組系統 | `<script type="module">`，13 個 ES Module |
| PWA 支援 | manifest.json（可加入主畫面）|

### 資料格式
- 輸入：Eagle App 原始 `metadata.json`（.info 資料夾格式）
- 中間層：提取後的 `urls_data.json`（每資源庫一份）
- 狀態儲存：`views.json`（Server-side）+ `localStorage`（Client-side）
- 使用者設定：`user_data.json`（Server-side），與 `localStorage` 雙向 LWW Merge

---

## 架構分析

### 後端（Python / stdlib HTTP）

**主程式：`viewer/serve.py`（1153 行）**

路由實作為 `_Handler` class 的 `do_GET` / `do_POST`，以 if-elif 鏈手動分派：

```
GET  /                    → 302 redirect → /viewer/
GET  /viewer/*            → 靜態服務 VIEWER_DIR
GET  /images/{lib}/*      → 靜態服務 LIBRARY_PATHS[lib]/images/*
GET  /data/{lib}/*        → 靜態服務 DATA_DIR/{lib}/*
GET  /api/browse          → 呼叫 tkinter 原生目錄選擇器
GET  /api/config          → 回傳 config 狀態
GET  /api/libraries       → 列出所有已設定資源庫（含 extracted 狀態）
GET  /api/views           → 取得指定資源庫的觀看紀錄
GET  /api/user-data       → 取得濾鏡 Preset + Transform Snapshot
POST /api/config          → 新增資源庫路徑
POST /api/extract         → 觸發完整索引建立（_run_one）
POST /api/track           → 記錄一次觀看（含 duration）
POST /api/delete-view     → 刪除單筆觀看紀錄
POST /api/clear-views     → 清除指定資源庫全部紀錄
POST /api/user-data       → LWW merge 並儲存 user_data
```

**索引引擎**：兩種模式
- `_run_one(lib_name)`：全量重建，掃描所有 .info 目錄
- `_run_incremental(lib_name)`：mtime 增量模式
  - Level 1：images/ 目錄 mtime 快速檢查
  - Level 2：os.scandir 取各 .info dir mtime
  - Diff 計算 added / modified / deleted，僅重建有異動部分

**並發安全**：
- `_lib_locks: dict = defaultdict(threading.Lock)`：per-library 鎖，不同庫並發寫入互不阻塞
- `_extract_lock`：全域索引鎖，序列化多個索引請求

**影片串流**：支援 HTTP Range Request（206 Partial Content），分 64KB chunk 傳輸

**URL 分類**（內嵌在 serve.py 中）：
- 28 種 VIDEO_PATTERNS（YouTube / Bilibili / Twitter / TikTok 等）
- 28 種 POST_PATTERNS（Twitter / Instagram / Pixiv / Danbooru 等）
- 分類結果：`video` | `post` | `other`

---

### 前端（Vanilla JS ES Modules）

**狀態管理（`state.js`）**：單一可變物件
```javascript
state = {
  ALL:      [],      // 全部 items（從 urls_data.json 載入）
  VIEWS:    {},      // 觀看紀錄（從 /api/views 載入）
  filtered: [],      // 篩選 + 排序後的結果
  shuffled: [],      // 洗牌結果暫存
  page:     0,       // 目前已渲染分頁數
  activeLib: '',     // 目前選中資源庫名稱
  curDomain: 'all',  // 目前選中網域篩選
  curType:   'all',  // 類型篩選（bookmark/video/gif/image）
  curTags:   Set(),  // 目前選中標籤集合（AND 邏輯）
  curQ:      '',     // 搜尋字串
  curPreset: null,   // 目前選中濾鏡 Preset 篩選
  curSort:   'shuffle',
  tagsOpen:  false,
  fbarOpen:  false,
  presetOpen: false,
}
```

**模組職責分工**：
- `main.js`：啟動序列（init）、Library 切換、事件綁定、`window.*` 曝露
- `grid.js`：`applyFilter()`（重算 filtered → 渲染 grid）、Masonry 引擎、無限滾動 IntersectionObserver、Lazy video 替換
- `renderer.js`：`buildCard(item)` 產生卡片 HTML 片段
- `search.js`：`parseQuery(raw)` / `matchItem(item, terms)` / `computeFiltered()`，純邏輯無 DOM
- `ui-filters.js`：Domain Chip / Tag Chip / Filter Preset Panel
- `video-controls.js`：三模組控制（Filter / Transform / Playback）+ 智慧裁切 + Server Sync
- `player-desktop.js`：桌面沉浸式播放器，鍵盤快捷鍵控制
- `player-mobile.js`：TikTok 風格手機播放器，手勢控制
- `modal.js`：Lightbox 圖片預覽（支援縮放 1~8×，平移）
- `stats.js`：觀看歷史（按日期分組）+ 統計分析（TOP20 / 網域分佈 / 月趨勢圖）
- `shuffle.js`：Seed-based 洗牌，同一天 seed 歷史可前後翻頁
- `api.js`：fetch wrapper（trackView / deleteHistoryEntry / clearAllViews）
- `utils.js`：PAGE=40、KIND_ICON、HIDE_TAGS 常數、h() / fmtTime() 等工具

**Grid 渲染模式**：
- `shuffle` 模式：CSS column-count 自然流排列（真流式 Masonry，無絕對定位）
- 排序模式：JS 手動 Masonry（absolute positioning，HorizontalOrder 演算法，epsilon=colW×0.3 取最左近似欄）

**分頁**：每頁 PAGE=40，IntersectionObserver sentinel 觸發 `appendPage()`，rootMargin 300px 預載

---

### 資料流（Eagle JSON → API → Frontend）

```
Eagle App 寫入
  └─ {lib_path}/images/{id}.info/metadata.json
                              └─ serve.py 掃描
                                    │
                              _run_one() / _run_incremental()
                                    │
                              data/{lib}/urls_data.json
                                    │
                              GET /data/{lib}/urls_data.json
                                    │
                              state.ALL = data.items
                                    │
                         computeFiltered()
                         seededShuffle() / _sortItems()
                                    │
                         appendPage() → buildCard() → DOM
```

**觀看紀錄流**：
```
User 點擊卡片
  └─ trackView(item)
       ├─ 本地 state.VIEWS 即時更新
       └─ POST /api/track → server _track_view() → data/{lib}/views.json
```

**User Data Sync（濾鏡 Preset + Transform Snapshot）**：
```
頁面載入 → _syncLoad()：從 /api/user-data 取得，合併至 localStorage
修改後 300ms debounce → _syncSave()：POST /api/user-data，LWW merge
setInterval(10s) + visibilitychange → _syncPoll()：版本號比較，有新版本才同步
```

---

## Eagle App 資料模型

### 原始 `metadata.json`（Eagle App 寫入）

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | string | Eagle 內部唯一 ID（大寫英數，如 `LDS2C9HQZU7MV`）|
| `name` | string | 檔案名稱（無副檔名）|
| `size` | number | 檔案大小（bytes）|
| `btime` | number | 建立時間（Unix ms）|
| `mtime` | number | 修改時間（Unix ms）|
| `ext` | string | 副檔名（如 `mp4`, `jpg`）|
| `tags` | string[] | 標籤陣列（使用者自訂，可含中文）|
| `folders` | string[] | 所屬資料夾 ID 陣列（一個 item 可在多個資料夾）|
| `isDeleted` | boolean | 是否已刪除（軟刪除）|
| `url` | string | 原始來源 URL（可空）|
| `annotation` | string | 使用者備註（可空）|
| `modificationTime` | number | 使用者修改時間（Unix ms）|
| `star` | number | 星號評分（0-5）|
| `width` | number | 媒體寬度（pixels）|
| `height` | number | 媒體高度（pixels）|
| `resolutionWidth` | number | 原始解析度寬（可與 width 不同）|
| `resolutionHeight` | number | 原始解析度高 |
| `duration` | number | 影片時長（秒，float，圖片無此欄）|
| `palettes` | object[] | 主色調陣列（`{color:[R,G,B], ratio, $$hashKey}`）|
| `lastModified` | number | 最後修改時間（Unix ms，Eagle 內部）|

**注意**：`folders` 儲存的是資料夾 ID，需要另讀 `metadata.json` 的資料夾設定才能對應到資料夾名稱。

### 提取後 `urls_data.json`（serve.py 建立）

```json
{
  "library": "1 - Handsome.library",
  "stats": {
    "total": 331,
    "video": 154,
    "post": 0,
    "other": 177,
    "domains": 1
  },
  "items": [
    {
      "id": "LDS2C9HQZU7MV",
      "name": "体育生大J 1S@shire1305950445 221211",
      "url": "",
      "domain": "local",
      "kind": "video",
      "tags": ["E0 設定", "2人", "男性", "收藏", ...],
      "thumb": "images/1 - Handsome.library/LDS2C9HQZU7MV.info/..._thumbnail.png",
      "file": "images/1 - Handsome.library/LDS2C9HQZU7MV.info/....mp4",
      "media_type": "video",
      "width": 720,
      "height": 1028
    }
  ]
}
```

**提取時捨棄的原始欄位**：`size`、`btime`、`mtime`、`ext`、`folders`、`isDeleted`、`annotation`、`modificationTime`、`star`、`resolutionWidth`、`resolutionHeight`、`duration`、`palettes`、`lastModified`

### `views.json`（觀看紀錄）

```json
{
  "{item_id}": {
    "name": "string",
    "domain": "string",
    "views": 5,
    "first_viewed": "2026-04-01T10:00:00Z",
    "last_viewed":  "2026-05-20T15:30:00Z",
    "total_watch_time": 425,
    "history": [
      { "t": "2026-04-01T10:00:00Z", "d": 95 }
    ]
  }
}
```

最多保留 `MAX_HISTORY = 2000` 筆歷史。

### `user_data.json`（使用者設定）

```json
{
  "version": 1779522803677,
  "filterPresets": [
    {
      "id": "mo5lh1hc3qja",
      "name": "偏亮・高對比・冷色調",
      "filter": { "brightness": 1.9, "contrast": 1.5, "saturate": 1.35, "hueRotate": 183 },
      "createdAt": "2026-04-19T...",
      "modifiedAt": 1776594039177,
      "deleted": false
    }
  ],
  "transformSnapshots": {
    "{item_id}": {
      "tx": {
        "scaleX": 1.1429,
        "scaleY": 1.1429,
        "translateX": -12.5,
        "translateY": 0,
        "rotate": 0,
        "flipH": false,
        "flipV": false,
        "_cropTop": 16,
        "_cropBottom": 16,
        "_cropLeft": 0,
        "_cropRight": 0
      },
      "savedAt": 1776594039177,
      "deleted": false
    }
  }
}
```

LWW（Last Write Wins）Merge 規則：
- `filterPresets`：以 `modifiedAt` 比較，取較新者
- `transformSnapshots`：以 `savedAt` 比較，取較新者
- 軟刪除：`deleted: true` 保留在 merge 中以傳播刪除狀態

---

## 功能清單

### 資源庫管理
- 多資源庫支援（透過 `data/config.json` 設定多個 `.library` 路徑）
- 瀏覽器內 Library Selector（`<select>`），切換後重置所有篩選條件
- 原生目錄選擇器（`/api/browse` → tkinter filedialog）
- 動態新增資源庫（不需重啟 Server）
- 首次設定引導頁（未設定時顯示設定表單）
- localStorage 記憶上次選擇的資源庫（`eagle-active-lib`）

### 索引建立
- 全量索引（`/api/extract`，POST）
- mtime 增量索引（啟動時自動執行，Level 1 + Level 2 兩層快速檢查）
- 未匯出資源庫自動觸發索引（UI 顯示 loading 指示器）
- 索引中重複 Eagle ID 自動去重

### 媒體瀏覽
- Masonry 瀑布流（兩種模式：CSS column-count / JS absolute positioning）
- 無限滾動（IntersectionObserver，300px 預載，每頁 40 筆）
- 圖片卡片（lazy loading，含 `width`/`height` HTML 屬性避免 CLS）
- 影片卡片（Lazy video 替換：IntersectionObserver 400px 預載，入視口才載入 `<video>`）
- 縮圖背景（CSS background → 入視口換真實 video）
- Transform Snapshot 縮圖預覽（已裁切影片在縮圖上顯示正確裁切比例）
- 書籤卡片（無媒體，純圖示 + 文字）
- Eagle App 深連結（`eagle://item/{id}`）

### 篩選系統
- 類型 Pill（書籤 / 影片 / 動圖 / 圖片，再點取消，AND 邏輯）
- 網域 Chip（按數量排序，顯示各網域 item 數）
- 標籤面板（TOP 120 標籤，AND 多選邏輯）
- 濾鏡 Preset 篩選（按 per-video filter link 過濾）
- 標籤面板 / 網域欄可摺疊

### 搜尋
- 全域搜尋（debounce 180ms）
- 支援欄位前綴：`name:` / `tag:` / `domain:` / `url:` / `kind:` / `id:`
- 中文欄位別名：`名稱:` / `標籤:` / `網域:` / `類型:` / `網址:`
- 排除語法（`-keyword`）
- 引號完整詞搜尋（`"phrase"`）
- AND 邏輯（多詞同時符合）

### 排序
- 隨機洗牌（Seed-based，同一天內可前後翻頁歷史，Mulberry32 PRNG）
- 最新加入 / 最早加入（按 Eagle ID lexicographic 順序）
- 名稱 A→Z / Z→A（zh-TW locale）
- 標籤 A→Z（第一個標籤，zh-TW locale）
- 排序模式切換時自動切換 Masonry 引擎

### 圖片 Lightbox（modal.js）
- 縮放（1×~8×，滾輪縮放，焦點跟隨游標位置）
- 拖曳平移（縮放後）
- 雙擊重置縮放
- 空白區域點擊關閉

### 影片播放器（桌面版，player-desktop.js）
- 沉浸式全螢幕播放器（backdrop 遮罩）
- 三段視窗模式：windowed / maximized / fullscreen（F 鍵循環）
- 鍵盤快捷鍵：Space（播/暫停）/ ←→（±5s）/ ↑↓（切換）/ F（全螢幕）/ M（靜音）/ C（控制面板）/ Esc（關閉）
- 滑鼠互動：單擊播/暫停 / 雙擊全螢幕 / 滾輪縮放（焦點縮放）
- 靜止 3s 自動隱藏 UI
- 影片計數器（N / 總數）
- 同網域影片 Playlist（依當前篩選結果）
- 播放進度條（input[type=range]）
- 以標籤搜尋按鈕（套用當前影片所有標籤）
- 外部連結按鈕

### 影片播放器（手機版，player-mobile.js）
- TikTok 風格全螢幕沉浸式
- 手勢：單擊清屏、雙擊播/暫停、左右拖快退進、上下滑切換、左緣右滑關閉
- 雙指捏合縮放（1~4×）
- 播放進度條 + 時間顯示
- 標籤搜尋 / 外部連結 / 影片控制按鈕

### 影片控制面板（video-controls.js，1397 行）

**色彩濾鏡模組**：
- brightness / contrast / saturate / hue-rotate 滑桿
- 命名濾鏡庫 CRUD（新增、重命名、刪除）
- 自動名稱建議（根據數值判斷：偏亮/偏暗/高對比/高飽和/褪色/暖色調/冷色調）
- Per-video 濾鏡連結（每部影片記憶已套用的 Preset）
- 上次套用的 Preset 自動載入

**幾何變換模組**：
- scaleX / scaleY / translateX / translateY / rotate 滑桿
- 水平翻轉 / 垂直翻轉按鈕
- 90°旋轉按鈕
- Per-video Transform Snapshot（每部影片獨立保存幾何設定）
- 軟刪除（deleted flag，供 LWW merge 傳播刪除狀態）

**智慧裁切（vcSmartCrop）**：
- Canvas 擷取當前畫面，以 pixel scan 偵測黑邊（THRESH=12，STEP=4 跳步）
- 支援旋轉 / 翻轉後的正確黑邊偵測（視覺座標 ↔ native 座標轉換）
- 異常保護（黑邊比例 > 45% 警告）

**手動裁切 Overlay（vcToggleCropMode）**：
- 8 個拖曳把手（nw/n/ne/w/e/sw/s/se）
- 裁切後自動計算 CSS Transform（scale + translate）並儲存快照
- 在裁切模式中可疊加智慧裁切（只更新框位置，不重啟模式）

**播放設定模組**：
- 單曲循環 / 自動播放下一部（loopMode）
- 播放速度（0.1~10×，對數滑桿）
- AB Loop（設定 A/B 點，切換開關）

**Autoplay Next**：由 player-desktop / player-mobile 各自提供回呼函式

**Server Sync**（user_data.json）：
- 頁面載入時同步
- 修改後 300ms debounce 寫回
- setInterval 10s + visibilitychange 輪詢版本號

### 觀看統計（stats.js）
- 歷史紀錄 Tab：按日期分組（今天/昨天/MM/DD），最近 100 筆
- 統計分析 Tab：
  - 總觀看次數 / 已觀看項目數 / 總停留時間
  - 最多觀看的網域 / 平均停留時間 / 有時間紀錄數
  - TOP 20 最常觀看列表（含縮圖）
  - 網域觀看分佈 bar chart（TOP 8）
  - 近 12 個月觀看趨勢 column chart
- 單筆歷史刪除 / 全部清除
- 從統計面板直接播放影片或開啟圖片

### System Tray（tray.py）
- Windows 系統列圖示（pystray）
- 選單：開啟 / 重新啟動（DEV_MODE）/ 結束
- PID 管理（`eagle_viewer.pid`），啟動時 taskkill 舊 process
- 以 daemon thread 啟動 serve.py（`import serve; serve.main()`）
- 日誌寫至 `logs/eagle_viewer.log`

### 其他
- Hardware back button / popstate 支援（依序關閉最上層 overlay）
- X.com / Twitter 深連結（手機端嘗試喚起 X App，失敗才開瀏覽器）
- CORS 標頭（`Access-Control-Allow-Origin: *`）
- PWA manifest（可加入主畫面）
- Dark mode CSS variables（tokens.css）

---

## 技術負債與痛點

### 硬編碼值

1. **預設 Port `8765`**（serve.py:1120，tray.py:31）：直接寫死在兩個檔案，需同步修改
2. **`MAX_HISTORY = 2000`**（serve.py:46）：不可設定
3. **`PAGE = 40`**（utils.js:4）：分頁大小不可設定
4. **`DEV_MODE = True`**（tray.py:12）：應在 release 前改為 False，但以 Python 原始碼管理
5. **HIDE_TAGS 常數**（utils.js:6-10）：17 個使用者特定標籤寫死在程式碼中，不可設定
6. **VIDEO_PATTERNS / POST_PATTERNS**（serve.py:52-121）：28+28 個 URL 分類 Regex 硬編碼

### 架構問題

7. **URL 分類內嵌在 serve.py**（serve.py:52-163）：原本是獨立的 `scripts/extract_urls.py`，後來 inline 進 server，有 "inlined from scripts/extract_urls.py" 的注釋，雙重維護問題
8. **inline onclick 全局函式**（index.html / renderer.js）：大量 `window.*` 曝露，`onclick="functionName()"` 模式，難以測試，Renderer 產生的 HTML 字串中有大量 `onclick` 屬性
9. **serve.py 是一個 1153 行的 God 檔案**：routes、索引邏輯、views 追蹤、user_data 合併、config 管理、URL 分類全部混在同一檔案
10. **CORS 全開**（`Access-Control-Allow-Origin: *`）：本地工具可接受，但遷移至 Server-Side 需要重新設計
11. **video-controls.js 1397 行**：三個不同關注點（Filter / Transform / Playback）混合在同一模組，localStorage 存取散落各處

### 資料模型問題

12. **提取時捨棄大量欄位**：`star`（評分）、`annotation`（備註）、`duration`（影片時長）、`folders`（資料夾 ID）、`palettes`（主色調）、`isDeleted` 等均未保留在 `urls_data.json`，導致無法做進階篩選
13. **folders 欄位未解析**：Eagle App 的資料夾樹狀結構完全被忽略，只保留 tags 平坦清單
14. **`kind` 分類在索引時固定**：`video` / `post` / `other` 由 URL 正則決定，後續前端無法動態修改，post 類型現況幾乎為 0（測試資料庫中）

### 狀態管理問題

15. **transform snapshot 在 localStorage 和 server 間雙重存儲**：`eagle-transform-{id}` 在 localStorage，同時又在 `user_data.json` 的 `transformSnapshots`，複雜的 LWW merge 邏輯
16. **舊版 Schema Migration**（video-controls.js:125-198）：兩段 migration 代碼（`eagle-presets` → `eagle-filter-presets`，`eagle-video-*` → `eagle-video-filter-*`），運行時遷移不可靠

### 平台限制

17. **僅 Windows 相容**：
    - `tray.py` 使用 `taskkill` 命令（Windows-only）
    - `start.bat` / `start.vbs` 是 Windows 腳本
    - `config.json` 中的 library 路徑使用 Windows 反斜線
    - tkinter filedialog 在某些 Linux 環境可能缺失
18. **tkinter 相依**（serve.py:845-858）：`/api/browse` 路由需要 tkinter，在無 GUI 的 headless 環境會失敗

---

## 關鍵數據

| 指標 | 數值 |
|------|------|
| 後端代碼行數 | serve.py: 1153 行 + tray.py: 173 行 = **1326 行** |
| 前端 JS 代碼行數 | **3061 行**（13 個模組）|
| 前端 CSS 代碼行數 | **1774 行**（10 個模組）|
| HTML 代碼行數 | **502 行** |
| **總代碼行數** | **6663 行** |
| API 端點數 | GET: 6 個 / POST: 5 個 = **11 個** |
| 前端 ES Modules 數 | **13 個** |
| CSS 模組數 | **10 個** |
| Eagle 資源庫數 | **5 個** |
| 已索引 Items 總數 | **74,351 筆**（5 個庫合計）|
| 最大單庫 Items | **66,140 筆**（3 - TSJH.library）|
| Eagle metadata.json 欄位數 | **20 個** |
| 提取後保留欄位數 | **11 個** |
| 捨棄的原始欄位數 | **9 個**（star / annotation / duration / folders / size / btime / mtime / palettes / isDeleted）|
| VIDEO_PATTERNS 數 | **28 個** regex |
| POST_PATTERNS 數 | **28 個** regex |
| HIDE_TAGS 數 | **17 個**（硬編碼）|
| views.json MAX_HISTORY | **2000** 筆/item |
| 預設 Port | **8765** |
| 影片串流 chunk 大小 | **64KB** |
| sync poll 間隔 | **10 秒** |
| 搜尋 debounce | **180ms** |
| 每頁 Items | **40 筆** |
| Infinite scroll 預載距離 | sentinel: 300px / vidObs: 400px |
| 影片縮放範圍（桌面播放器）| scroll：無限制（CSS transform）|
| 圖片縮放範圍（Lightbox）| **1~8×** |
| 手機播放器縮放範圍 | **1~4×**（捏合）|
