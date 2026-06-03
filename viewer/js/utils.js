'use strict';
/* ── utils.js  ▸  常數 + 純工具函式（無副作用，無 DOM 依賴）──────────── */

export const PAGE      = 40;
export const KIND_ICON = { video: '🎬', post: '📄', other: '🔗' };
export const HIDE_TAGS = new Set([
  // ── 架構框架標籤（Eagle 資料夾層級命名，無篩選語意）──
  'E0 設定','E1 角色','E4 環境',
  '平台','影片','標籤','來源','種類','設定',
  '台主','人數','已看',
  // ── 語意平台標籤（x.com / porn / facebook / handsome 等）移出 ──
  // 讓它們出現在 Header 標籤篩選器，可與 folder chip 聯動
]);

/** HTML 跳脫 */
export function h(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "m:ss" 格式化 */
export function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

/** "X分Y秒" 格式化 */
export function fmtDuration(s) {
  if (!s || s < 1) return '';
  if (s < 60)   return `${Math.round(s)}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分${Math.round(s % 60)}秒`;
  return `${Math.floor(s / 3600)}時${Math.floor((s % 3600) / 60)}分`;
}

/** 是否為手機視口 */
export function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

/** 將檔案路徑轉為安全的 URL（處理 # 等特殊字元） */
export function encodePath(p) {
  return p.split('/').map(seg => encodeURIComponent(seg)).join('/');
}
