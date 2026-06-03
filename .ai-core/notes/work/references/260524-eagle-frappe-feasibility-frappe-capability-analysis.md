---
item: frappe-capability-analysis
date: 2026-05-23
status: complete
---

# Item 3: Frappe 框架能力深度分析

## 技術棧概覽

Frappe 是一個 full-stack Python + JavaScript web 框架，以 MariaDB 為核心資料庫，依賴以下元件：

| 元件 | Frappe v14/v15 | Frappe v16/develop |
|------|---------------|-------------------|
| Python | 3.10+ | 3.14 |
| Node.js | 18+ | 24 |
| MariaDB | 10.6.6+ | 11.8 |
| Redis/Valkey | 6 | 6+ |
| Yarn | 1.12+ | 1.22+ |
| wkhtmltopdf | 0.12.6 (patched qt) | 同左 |

**官方支援 OS：** macOS、Debian/Ubuntu Linux。  
**Windows：** 不原生支援，官方建議使用 WSL（Ubuntu in WSL）作為開發環境替代。  
**語言比例：** Python 58.3%、JavaScript 32.4%、Vue 2.0%、SCSS 3.7%。  
**授權：** MIT。  
**GitHub（截至 2026-05-22）：** 10.1k stars、5k forks、1,549 個 release、最新版 v15.108.0。

---

## DocType ORM

DocType 是 Frappe 的核心資料建模機制，兼具 **Model**（結構定義）與 **View**（介面呈現）雙重角色。

### 資料存取方式
- 透過 ORM API 讀寫資料庫，無需撰寫 SQL。
- DocType 建立時自動生成對應的 MariaDB 表（命名慣例：`tab{DocTypeName}`）。
- Meta-data 本身也儲存於資料庫，可動態修改而無需重部署代碼。

### 自動生成的介面
- **List View**：所有記錄的列表頁
- **Form View**：單筆記錄的建立/編輯頁

### 關聯結構
- **Link 欄位**：外鍵關聯至其他 DocType，類似 foreign key。
- **Child Table（Table 欄位）**：內嵌子文件清單，一對多關係，可直接在父 Form 中編輯子項目列表。
- 支援 Link、Data、Int、Float、Date、Datetime、Select、Check、Text、Attach、Attach Image 等多種欄位類型。

### 關鍵限制
DocType ORM **僅針對 MariaDB/PostgreSQL 中的資料**，無法直接對應或查詢檔案系統上的 JSON/資料夾結構（如 Eagle `.library` 格式）。若需讀取外部檔案，須額外撰寫 Python whitelisted API。

---

## 前端能力

### Desk UI
Frappe 的 Desk 是內建的 admin 介面，技術棧為 Python 後端 + jQuery/原生 JS 前端（非 Vue）。Desk 自動從 DocType meta-data 生成 List View、Form View、Report Builder、Calendar/Gantt 等介面，定位為「System User 的後台管理工具」，風格偏向 ERP 後台。

### Vue 3 整合（Doppio + frappe-ui）
Frappe 透過 **Doppio** 工具支援將 Vue 3 SPA 掛載至框架：
- 以單一 `bench` 指令自動 scaffold Vue 3 + Vite + TailwindCSS 專案。
- 可在 Desk 頁面內嵌 Vue 組件（`on_page_load` / `on_page_show` 生命週期掛鉤）。
- 亦可產生**獨立的非 Desk SPA**，以自訂路由提供服務（如 `/dashboard`、`/gallery`）。
- 自動更新 `website_route_rules` hook，支援 client-side routing。
- 開發模式支援 hot reload（`npm run build -- --apps app --watch`）。

**frappe-ui**（獨立 Vue 3 組件庫）：
- 可作為獨立 npm 套件使用，不強制依賴 Frappe 後端。
- 提供 Button、Dialog、Card、Link 等通用組件，以及 `useCall` composable（連接 Frappe API）。
- 底層使用 TailwindCSS、Headless UI、TipTap、dayjs。
- 實際用於 Frappe Cloud、Gameplan、Frappe Insights 等產品。

### Jinja Web Pages
Frappe Website 模組支援以 Jinja 模板建立公開頁面（非 Desk）：
- 可撰寫 `.html`（Jinja）+ `.py`（context controller）+ `.js`/`.css`（頁面腳本）。
- 支援自訂 CSS/JS 注入。
- 頁面路由自動依檔案路徑生成。
- **注意：** `https://frappeframework.com/docs/user/en/website` 已返回 404，該功能文件可能已遷移至 `docs.frappe.io`，部分細節未能確認。

---

## 本地部署可行性

這是評估 Eagle Viewer 移植的**最關鍵維度**。

### 官方立場
Frappe 官方支援 macOS 與 Linux（Debian/Ubuntu），**不支援原生 Windows**。官方建議 Windows 用戶透過 WSL（Windows Subsystem for Linux）操作。

### Windows 實際情況（WSL 方案）
- 需安裝 WSL 2 + Ubuntu 環境，再於其中安裝所有依賴。
- 安裝過程涉及：Python3-pip、MariaDB server、Redis server、Gunicorn/Werkzeug、Supervisor/Nginx、frappe-bench CLI 工具。
- 完整安裝估計 30–60 分鐘（有經驗的開發者），非技術用戶難度極高。
- 存在自動化工具（如 `frappe-manager`、WSL autoinstall scripts），可降低部分門檻，但仍需技術背景。

### 離線/無 Internet 執行
- **安裝階段**需要 internet（下載套件、依賴）。
- **運行階段**（安裝完成後）：Frappe 可在無 internet 的本地機器上運行，僅需本機服務（MariaDB、Redis、Python web server）。
- 離線部署替代方案：預先下載 Docker 映像，打包 `.tar` 後在目標機器載入（適合企業 air-gapped 環境，但對一般用戶複雜度更高）。

### 部署複雜度總結
| 情境 | 可行性 | 難度 |
|------|-------|------|
| Linux 開發者本地使用 | 可行 | 中等 |
| macOS 開發者本地使用 | 可行 | 中等 |
| Windows 開發者（WSL）| 可行 | 中高 |
| Windows 一般用戶（非開發者）| **不現實** | 極高 |
| 完全無 internet 運行（安裝後）| 可行 | 低（但初始安裝需 internet）|

---

## Custom Pages / Gallery UI 可行性

### 技術路徑
1. **Doppio + Vue 3 SPA**：以 `bench` 指令 scaffold 獨立 SPA，掛載於 `/gallery` 路由，完全自訂 UI（可實作 Masonry 瀑布流）。
2. **Frappe Desk Page + Vue 組件**：在 Desk 頁面內嵌 Vue 組件，較侷限於 Desk 框架風格。
3. **Jinja Web Page**：靜態 HTML + CSS + JS，適合簡單頁面，複雜 SPA 邏輯需在 JS 端自行處理。

### Masonry 瀑布流可行性
理論上可行：使用 Vue 3 SPA + 任意 CSS Grid/Masonry 庫（如 Masonry.js、CSS Grid columns）。Frappe 對前端 CSS 框架選擇沒有強制限制，TailwindCSS 天然支援。

### 多標籤交集篩選（AND 邏輯）
- 前端邏輯：完全由 Vue 3 自行實作，無限制。
- 後端查詢：Frappe ORM 支援複合 filter，AND 邏輯可行（但前提是資料在 MariaDB 中，不適用於檔案系統資料）。

### 主要挑戰
- Eagle `.library` 資料不在 MariaDB，需要**自訂 Python API**（`@frappe.whitelist()`）即時讀取檔案系統並回傳 JSON，繞過 ORM 層。
- 每次 library 變更需重新同步（或實時讀取），無法直接利用 DocType CRUD 管理。

---

## 維運成本

### hooks/fixtures 系統
- **hooks.py**：定義應用行為鉤子（`doc_events`、`override_whitelisted_methods`、`website_route_rules` 等），需理解鉤子命名與觸發時機。
- **fixtures**：以 `bench export-fixtures` 導出 DocType/Role 等設定為 JSON，用於版本控制與跨環境同步。
- **bench migrate**：每次 schema 變更需執行，確保資料庫與程式碼同步。

### 學習曲線評估
- **入門**：理解 DocType、bench 指令、hooks.py 約需 1–2 週。
- **中級**：掌握 fixtures、patches（資料遷移腳本）、Jinja web pages 約需 1–2 個月。
- **進階**：自訂 Vue SPA + Doppio、複雜 hooks 組合、多 app 依賴管理，屬於有經驗開發者領域。
- 社群反映 fixtures 文件說明不夠清晰，實際使用常需查閱論壇。
- 相較於 Express.js 或 FastAPI 等輕量框架，Frappe 的概念體系（DocType、bench、site、app 分層）獨特性較高，不易從其他框架知識遷移。

---

## 開發速度評估

### 優勢
- `bench new-app` 快速 scaffold app 骨架（hooks.py、DocType 目錄、`__init__.py` 等）。
- DocType GUI 建立表格欄位，無需手寫 SQL schema。
- 自動生成 REST API（CRUD）和 Desk UI，ERP 類應用開發極快。
- Vue 3 SPA 開發有 hot reload，前端體驗現代化。

### 劣勢
- 非 ERP 類應用（如媒體 gallery）幾乎享受不到 DocType 自動生成介面的優勢。
- 設定 Doppio + Vue SPA 有額外複雜度（需理解 Frappe routing hook 整合）。
- 每次 schema 變更需 `bench migrate`，頻繁改動時較耗時。
- 本地開發需啟動多個程序（MariaDB、Redis、Gunicorn、watch），相比單一 `node server.js` 複雜許多。

---

## 社群與文件質量

| 指標 | 數值/評估 |
|------|---------|
| GitHub Stars | 10.1k |
| GitHub Forks | 5k |
| Total Releases | 1,549（持續活躍） |
| 最新版本 | v15.108.0（2026-05-20） |
| Discuss 論壇用戶 | 22,000+ |
| 官方文件 | 已遷移至 `docs.frappe.io`，部分舊連結 redirect 或 404 |
| Frappe School | 官方訓練課程，含 bootcamp |
| 文件完整度 | 核心功能完整，fixtures/hooks 有混淆之處 |
| 中文資源 | 稀少，主要為英文社群 |

---

## 對 Eagle Viewer 需求的逐項評估

### 需求 1：讀取本地 Eagle `.library` JSON 資料夾結構（非 DB，直接讀檔案系統）

**評估：可行但繞過核心架構**

Frappe Python 後端可使用 `os`、`pathlib`、`json` 等標準庫讀取任意檔案系統路徑。透過 `@frappe.whitelist()` 裝飾器可將此功能暴露為 API 給前端呼叫。

然而這完全繞過了 DocType ORM——Frappe 最核心的優勢（自動生成 UI、內建 CRUD、角色權限）全部無用武之地。安全性上需特別注意路徑驗證，避免任意文件讀取漏洞。

**結論：技術可行，但 Frappe 的核心價值完全無法發揮。**

---

### 需求 2：Masonry 瀑布流 gallery UI

**評估：可行（需自行實作）**

透過 Doppio + Vue 3 SPA 方案，可引入任意 CSS 庫（Masonry.js、純 CSS columns、Packery 等）實作瀑布流。TailwindCSS 內建的 `columns-{n}` 或 CSS Grid 也可達成近似效果。

Frappe 本身不提供 gallery 或 masonry 組件，需完全自訂前端。

**結論：技術可行，但等同於從零寫 Vue 3 應用，Frappe 不提供捷徑。**

---

### 需求 3：多標籤交集篩選（AND 邏輯，非 OR）

**評估：前端邏輯完全可行**

Vue 3 前端可自行實作任意篩選邏輯。若資料來自 API（實時讀取 `.library` 檔案），AND 邏輯在前端或後端 Python 中都可實作。

若資料同步至 MariaDB，Frappe ORM 也支援複合 AND filter（`frappe.get_list` 的 `filters` 參數）。

**結論：完全可行，無技術障礙。**

---

### 需求 4：本地執行（無 server、無 internet），用戶直接 browser 訪問

**評估：高度不現實（對一般用戶而言）**

這是最關鍵的阻礙點：

- Frappe **必須**啟動 MariaDB、Redis、Python WSGI server（Gunicorn）才能運行，等同於在本地機器運行完整的 web 伺服器堆疊。
- Windows 不原生支援 Frappe，需先安裝 WSL 2 + Ubuntu 環境。
- 對於一般 Windows 用戶（Eagle 的主要用戶群），這個安裝門檻幾乎是不可接受的。
- 相比之下，目前 Eagle Viewer 只需 Node.js + Python stdlib（無外部依賴），任何裝了 Node.js 的機器即可啟動。

**結論：技術上「可以」（安裝完成後離線運行），但對 Eagle 現有用戶群完全不現實。這是移植的最大障礙。**

---

### 需求 5：影片播放（含自訂 controls）

**評估：可行**

HTML5 `<video>` 元素在任何 web 框架中都可使用。Frappe Website 頁面或 Vue 3 SPA 均可自由使用原生 video API 或任意 video player 庫。

Frappe 本身不提供視頻播放組件，但也不阻止使用。

**結論：完全可行，與 Frappe 無直接關聯，自行實作即可。**

---

### 需求 6：System Tray 整合（本地 app 感）

**評估：與 Frappe 完全無關，原有方案保留**

System Tray 整合屬於 OS 層功能，目前 Eagle Viewer 透過 Node.js（systray 庫）實作。若移植至 Frappe，System Tray 部分仍需獨立的 Node.js/Python 進程處理，與 Frappe 框架無法整合。

實際上，若採用 Frappe，整個「本地 app 感」的設計理念將會瓦解——Frappe 是 server-side web app 框架，不是桌面應用框架。

**結論：需保留原有 Node.js System Tray 實作，Frappe 無法提供此功能。**

---

## 關鍵結論

### 整體評分（針對 Eagle Viewer 移植場景）

| 維度 | 評分 | 說明 |
|------|------|------|
| 資料建模（DB 應用）| ★★★★★ | DocType ORM 強大，適合 ERP |
| 前端彈性 | ★★★☆☆ | Vue 3 SPA 可行，但需 Doppio 額外設定 |
| **本地部署易用性** | **★☆☆☆☆** | **Windows 用戶門檻極高，這是致命缺陷** |
| 檔案系統整合 | ★★☆☆☆ | 技術可行但繞過所有 Frappe 優勢 |
| 開發速度（ERP 類）| ★★★★☆ | 自動生成 CRUD UI，極快 |
| 開發速度（本案）| ★★☆☆☆ | 非 ERP 場景幾乎無法享受自動化優勢 |
| 社群/文件 | ★★★★☆ | 22k 社群，文件部分有缺口 |

### 強項（Frappe 真正擅長的）
1. **企業 ERP 類應用**：DocType 自動生成介面、角色權限、報表，ERPNext 是最佳佐證。
2. **多租戶 SaaS 平台**：bench 的 site 隔離機制天然支援。
3. **快速原型 CRUD 應用**：從 DocType 定義到可用的 List/Form UI，分鐘級別。
4. **有 DevOps 背景的 Linux 開發者**：完整的 CLI 工具鏈、Git-friendly。

### 弱項（對 Eagle Viewer 場景的限制）
1. **本地部署門檻**：MariaDB + Redis + WSL 對一般 Windows 用戶是難以逾越的壁壘。
2. **核心架構錯配**：Eagle `.library` 是檔案系統結構，Frappe 的核心是 DB ORM，兩者不匹配。
3. **過度設計**：Frappe 是為複雜企業應用設計，Eagle Viewer 是輕量本地工具，引入 Frappe 等同於用火炮打鳥。
4. **System Tray / 本地 App 感**：Frappe 無法替代，需額外維護原有 Node.js 機制。

### 對 Eagle Viewer 移植的主要挑戰（降序）
1. **本地部署可行性**：這是根本性障礙，目前 Eagle Viewer 用戶只需 Node.js，移植後需要完整 Linux 環境。
2. **資料架構錯配**：Eagle 資料在 `.library` JSON 資料夾，Frappe 的優勢在 MariaDB ORM，根本無法對齊。
3. **開發複雜度爆炸**：引入 MariaDB、Redis、bench、hooks、fixtures、Site 概念，維護成本遠超現有 Python stdlib server。
4. **用戶安裝體驗**：從「下載即用」退化至「安裝 WSL + 多個服務 + 學習 bench 指令」。

### 總結建議
**不建議將 Eagle Viewer 移植至 Frappe。** Frappe 是優秀的企業 Web 框架，但它的設計哲學（DB-centric、server-heavy、Linux-native）與 Eagle Viewer 的核心需求（本地輕量、檔案系統直讀、Windows 一般用戶友好）存在根本性衝突。移植不僅無法利用 Frappe 的核心優勢，反而會引入大量不必要的複雜度，同時損害現有用戶的使用體驗。
