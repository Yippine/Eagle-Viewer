---
source: workflow-role-research
task: masonry-reading-order
date: 2026-05-23
workflow: w001-research
topic: 瀑布流左→右閱讀序業界最佳實踐調研
---

# 瀑布流左→右閱讀序業界最佳實踐

$$\text{Research} = \text{IndustrySurvey} \to \text{TradeoffAnalysis} \to \text{Recommendation}(\text{Eagle Viewer})$$

---

## 一、根本矛盾

$$\text{Masonry}(\text{height-optimal}) \perp \text{ReadingOrder}(\text{left→right})$$

瀑布流的核心算法（greedy shortest-col）天生與左→右閱讀序衝突：
- **Masonry 最佳化目標**：每個 item 放入最短欄 → 欄高均等 → 視覺整齊
- **閱讀序目標**：item i 在視覺位置上先於 item i+1（左→右、上→下）
- 兩者同時最佳化在數學上無解，只能取平衡點

---

## 二、業界主流做法

### 2.1 Pinterest / Unsplash / Instagram

$$\text{Industry} = \text{accept(column-primary)} \Rightarrow \text{UX = discovery, not reading}$$

| 平台 | 方案 | 閱讀序 |
|------|------|--------|
| Pinterest | 多欄絕對定位 greedy | 欄主序（接受） |
| Unsplash | CSS 欄 / 絕對定位 | 欄主序（接受） |
| Instagram | Grid / 瀑布流混合 | 視情況 |

**結論**：三大平台均接受欄主序，因為其 UX 以「發現」為主，使用者不依賴嚴格閱讀序。Eagle Viewer 的排序功能明確需要閱讀序，故需要不同策略。

---

### 2.2 Masonry.js（Metafizzy）★ 最相關

$$\text{Masonry.js}(\texttt{horizontalOrder: true}) = \text{left-priority placement}$$

- **GitHub Stars**：~17k（2026-05）
- **核心選項**：`horizontalOrder: true`
- **行為**：每次放置 item 時，在「高度未超過閾值」的欄中選最左者
- **效果**：item 在同一「視覺行」內從左到右分佈，犧牲欄高均等
- **原理等效**：

```
for each item:
  leftmost_col = find min(colHeight) columns
  if multiple cols at similar height → pick leftmost
  place in that col
```

- **適合 Eagle Viewer**：✅ 邏輯可直接以純 JS 實作，無需引入 library

---

### 2.3 Isotope.js（Metafizzy）

$$\text{Isotope} = \text{Masonry.js 超集（filter/sort）+ horizontalOrder}$$

- **GitHub Stars**：~11k
- 同樣支援 `horizontalOrder`，但功能更重
- **對 Eagle Viewer**：引入過重，非必要；其 `horizontalOrder` 邏輯可直接借鑑

---

### 2.4 CSS Grid Masonry（原生）

$$\text{grid-template-rows: masonry} = \text{瀏覽器原生，閱讀序正確}$$

- **支援度**：Firefox only（behind flag），Chrome/Safari 尚未支援（2026-05）
- **閱讀序**：✅ 原生左→右
- **適合 Eagle Viewer**：❌ 生產環境不可用，等待瀏覽器標準普及

---

### 2.5 Round-Robin 欄分配

$$\text{RoundRobin}: \text{cols}[i \bmod n].\text{push}(\text{item}_i)$$

- **最簡實作**：`for (let i = 0; i < sorted.length; i++) cols[i % numCols].push(sorted[i])`
- **閱讀序**：✅ 嚴格左→右（同一視覺行）
- **代價**：欄高差異大（高圖叢集在同欄）
- **適合 Eagle Viewer**：⚠️ 可作最快速修復，但視覺欄高不均

---

### 2.6 React 生態系

| Library | 方案 | 閱讀序 | 備註 |
|---------|------|--------|------|
| react-masonry-css | 欄 split | 欄主序 | 不適用 |
| react-responsive-masonry | 欄 split | 欄主序 | 不適用 |
| masonic | 絕對定位 greedy | 欄主序 | 有 virtual list |
| Tanstack Virtual | virtual list | N/A | 解決效能，不解閱讀序 |

---

## 三、方案比較

| 方案 | 閱讀序 | 欄高均等 | 實作複雜度 | Eagle Viewer 適用 |
|------|--------|---------|-----------|-------------------|
| CSS column-count（現況） | ❌ 欄主序 | ✅ | 低 | 已用，問題所在 |
| Round-Robin | ✅ | ⚠️ 差 | 極低 | ⚠️ 最快修復 |
| `horizontalOrder` 算法 | ✅ | ✅ 較均等 | 中 | ✅ **推薦** |
| CSS Grid masonry | ✅ | ✅ | 低 | ❌ 瀏覽器支援不足 |
| 引入 Masonry.js | ✅ | ✅ | 低（lib） | ⚠️ 增加 bundle size |

---

## 四、選定方案：純 JS 絕對定位 + HorizontalOrder 算法

$$\text{Solution} = \text{AbsPositioning}(\text{Eagle metadata 精估高}) + \text{HorizontalOrder}(\text{leftmost threshold})$$

### 4.1 為何選此方案

1. **閱讀序正確**：left-priority 讓同視覺行的 item 從左到右
2. **Eagle 有精準高度資料**：`item.width` / `item.height` 均已在 metadata 中，可精準算 aspect ratio，解決方案 B 的估高問題
3. **無外部 lib**：純 JS，維持零依賴
4. **shuffle 隔離**：只在排序模式啟用，shuffle 保持不變

### 4.2 算法說明

$$\text{HorizontalOrder}(\text{item}) = \min_{c} \left\{ c : \text{colH}[c] \leq \min(\text{colH}) + \varepsilon \right\}$$

```
for each item in sorted:
  minH = min(colHeights)
  ε = colWidth × 0.3   // 相對欄寬，自適應響應式
  candidates = columns where colHeight ≤ minH + ε
  col = leftmost(candidates)
  place item at (col * colWidth, colHeight[col])
  colHeight[col] += estimatedHeight(item, colWidth) + gap
```

**ε 必須相對欄寬，不可固定**：

$$\varepsilon = \text{colWidth} \times k, \quad k \approx 0.3$$

| ε 值 | 行為 | 問題 |
|------|------|------|
| 固定 100px | 卡片高 300px+ 時，col0 被錯誤排除或永遠入選 | ❌ 不合理 |
| ε = 0 | 嚴格最短欄優先，等同 greedy | ❌ 閱讀序差 |
| ε = ∞ | 永遠選 col0，直到其高度差距超出才換欄 | ❌ 複現「堆在第一格」bug |
| ε = colWidth × 0.3 | 欄寬的 30%，自適應桌面/平板/各欄數 | ✅ 推薦 |

**「堆在第一格」bug 根因**：ε 設過大（例如 1000px）時，col0 高度 300px 仍符合 `0 + 1000 = 1000`，永遠是候選，Item 1、2、3 全部落入 col0。ε = colWidth × 0.3 確保單張卡片放入後（≈ colWidth × aspectRatio > ε），下一個 item 必定換欄。

### 4.3 高度估算修復

$$\text{estimatedHeight}(item, colWidth) = colWidth \times \frac{item.height}{item.width} + \text{cardPadding}$$

Eagle 資料中 `item.width` 和 `item.height` 均有值，直接使用 aspect ratio 估算，不依賴 DOM `offsetHeight`（解決方案 B 的 lazy load 問題）。

### 4.4 DOM 渲染方案

從 CSS `column-count` 改為**絕對定位容器**：

```css
#grid {
  position: relative;
  /* 移除 column-count */
}
.grid-item {
  position: absolute;
  width: calc((100% - gap * (cols - 1)) / cols);
}
```

JS 設定每個 item 的 `top` / `left`，容器高度 = `max(colHeights)`。

### 4.5 Shuffle 隔離

```js
if (state.curSort === 'shuffle') {
  // 原有 CSS column-count 邏輯（不變）
  grid.style.position = '';
  items.forEach(el => { el.style.position = ''; el.style.top = ''; el.style.left = ''; });
} else {
  // 新的絕對定位 horizontalOrder
  applyHorizontalOrderMasonry(items);
}
```

---

## 五、預期效果與限制

### 效果

- 排序模式下，同一視覺行的卡片從左到右與排序一致
- 欄高相對均等（ε threshold 調節）
- 高圖不再像 greedy 那樣跳欄

### 限制

- ε 參數需 tuning（建議預設 100px，可設為 CSS 變數讓使用者調整）
- 欄數變化（resize）需重算所有 item 位置
- 無圖 item（`!item.width`）使用預設比例 3:4，估算略有誤差

---

## 六、實作建議

### 修改檔案

- `viewer/js/grid.js`：主要改動
  - 移除 `_interleaveForColumns`
  - 新增 `_applyHorizontalOrderMasonry(items)`
  - 在 `renderGrid` / `appendPage` 末端呼叫
- `viewer/css/grid.css`：移除 `column-count`，容器改 `position: relative`

### 實作步驟

$$\text{Impl} = \text{RemoveColumnCount} \to \text{AddHorizontalOrderFn} \to \text{WireUpSortBranch} \to \text{Verify}$$

1. `grid.css`：`#grid` 移除 `column-count`，加 `position: relative`
2. `grid.js`：新增 `_estimateHeight(item, colWidth)` 使用 metadata
3. `grid.js`：新增 `_applyHorizontalOrderMasonry(items, ε=100)` 絕對定位
4. `grid.js`：`renderGrid` 末端依 `curSort` 分支
5. 驗證視覺閱讀序與 shuffle 行為

---

$$\delta(\text{research}) = \text{IndustrySurvey}[\text{Masonry.js/Isotope/CSS-Grid/RoundRobin}] \to \text{Selected}[\text{HorizontalOrder + AbsPos + Eagle metadata}] \to \text{ImplSpec}[\text{grid.js + grid.css}]$$
