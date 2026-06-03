---
item: verdict
date: 2026-05-23
status: complete
decision: C
depends_on: [ecosystem-discovery, eagle-viewer-analysis, frappe-capability-analysis, comparative-analysis]
---

# Item 5: Verdict — Eagle Viewer 轉型 Frappe 可行性判決

## 判決：C — 不值得轉型，維持現有 Eagle Viewer 架構

---

## 決定性理由

### 1. Frappe 生態完全空白，無法跳過自行開發（Item 1）
Item 1 調研完整搜尋 Frappe 生態（5 組關鍵字 + Awesome Frappe 192 個 App + 官方市集），確認**不存在任何可套用的媒體瀏覽或 DAM App**。最接近候選 Frappe Drive 是自有儲存系統，根本無法掛接讀取 Eagle `.library` 本地 JSON 結構；Photos App 開發停滯（17 stars）且作者自薦改用外部工具。選項 A 直接排除。轉型 Frappe 的代價是從零開發所有核心元件（Eagle Library Reader、Gallery UI、Tag Filter、Folder Tree 等），而這些元件在現有架構中已有完整實作（6663 行可運作代碼）。

### 2. Windows 一般用戶部署門檻是不可逾越的根本障礙（Item 3）
Item 3 明確評定：Frappe 在 Windows 環境需先安裝 WSL 2 + Ubuntu，再安裝 MariaDB、Redis、Gunicorn 等整套服務，有經驗的開發者需 30–60 分鐘，一般用戶評級為「**不現實**」（Item 3 §部署複雜度總結）。Eagle App 的主力用戶群正是 Windows 一般用戶。相比之下，Eagle Viewer 目前僅依賴 Python stdlib（唯外部依賴 pystray + Pillow 均非核心），雙擊 `start.vbs` 即可啟動（Item 2 §技術棧）。部署門檻的退化不是可以工程努力解決的技術問題，而是框架設計哲學的根本差異。

### 3. 核心架構根本錯配，Frappe 最大優勢對本案完全無用（Item 3 + Item 4）
Item 3 分析指出：Frappe 的核心價值（DocType ORM 自動生成 CRUD UI、角色權限、資料庫複合查詢）建立在 MariaDB 之上。而 Eagle Viewer 的資料來源是檔案系統 JSON 結構（Eagle `.library`），讀取此資料需繞過 ORM（`@frappe.whitelist()` + 直讀檔案系統），結論是「Frappe 的自動生成 UI、內建 CRUD、角色權限對這個資料來源全部無用武之地」（Item 3 §需求 1 結論）。Item 4 的得失矩陣也明確列出：移植後 Seed-based 洗牌、Transform Snapshot、智慧裁切、Per-video Filter Link、TikTok 手勢播放器等特色功能**全部需要重新開發**（Item 4 §轉型後得失矩陣）。

### 4. 現有技術負債完全可在原架構修復，無需換框架（Item 2 + Item 4）
Item 2 識別的技術負債（serve.py 1153 行 God 檔案、video-controls.js 1397 行、HIDE_TAGS 等 6 處硬編碼、9 個捨棄欄位、資料夾樹未解析）均為架構設計問題，而非框架能力不足造成。Item 4 的對比也指出：僅需針對性重構（拆分 serve.py、補齊缺失欄位、引入 Vue 3 僅作前端改善），即可以遠低於全量移植的成本改善代碼品質，且不損害任何現有功能。換言之，換 Frappe 是「為了解決工具箱混亂問題而換一間倉庫」，代價與收益嚴重不對稱。

### 5. 移植帶來的唯一明確收益（LAN 多用戶）不是當前需求（Item 2 + Item 4）
Item 4 的轉型得失矩陣顯示，移植後唯一能帶來淨增益的場景是「多用戶 LAN 共享 + 角色權限」。然而 Eagle Viewer 目前是單人本地工具，Item 2 的架構從未涉及認證機制設計。該需求若未來出現，也可在現有架構加輕量認證（如 HTTP Basic Auth 或 token）實現，無需引入完整 Frappe 堆疊。

---

## 前提條件

此判決（C：不值得轉型）成立於以下假設。若以下任一假設改變，判決可能需要重新評估：

1. **目標用戶不擴展至多人共享場景**：若維護者明確決定將 Eagle Viewer 演進為「家庭/小組 LAN 共享媒體平台」，且目標用戶可接受 Linux/macOS 安裝流程，Frappe 的角色權限與 MariaDB 多用戶能力才開始有淨效益（判決可能轉為 B）。

2. **Eagle App 官方提供標準化 API（非 JSON 直讀）**：若未來 Eagle App 提供 HTTP API 或 SQLite DB 格式，移除了直讀 `.library` JSON 的依賴，Frappe ORM 的資料結構化能力才能真正發揮。目前 Eagle 官方無此計畫（Item 1 調研未見相關資訊）。

3. **維護者自身技術棧轉向 Frappe 生態**：若維護者本身已深度使用 Frappe 於其他專案（如 ERPNext），且在 Frappe 生態開發效率顯著高於 Vanilla Python，可考慮將 Eagle Viewer 作為 Frappe App 的一個模組。但此為個人技術棧選擇，非客觀評估依據。

4. **Windows 原生 Frappe 出現可行方案**：若未來出現穩定的 Windows 原生 Frappe 安裝方案（非 WSL），部署門檻問題緩解，Item 3 的「根本障礙」評定將需要修訂。

---

## 風險評估

選擇 Verdict C（維持現有架構）後，以下風險需持續關注：

### 短期風險（0–6 個月）
- **serve.py God 檔案繼續增長**：若不主動重構，每新增功能都將進一步加重 serve.py 的耦合。技術負債利滾利，最終變得難以修改（Item 2 §架構問題第 9 條識別的風險）。
- **HIDE_TAGS 等硬編碼繼續累積**：目前 17 個使用者特定標籤寫死在 utils.js，若資源庫或標籤體系擴大，維護者需頻繁修改原始碼（Item 2 §硬編碼值）。

### 中期風險（6–18 個月）
- **資料夾樹功能缺失成為真實痛點**：Eagle 資料夾階層結構目前完全未解析（Item 2 §資料模型問題第 13 條），若使用者資源庫規模繼續擴大（目前已 74,351 筆），缺乏資料夾導覽將限制可用性。
- **localStorage 雙重存儲的 LWW Merge 不可靠**：video-controls.js 內的 schema migration 代碼（運行時遷移）存在升版風險（Item 2 §狀態管理問題第 16 條），若未清理，未來遷移路徑愈發複雜。
- **star / annotation / duration 欄位缺失**：提取時捨棄的 9 個 Eagle 原始欄位（Item 2 §資料模型問題第 12 條）使進階篩選（按評分、按備註、按時長範圍）無法實作。

### 長期風險（18 個月以上）
- **Vanilla JS 前端工程化缺口**：隨功能增長，無框架 + window.* 全域曝露的前端架構難以維護，但遷移至 Vue 3 是可單獨執行的前端改善，不影響後端（Item 4 §開發者視角得失矩陣）。
- **Windows 平台鎖定風險**：目前 tray.py 的 `taskkill`、路徑反斜線等 Windows-only 設計（Item 2 §平台限制），限制了未來在 macOS 或 Linux 使用的可能性。

---

## 下一步建議

維持現有 Eagle Viewer 架構的同時，建議按以下優先順序漸進改善技術負債：

### 優先級 1：消除硬編碼（低風險，高效益）
- 建立 `data/config.json` 擴充欄位（或新增 `settings.json`），將 `HIDE_TAGS`、`PORT`、`PAGE`、`MAX_HISTORY`、`DEV_MODE` 遷移為可設定項，使用者不需修改原始碼即可自訂。
- `VIDEO_PATTERNS` / `POST_PATTERNS` 提取為 JSON 設定檔，允許使用者擴充 URL 分類規則而不動 serve.py 核心。

### 優先級 2：補齊 Eagle 原始欄位（中等工程量，解鎖進階功能）
- 在 `urls_data.json` 的提取邏輯中補充 `star`（評分）、`annotation`（備註）、`duration`（影片時長）、`folders`（資料夾 ID 陣列）欄位。
- 同時提取資源庫根目錄的 `folders.json`（Eagle 資料夾樹 metadata），建立資料夾 ID → 名稱 + 父子關係的對應表。
- 前端加入「按資料夾瀏覽」側欄與「按評分篩選」Chip，補全 Item 2 §資料模型問題識別的缺口。

### 優先級 3：拆分 serve.py God 檔案（中等風險，改善可維護性）
建議按職責拆分為以下模組：
- `server/routes.py`：HTTP 路由分派
- `server/indexer.py`：Eagle library 掃描 + 增量索引邏輯
- `server/tracker.py`：觀看紀錄 CRUD
- `server/config.py`：config 讀寫 + library 管理
- `server/url_classifier.py`：VIDEO_PATTERNS / POST_PATTERNS 分類邏輯（恢復原 `scripts/extract_urls.py` 的獨立性）
- `serve.py` 保留為啟動入口，import 各模組

### 優先級 4：前端組件化（高工程量，僅在功能繼續擴展時優先執行）
- 考慮將 `video-controls.js`（1397 行）拆分為三個獨立模組：`video-filter.js`、`video-transform.js`、`video-playback.js`，消除 localStorage 存取散落問題。
- 若前端繼續新增功能，可評估引入 Vue 3（不依賴 Frappe），僅替換前端構建工具，後端 serve.py 維持不變。此舉可獲得組件化、hot reload、TypeScript 支援，同時不引入任何後端複雜度。

### 不建議執行的事項
- **不要移植至 Frappe**（本 Verdict 結論）。
- **不要在未完成優先級 1–2 的情況下啟動前端框架遷移**：硬編碼與欄位缺失是更基礎的問題，框架遷移不能解決這些問題。
- **不要引入資料庫（SQLite / MariaDB）替代 JSON 存儲**：目前純 JSON 的資料主權（可讀、可備份、可手動修改）是 Eagle Viewer 的核心設計優勢之一，引入 DB 的收益不足以彌補可讀性的損失（在單用戶本地場景下）。
