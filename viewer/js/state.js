'use strict';
/* ── state.js  ▸  全局可變狀態（單一來源）─────────────────────────────── */

export const state = {
  ALL:       [],   // 所有項目（從 urls_data.json 載入）
  VIEWS:     {},   // 觀看紀錄（從 /api/views 載入）
  filtered:  [],   // 篩選 + 洗牌後的結果
  shuffled:  [],   // 洗牌結果暫存
  page:      0,    // 目前已渲染的分頁數

  // ── 目前選中的資源庫（資料夾名稱，e.g. "1 - Handsome.library"）──
  activeLib: '',

  // ── 篩選條件 ──
  curDomain:  'all',
  curType:    'all',
  curTags:    new Set(),
  curQ:       '',
  curPreset:  null,

  // ── UI 狀態 ──
  tagsOpen:   false,
  fbarOpen:   false,
  presetOpen: false,
};
