---
title: "⌘K 自由詞搜尋 UX 設計教訓 + DrvFS SQLite 系統性風險"
domain: work
tags: [eagle-viewer, ux-design, sqlite, drvfs, playwright]
status: published
created: 2026-07-11
---

> 來源：eagle-viewer-vision task（已封存於 .ai-core/tasks/archived/260711/eagle-viewer-vision/），commit e111199

# Hotfix：⌘K 中文自由詞空結果（2026-07-05，commit e111199）

$$\text{Bug} = \text{⌘K}(\text{中文自由詞}) \xrightarrow{\text{預設 syntax 模式}} \texttt{\#/lib?q=...}(\text{純文字篩選}) \to \emptyset\;\text{結果} \neq \text{使用者期望}(\text{NL 語意搜尋})$$

## 根因（使用者回報 + Sonnet 診斷 + 本輪驗證）

1. ⌘K 預設 syntax 模式，無「自由詞 = 自然語言」的自動判斷
2. AI 能力不可用時靜默回退 syntax（`command-k.js` 舊 `_renderModes` 行為），使用者無感知
3. **加碼發現**：Excire SQLite 於 WSL2 DrvFS（/mnt/c）偶發 `sqlite3.OperationalError: disk I/O error`（Windows 側 Excire Foto 同開時更頻繁）→ 例外未攔截 → HTTP 連線直接斷（瀏覽器 ERR_EMPTY_RESPONSE）

## 修復（e111199）

$$\text{Fix} = \underbrace{\text{\_looksNatural}(q)}_{\text{CJK} \vee \text{多詞},\;\sim\text{field:},\;\sim\text{URL}} \to \begin{cases} \text{aiCaps().nl} & \to \text{Enter 預設 NL 搜尋} + \text{建議雙出口（AI/僅篩選）} \\ \sim\text{loaded} & \to \text{await ensureAiStatus 再決定} \\ \text{loaded} \wedge \sim\text{nl} & \to \text{明確 toast（不靜默）} \end{cases}$$

- 空狀態 CTA：`?q=` 純文字篩選 0 結果 → 「以 AI 語意搜尋」按鈕（grid.js `setEmptyStateProvider` + app.js 註冊）
- 模式記憶：localStorage `ev-ck-mode`
- Excire 容錯：`_q_local/_q_backend` OperationalError 重連重試一次 + `handle_excire_api` 路由層 try/except → 503

## 驗證

Playwright 真後端 7 項全過（NL 建議置頂/Enter 導向 mode=nl/結果 21 卡/空狀態 CTA/`kind:video` 欄位語法迴歸/模式記憶/console error 0）。

## 珍貴發現（可複用）

- **DrvFS + SQLite 是系統性風險**：任何在 /mnt/c 上開 SQLite 的模組（excire.py、未來的 ai_index 若移過去）都需要 OperationalError 重連容錯
- Playwright 對本專案的 `networkidle` 永不成立（SSE 長連線）→ 一律用 `domcontentloaded` + wait_for_selector/function
- `pgrep -f` 會匹配到呼叫者自身的 bash -c 字串 → 測試 server 收尾用 port 檢查或 PID 檔
