# AI Core — CLAUDE.md（設置律）

## δ(M1..5) 子代理人傳播協議

$$\delta(M_1): \Psi(\text{navigate}) = \text{Frame.Question} \to \text{PriorityRank}_{16} \to D_{key} \to \text{Flag}(\overline{D}) \to \text{Dispatch}(agent\text{-}role\text{-}*) + \text{Recommend}(\text{gap})$$

$$\delta(M_2): \text{Formula}(\text{internal}) \mid \text{NL}(\text{user，繁體中文})$$

$$\delta(M_3): \text{Skills}(\text{atomic}\cdot\text{flat}) + \text{task-sort}(M_3\text{.前置}) + archive \neq delete + \text{DescCharLimit}(T1 \leq 60c \mid T2 \leq 150c \mid T3 \leq 120c \mid T4 \leq 100c)$$

$$\delta(M_4): agent \times \{Schema(6),\; in\_progress \to completed \mid failed,\; \text{WriteObligation(MUST)},\; \text{Immutability}\}$$

$$\delta(M_5): \text{workflow} \times \{DSL(\text{Skill Pipeline}),\; DataFlow(\text{explicit}[sub]/\text{implicit main}),\; PhaseReady\text{-}Gate\}$$

> 完整 M1-M5 定義見 `ai-core-contract`（Layer 0）。

---

## Entity-First Resolution（隱式意圖偵測，優先級高於一切）

$$\text{EntityFirst} = \forall\;\text{問題} \to \text{先判斷是否涉及 AI Core 實體} \to \text{主動調用對應 skill} \to \text{回答}$$

| 使用者提及 | 實體 | 優先 skill |
|---|---|---|
| 人名、暱稱、「某某人」 | notes (life/work) | `note-read {人名}` |
| 任務、工作進度、最近在做 | tasks | `task-sort` 或 `task-read {name}` |
| 記憶、之前說過、你知道嗎 | memory | `memory-read {關鍵字}` |
| 事件、行程、這週、會議 | events | `event-sort` |
| 專案、計畫、project | projects | `project-sort` |
| schedule、排程、這個月 | schedule | `schedule-read` |

**FORBIDDEN（絕對禁止）：**
- ❌ 「我不知道此人物 / 我沒有關於 X 的資訊」→ 先用 `note-read` 查再回答
- ❌ 「notes 在哪個目錄 / 請告訴我路徑」→ 路徑已知（`.ai-core/notes/`）
- ❌ 「是否要為你建立新任務」→ 先用 `task-sort` 確認現有任務

---

## Non-obvious Trigger Map

非顯然 skill dispatch（Type 3/4）→ 見 `.claude/trigger-map.md`

Type 1 CRUD（`{entity}-{create/read/update/archive/link/sort}`）命名即語意，無需查表。

---

## Top-5 Entity Schema 快速參照

### task（.ai-core/tasks/{name}/TASK.md）
```yaml
task_name: slug
title: "中文顯示名"
role: work | life
status: pending | in_progress | completed | archived
priority: P0 | P1 | P2 | P3
parent: null | parent-task-name
blocked_by: []
```

### note（.ai-core/notes/{domain}/references/{name}.md）
```yaml
title: "筆記標題"
domain: work | life | tech | learning
tags: []
status: draft | published
created: YYYY-MM-DD
```

### project（.ai-core/projects/{slug}/PROJECT.md）
```yaml
slug: project-slug
title: "專案名稱"
status: ideation | planning | active | paused | completed | archived
priority: P0 | P1 | P2 | P3
```

### event（.ai-core/events/{yyMMdd}/{hhmmss}-{topic}.md）
```yaml
title: "事件標題"
datetime: "2026-05-08T14:00"
status: scheduled | done | cancelled
participants: []
```

### session（.ai-core/sessions/{session-id}/SESSION.md）
```yaml
session_id: uuid
title: "對話標題"
status: active | concluded | archived
domain: work | life | tech
```
