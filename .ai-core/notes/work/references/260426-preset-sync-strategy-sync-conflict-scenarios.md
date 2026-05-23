# Sync & Conflict Scenarios — preset-server-sync

> **任務範圍**：僅同步濾鏡設定，不涉及影片資源本身的 CRUD。
>
> **Preset** = 使用者儲存的濾鏡設定組合（如 `"Warm" → {brightness:1.1, saturate:1.3, ...}`），可命名後一鍵套用到任意影片。
>
> **同步策略：Union Merge + LWW (Last-Write-Wins) by `modifiedAt`**
> Server 執行 merge，Client 收到 merged result 後更新 cache。
> 「Union」= 若一方有而另一方無，保留；不自動刪除。

---

## 術語

| 符號 | 意義 |
|------|------|
| PC↑ | PC 在線，server 可被手機連到 |
| PC↓ | PC 離線（server 不可達）或 server 關閉 |
| M↑(cold) | 手機剛開瀏覽器，cache 為空，上線即 GET |
| M↑(warm) | 手機頁面已開著，cache 有資料，重連後觸發 _syncSave |
| M↓ | 手機斷線中 |
| LWW | modifiedAt 較新者勝 |
| Union | 兩邊都有 → 保留；只有一邊 → 保留 |

> **一般使用模式**：同時間只用一台裝置（不是 PC 就是手機）。
> cold start 是最常見情境，warm reconnect 是邊緣情境。

---

## 一、Preset（濾鏡設定組合）

### C — 新增 Preset

#### C-1：一邊新增，另一邊之後才開啟（最常見）

```
PC 新增 Preset "Warm"
之後手機 cold start → GET → 拿到 "Warm"
```
**結果：** 手機看到 ✓

---

#### C-2：雙邊各自在不同時間新增（交替使用）

```
PC 新增 Preset "Warm"（存入 server）
之後手機 cold start → GET → 看到 "Warm"
手機 新增 Preset "Cool" → POST → 存入 server
之後 PC 重整 → GET → 看到 "Warm" + "Cool"
```
**結果：** 兩邊最終都有全部 preset ✓

---

#### C-3：雙邊同時在線各自新增不同 Preset（少見）

```
PC 新增 "Warm"（modifiedAt=100）→ POST → server 有 "Warm"
同時 M↑(warm) 新增 "Cool"（modifiedAt=110）→ POST
Server merge：Union → 保留 "Warm" + "Cool"
兩邊 response 都拿到 merged result
```
**結果：** 無衝突，兩邊都有全部 ✓

---

### U — 修改 Preset

#### U-1：一邊修改，另一邊之後才開啟（最常見）

```
PC 改 "Warm" 的 brightness（modifiedAt=200）→ POST → server 更新
之後手機 cold start → GET → 拿到最新版 "Warm"
```
**結果：** ✓

---

#### U-2：雙邊都在線，先後修改同一 Preset

```
PC 改 "Warm" name="Warm+"（modifiedAt=200）→ POST
M↑(warm) 改 "Warm" brightness=1.3（modifiedAt=210）→ POST
Server merge：LWW → modifiedAt=210 的手機版整包勝出
```
**結果：** 手機版存活，PC 的 name 修改丟失。⚠️
> LWW 是 per-preset 整包，不是 per-field。同時雙邊改同一 preset 是真實衝突，較舊的一方會丟失。這是已接受的 tradeoff（單使用者交替使用，同時改同一 preset 極稀有）。

---

### D — 刪除 Preset

#### D-1：一邊刪除，另一邊之後才開啟（最常見）✓

```
PC 刪除 "Warm" → POST → server 不含 "Warm"
之後手機 cold start → GET → 拿到不含 "Warm" 的清單
```
**結果：** 刪除正確傳播 ✓
> **你的一般使用模式屬於此情境，刪除完全正常。**

---

#### D-2：刪除時另一邊頁面已開著且突然斷線（邊緣情境）

```
PC 和手機都在線，手機頁面開著（cache 有 "Warm"）
手機突然斷線（M↓）
PC 刪除 "Warm" → POST → server 不含 "Warm"
手機網路恢復（M↑ warm reconnect）→ _syncSave 帶 cache（含 "Warm"）
Server merge：Union → "Warm" 在手機 cache 存在 → "Warm" 復活
```
**結果：** "Warm" 重新出現在 server，PC 下次 GET 又看到它。⚠️

> **觸發條件**：PC 與手機**同時在線** + 手機頁面開著 + 手機中途斷線 + PC 在斷線期間刪除。
> **你的使用模式（交替使用，只開一台）不會觸發此情境。**

---

#### D-3：一邊刪除後另一邊離線中曾套用過該 Preset

```
PC 刪除 "Warm"（server 已無 "Warm"）
手機之前套用過 Video-X → "Warm"，但手機那時是離線的
手機 cold start，上線後 GET → 拿到不含 "Warm" 的清單
但 videoPresets 裡 Video-X.presetId = "Warm"（孤立關聯）
```
**結果：** 手機不再顯示 "Warm" preset，但 Video-X 的 presetId 紀錄仍指向一個不存在的 ID。
> UI 層需處理「preset 不存在」的 graceful fallback（不 crash，顯示「已刪除」或清空）。
> 這是實作時要注意的邊界，不屬於 sync 衝突，而是 UI 防禦性設計。

---

## 二、VideoPreset（影片套用了哪個濾鏡）

VideoPreset = `{ presetIds: string[], lastUsed: string | null, modifiedAt: number }`

#### VP-1：一邊對影片套用 Preset，另一邊之後開啟（最常見）

```
PC 對 Video-X 套用 "Warm"（modifiedAt=100）→ POST
之後手機 cold start → GET → Video-X 套著 "Warm" ✓
```

---

#### VP-2：雙邊對不同影片操作（交替使用的常見情境）

```
PC 對 Video-X 套用 "Warm"
手機 對 Video-Y 套用 "Cool"
→ Union → Video-X→"Warm", Video-Y→"Cool" 都保留 ✓
```

---

#### VP-3：雙邊對同一影片套用不同 Preset（衝突）

```
PC 對 Video-X 套用 "Warm"（modifiedAt=100）
M↑(warm) 對 Video-X 套用 "Cool"（modifiedAt=110）
Server merge：LWW → modifiedAt=110 勝 → Video-X → "Cool"
```
**結果：** 較新的操作勝出 ✓（VideoPreset LWW 比 Preset LWW 更合理，因為「套用 preset」就是使用者最後一次的明確選擇）

---

#### VP-4：清空影片的 Preset 關聯

```
PC 清空 Video-X.presetIds=[]（modifiedAt=200）→ POST
之後手機 cold start → GET → Video-X 無 Preset ✓
```
> VideoPreset 的「清空」比 Preset 的「刪除」安全：LWW 可正確傳播清空操作（modifiedAt=200 代表「這次清空是最新意圖」）。

---

## 三、情境總表

| # | 操作 | 觸發條件 | 最終結果 | 安全性 |
|---|------|----------|----------|--------|
| C-1 | 新增 Preset，另一邊之後開 | 交替使用（常見） | 正常同步 | ✅ |
| C-2 | 交替新增不同 Preset | 交替使用（常見） | 全部保留 | ✅ |
| C-3 | 同時在線各自新增 | 同時使用（少見） | Union 保留全部 | ✅ |
| U-1 | 修改 Preset，另一邊之後開 | 交替使用（常見） | 正常同步 | ✅ |
| U-2 | 同時修改同一 Preset | 同時使用（少見） | LWW，舊方丟失 | ⚠️ |
| D-1 | 刪除 Preset，另一邊之後開 | 交替使用（常見） | 刪除正常傳播 | ✅ |
| D-2 | 刪除時另一邊頁面開著中途斷線 | 邊緣情境 | Preset 復活 | ⚠️ |
| D-3 | 刪除後孤立的 VideoPreset 關聯 | 任意時序 | UI 需 fallback | ⚠️ UI層 |
| VP-1 | 套用 Preset，另一邊之後開 | 交替使用（常見） | 正常同步 | ✅ |
| VP-2 | 對不同影片操作 | 交替使用（常見） | Union 保留全部 | ✅ |
| VP-3 | 對同一影片套用不同 Preset | 同時使用（少見） | LWW，較新者勝 | ✅ |
| VP-4 | 清空影片關聯 | 任意 | LWW 正確傳播 | ✅ |

---

## 四、設計選擇說明

```
Union 語意    → 保護資料，不自動刪除（D-2 的代價：邊緣情境下刪除可能復活）
LWW per-preset → 整包以 modifiedAt 決勝（U-2 的代價：per-field 修改可能丟失）
LWW per-video  → VideoPreset 以 modifiedAt 決勝（更合理，代表最後一次明確選擇）
```

> **你的使用模式（交替使用，一次只開一台）命中的都是 C-1、C-2、U-1、D-1、VP-1、VP-2。**
> 這些情境全部安全，無資料丟失風險。

---

## 附錄：若未來需讓 delete 跨離線正確傳播（解決 D-2）

引入 **tombstone（軟刪除）**：

```js
// 刪除時不移除，改標記
{ id: "warm", ..., deleted: true, modifiedAt: Date.now() }

// UI 渲染時過濾
presets.filter(p => !p.deleted)

// merge 時 LWW → deleted=true 也能作為「最新意圖」傳播
```

tradeoff：user_data.json 累積已刪除的記錄，需定期清理。
當前設計選擇 Union 無 tombstone，適合交替使用的單使用者場景。
