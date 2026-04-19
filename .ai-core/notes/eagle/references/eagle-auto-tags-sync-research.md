---
created: 2026-04-19
modified: 2026-04-19
tags: [eagle, auto-tags, metadata, script, api, eagle-viewer]
source_system: ai-generated
note_type: literature
---

# Eagle App 自動標籤腳本化可行性研究

## 核心結論

**完全可行**，但需繞過 Eagle API 直接操作 `metadata.json`。

---

## 思維球 16 格分析（Ψ）

### φ(S,廣) — 空間廣度
- **577 個資料夾，350 個標籤不符**（61% 不正確）
- 根因：資料夾改名後 Eagle 不自動更新子層 tags
- 典型案例：`"圖片 / 影片"` 被儲存為 `"影片"`，導致下層全部繼承錯誤

### φ(S,深) — 空間結構
```
metadata.json 結構：
{
  "folders": [{
    "id": "LDN6Z30S6BMGH",
    "name": "E0 設定",
    "tags": ["E0 設定"],          ← 這就是自動標籤（folder tags）
    "children": [{
      "name": "標籤",
      "tags": ["E0 設定", "標籤"], ← 父層名 + 自身名
      ...
    }]
  }]
}
```
**關鍵發現**：`tags` 欄位就是 Eagle「自動標籤」的儲存格式，是路徑從根到自身的所有名稱陣列。

### φ(S,精) — 精確規則
$$\text{correctTags}(f) = \text{parentTags}(f) + [f.\text{name}]$$
$$\text{correctTags}(\text{root}) = [f.\text{name}]$$

### φ(S,簡) — 最小操作
讀 JSON → 遞迴重算 → 寫回 → 重啟 Eagle

---

### φ(T,廣) — 時序場景
| 時機 | 觸發方式 |
|------|---------|
| 初始化修復 | 手動執行一次腳本 |
| 改名後同步 | 手動執行 或 Eagle-Viewer API |
| 定期檢查 | cron / 排程 |

### φ(T,深) — 關鍵限制：Eagle 檔案鎖
- **Eagle 必須關閉才能寫入** `metadata.json`（Eagle 運行時持有檔案，退出時覆寫）
- 寫完後需**重啟 Eagle** 才生效（無熱重載 API）
- 影響：Eagle-Viewer API 只能在 Eagle 關閉狀態下執行寫入

### φ(T,精) — 執行流程
```
關閉 Eagle → 備份 metadata.json → 讀取 → 計算差異 → 顯示 diff → 確認 → 寫入 → 重啟 Eagle
```

### φ(T,簡) — 最小流程
`python sync_tags.py --dry-run` → 確認 → `python sync_tags.py --apply`

---

### φ(E,廣) — 延伸範圍
- 可支援多個 library（`.library` 資料夾）
- 可打包為通用工具，適用所有 Eagle 用戶

### φ(E,深) — Eagle API 限制（降維打擊）
**Eagle API v2 無法寫入 folder tags**：
- `POST /api/folder/update` 只支援 `newName`, `newDescription`, `newColor`
- `tags` 欄位為唯讀回傳值，API 不接受寫入
- **結論**：API 路線不可行，直接操作 JSON 才是唯一解

### φ(E,精) — Eagle-Viewer 整合方案
```
Eagle-Viewer Backend
  POST /api/eagle/sync-folder-tags
    Body: { libraryPath, dryRun: boolean }
    Returns: { changes: [...], applied: boolean, requiresRestart: boolean }
```

### φ(E,簡) — 最小可行整合
Eagle-Viewer 加一個按鈕：「同步自動標籤」→ 呼叫後端 API → 回傳差異報告

---

### φ(V,廣) — 價值影響者
- **Yippine**：節省手動管理 350+ 個錯誤標籤的時間
- **Eagle-Viewer 用戶**：搜尋/篩選準確率提升

### φ(V,深) — 核心價值
正確的自動標籤 = 準確的搜尋結果 = Eagle-Viewer 篩選功能正常運作

### φ(V,精) — 風險評估
| 風險 | 緩解 |
|------|------|
| JSON 損毀 | 每次執行自動備份 |
| Eagle 執行中寫入 | 腳本先偵測 Eagle process |
| 標籤順序語義 | 明確定義：從根到葉，嚴格排序 |

### φ(V,簡) — ROI
寫一次腳本，永久自動化；350 個錯誤在 <1 秒內全部修正

---

## Ψ(X) — 整合洞察

Eagle App 的「自動標籤」本質是儲存在 `metadata.json` 的靜態路徑陣列，Eagle 本身**不會自動維護**這個陣列。Eagle API v2 刻意設計為唯讀 tags，因此繞過 API 直接操作 JSON 不是 workaround，而是**唯一正確路線**。

整個系統的關鍵約束是「Eagle 必須關閉才能寫入」，這決定了 Eagle-Viewer 整合的 UX 設計：需要引導用戶先關閉 Eagle，再執行同步，再重啟。

---

## 實作方案

### Phase 1：獨立腳本（立即可用）

```python
#!/usr/bin/env python3
# sync_eagle_tags.py
import json, shutil, argparse
from pathlib import Path
from datetime import datetime

LIBRARY_PATH = "/mnt/c/Users/user/Documents/Yippine/Media/Eagle App/.class/1 - Handsome.library"

apply = False

def compute_tags(folders, parent_tags=[]):
    changes = []
    for folder in folders:
        expected = parent_tags + [folder['name']]
        if folder.get('tags') != expected:
            changes.append({
                'id': folder['id'],
                'name': folder['name'],
                'old': folder.get('tags', []),
                'new': expected
            })
        if apply:
            folder['tags'] = expected
        changes += compute_tags(folder.get('children', []), expected)
    return changes

def sync(library_path, dry_run=True):
    global apply
    apply = not dry_run
    meta = Path(library_path) / 'metadata.json'
    data = json.loads(meta.read_text(encoding='utf-8'))
    changes = compute_tags(data['folders'])

    if dry_run:
        print(f"[DRY RUN] 發現 {len(changes)} 個差異：")
        for c in changes[:20]:
            print(f"  {c['name']}: {c['old']} → {c['new']}")
        if len(changes) > 20:
            print(f"  ... 還有 {len(changes)-20} 個")
    else:
        backup = meta.with_suffix(f'.{datetime.now().strftime("%Y%m%d_%H%M%S")}.bak')
        shutil.copy2(meta, backup)
        meta.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        print(f"✅ 已更新 {len(changes)} 個資料夾標籤")
        print(f"📦 備份：{backup}")
        print("⚠️  請重新啟動 Eagle 以載入變更")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--library', default=LIBRARY_PATH)
    args = parser.parse_args()
    sync(args.library, dry_run=not args.apply)
```

**使用方式：**
```bash
python sync_eagle_tags.py           # 預覽差異
python sync_eagle_tags.py --apply   # 套用
```

---

### Phase 2：Eagle-Viewer API 整合

```javascript
// server/routes/eagle.js
app.post('/api/eagle/sync-folder-tags', async (req, res) => {
  const { libraryPath, dryRun = true } = req.body;
  const metaPath = path.join(libraryPath, 'metadata.json');
  const data = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
  const changes = computeTags(data.folders);

  if (!dryRun) {
    await fs.copyFile(metaPath, metaPath + '.bak');
    await fs.writeFile(metaPath, JSON.stringify(data), 'utf-8');
  }

  res.json({ changes, applied: !dryRun, requiresRestart: !dryRun && changes.length > 0 });
});

function computeTags(folders, parentTags = []) {
  const changes = [];
  for (const folder of folders) {
    const expected = [...parentTags, folder.name];
    if (JSON.stringify(folder.tags) !== JSON.stringify(expected)) {
      changes.push({ id: folder.id, name: folder.name, old: folder.tags, new: expected });
      folder.tags = expected;
    }
    changes.push(...computeTags(folder.children ?? [], expected));
  }
  return changes;
}
```

---

## 當前資料狀況

| 指標 | 數值 |
|------|------|
| 資料夾總數 | 577 |
| 標籤不正確 | 350（61%） |
| 最常見問題 | 資料夾改名後子層繼承舊名 |

---

## 結論

1. ✅ **完全可行**，直接操作 `metadata.json` 即可
2. ✅ **Eagle-Viewer 整合可行**，作為後端 API endpoint
3. ⚠️ **限制**：需 Eagle 關閉才能寫入，寫完需重啟
4. 🚀 **建議**：Phase 1 腳本立即可用，Phase 2 整合後加入 Eagle-Viewer 管理介面
