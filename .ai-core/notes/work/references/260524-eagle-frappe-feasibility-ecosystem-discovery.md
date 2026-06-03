---
item: ecosystem-discovery
date: 2026-05-23
status: complete
verdict: not-found
---

# Item 1: Frappe 生態 App 調研

## 搜尋策略

執行以下 5 組關鍵字搜尋，並對搜尋結果中具體 repo 進行 WebFetch 深度讀取：

1. `frappe app media library github`
2. `frappe digital asset management app`
3. `erpnext image gallery app github`
4. `frappe dam app site:github.com`
5. `frappe.io marketplace media`

補充調研來源：
- [Awesome Frappe](https://awesome-frappe.gavv.in/) — 192 個 App 的社群精選列表
- [Frappe Cloud Marketplace](https://cloud.frappe.io/marketplace/search) — 官方市集
- 個別 GitHub repo README 深度讀取（Photos、Digistore、Frappe Drive）

---

## 候選 App 列表

### 1. Frappe Drive

- **URL**: https://github.com/frappe/drive / https://frappe.io/drive
- **維護狀態**: 積極維護中（v0.3.0，2025-10-08；2,870+ 次 commits）
- **功能描述**:
  - 開源雲端檔案儲存與分享平台（類 Google Drive）
  - 支援大型檔案多段上傳、資料夾上傳
  - 影片串流（從伺服器直接播放）
  - 多格式檔案瀏覽器預覽
  - 協作文件編輯（Frappe Writer，基於 TipTap + YJS）
  - 細粒度權限控制（個人/群組/公開）
  - 儲存配額管理
  - S3 整合；即將推出 Desktop 桌面同步功能

- **與 Eagle Viewer 需求對比**:

  | Eagle Viewer 核心功能 | Frappe Drive | 差距 |
  |---|---|---|
  | 瀑布流 Masonry gallery UI | 未提及 | 缺失 |
  | 標籤篩選系統 | 未提及 | 缺失 |
  | 資料夾樹導覽 | 有（資料夾結構） | 有但為標準檔案樹，非 Eagle 格式 |
  | 影片播放 | 有（串流播放） | 符合 |
  | 圖片大圖瀏覽 | 有（瀏覽器預覽） | 部分符合 |
  | 讀取本地 Eagle JSON 資料夾 | 無（自有儲存系統） | 根本不符合 |
  | 依 Eagle metadata 篩選 | 無 | 根本不符合 |

- **判斷**: **不適用**
  - Drive 是「通用雲端儲存」定位，根本架構就是自己管理儲存，無法掛接讀取 Eagle App 的本地 `.library` 資料夾 JSON 結構。缺乏 Masonry UI 和標籤篩選也是硬缺口。

---

### 2. Photos（gavindsouza/photos）

- **URL**: https://github.com/gavindsouza/photos
- **維護狀態**: 實驗性專案，作者自述「過去兩年僅花費一週時間」，建議用 PhotoPrism 替代
- **功能描述**:
  - AI 驅動人臉識別與聚類（類 Google Photos）
  - 自動標記人物身份
  - Gallery UI 列為 WIP（Vue 3 App，尚未完成）

- **與 Eagle Viewer 需求對比**:

  | Eagle Viewer 核心功能 | Photos App | 差距 |
  |---|---|---|
  | 瀑布流 Masonry gallery UI | WIP，未完成 | 缺失 |
  | 標籤篩選系統 | 僅人臉標籤，無自訂標籤 | 嚴重不足 |
  | 資料夾樹導覽 | 未提及 | 缺失 |
  | 影片播放 | 未提及 | 缺失 |
  | 圖片瀏覽 | 有（基本） | 功能單薄 |
  | 讀取本地 Eagle JSON | 無 | 根本不符合 |

- **判斷**: **不適用**
  - 專案本身開發停滯（17 stars，34 commits），功能定位是人臉識別相簿，與 Eagle Viewer 的素材管理邏輯完全不同。作者自己都建議改用外部工具。

---

### 3. Digistore（NagariaHussain/digistore）

- **URL**: https://github.com/NagariaHussain/digistore
- **維護狀態**: 有一定活躍度（41 stars，21 forks），但存在 import 錯誤未解決的 issue
- **功能描述**:
  - FOSS 數位資產「分發」平台
  - 建立產品、方案（tiers）、定價
  - S3 雲端儲存 + Stripe 付款整合
  - TailwindCSS 現代 UI（SPA）
  - 支援 PDFs、MP3、影片等多格式上傳

- **與 Eagle Viewer 需求對比**:

  | Eagle Viewer 核心功能 | Digistore | 差距 |
  |---|---|---|
  | 瀑布流 Masonry gallery UI | 未提及 | 缺失 |
  | 標籤篩選系統 | 未提及 | 缺失 |
  | 資料夾樹導覽 | 未提及 | 缺失 |
  | 影片/圖片瀏覽 | 未提及 | 缺失 |
  | 讀取本地 Eagle JSON | 無 | 根本不符合 |

- **判斷**: **不適用**
  - 定位是「數位商品販售平台」（類 Gumroad），不是媒體瀏覽器。功能方向完全不同。

---

### 4. ERPNext Asset Management（frappe/assets）

- **URL**: https://github.com/frappe/assets
- **維護狀態**: 由 Frappe 官方維護
- **功能描述**:
  - 企業固定資產管理（採購、折舊、保養、移動、報廢）
  - IT 設備、辦公設備等有形資產追蹤

- **判斷**: **不適用**
  - 這是財務/會計意義上的「資產管理」，完全不是媒體數位資產（DAM）的概念。語義偏差，無交集。

---

### 5. 其他儲存整合類 App（S3/Nextcloud/WebDAV）

包含 DFP External Storage、S3 Attachments、Nextcloud Integration、PibiDAV 等。

- **判斷**: **不適用**
  - 這類 App 的職責是「替換 Frappe 的附件儲存後端」，提供 S3/Nextcloud 作為儲存層，本身不提供任何媒體瀏覽 UI，更無法讀取 Eagle App 本地 JSON 格式。

---

## 調研結論

### 結論：Frappe 生態中**不存在**可套用的媒體瀏覽或 DAM App

經過廣泛搜尋（5 組關鍵字 + Awesome Frappe 列表 + Frappe Cloud Marketplace + 3 個 repo 深度讀取），確認：

**Frappe 生態中目前沒有任何 App 能覆蓋 Eagle Viewer 的核心需求組合：**

| 需求 | 生態現況 |
|---|---|
| 讀取本地 Eagle `.library` JSON 結構 | 完全空白，無任何 App 觸及 |
| Masonry 瀑布流 gallery UI | 無成熟實現（Photos WIP 未完成） |
| 自訂多標籤篩選系統 | 無（Photos 僅有人臉標籤） |
| 資料夾樹導覽（Eagle 格式） | 無 |
| 圖片 + 影片混合瀏覽 | Drive 有部分影片串流，但無 gallery 模式 |

### 差距分析

最接近的候選是 **Frappe Drive**，它有影片串流和資料夾結構，但：
1. 是自有儲存系統，無法掛接讀取外部 Eagle 資料夾
2. 沒有 gallery / masonry UI 模式
3. 沒有標籤篩選
4. 沒有 Eagle metadata（.json 檔）解析能力

### 後續建議

既然生態中無現成可套用的 App，評估轉型 Frappe 需要自行開發以下核心元件：

1. **Eagle Library Reader**：解析 `.library/` 下的 `metadata.json`、`folders.json`、`tags.json`
2. **Media Gallery DocType**：儲存媒體 item metadata（標籤、尺寸、類型、評分等）
3. **Gallery Page**：Masonry 瀑布流 UI（Vue 3 + Frappe UI 或純 vanilla）
4. **Tag Filter Widget**：多標籤交集篩選
5. **Folder Tree Widget**：依 Eagle 資料夾結構導覽

建議繼續執行 Item 2（移植可行性評估）確認技術路徑的成本效益。
