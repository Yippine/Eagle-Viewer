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
  curDomains: new Set(),   // 多選 OR（空 Set = 全部，替代 'all'）
  curType:    'all',
  curTags:    new Set(),
  curQ:       '',
  curPresets: new Set(),  // 多選 OR（w020：取代 curPreset 單選；空 Set = 不篩選）

  // ── 排序 key（shuffle / date / mtime / name / tags / star / size）
  curSortKey: 'shuffle',
  // ── 排序方向（'asc' | 'desc'）
  curSortDir: 'desc',

  // ── 大小範圍（載入後計算，供 log scale 進度條使用）
  sizeMin: 0,
  sizeMax: 0,

  // ── 尺寸範圍（width×height 像素量，供 dim log scale 進度條使用）
  dimMin: 0,
  dimMax: 0,

  // ── 時長範圍（秒，供 duration log scale 進度條使用）
  durationMin: 0,
  durationMax: 0,

  // ── UI 狀態 ──
  tagsOpen:   false,
  fbarOpen:   false,
  presetOpen: false,

  // ── 垃圾桶模式（true = 主 grid 只顯示封存素材）──
  trashMode:  false,

  // ── 資料夾映射（client-side，fetch /api/folders 後建立）
  // { [folder_id]: { name: string, isLeaf: boolean } }
  folderMap: {},

  // ── 資料夾篩選（OR 邏輯，Set<folder_id>；與 curTags AND 邏輯分離）
  curFolderIds: new Set(),
};
