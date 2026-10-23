/* ── page-chrome.js ▸ 中欄頁面共用 chrome（B5 自 app.js 抽出）────────────
   麵包屑 / toolbar+ibar 顯隱 / 佔位頁 / page-panel（非 grid 頁面容器：
   下載中心、人物總覽等自訂 HTML 頁掛載點，位於 #grid-wrap 內共用捲動）。 */

import { navigate } from './router.js';
import { h } from './items.js';
import { showMessage } from './grid.js';

const $ = id => document.getElementById(id);
const icon = (n, cls = 'icon icon-sm') =>
  `<svg class="${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

/** 麵包屑：[{ label, hash? }]，最後一段為 current（不可點） */
export function renderBreadcrumb(parts) {
  $('breadcrumb').innerHTML = parts.map((p, i) =>
    (i ? `<span class="crumb-sep">${icon('chevron-r')}</span>` : '') +
    (p.hash && i < parts.length - 1
      ? `<button class="crumb" data-crumb="${h(p.hash)}">${h(p.label)}</button>`
      : `<span class="crumb current">${h(p.label)}</span>`)
  ).join('');
  $('breadcrumb').querySelectorAll('[data-crumb]').forEach(el =>
    el.addEventListener('click', () => navigate(el.dataset.crumb)));
}

/** toolbar 控制列 + ibar 顯隱（grid 視圖 = true；系統頁/垃圾桶 = false） */
export function setContentChrome(showControls) {
  $('toolbar-controls').hidden = !showControls;
  $('ibar').hidden = !showControls;
}

/** 佔位/錯誤頁（佔用 grid 區域） */
export function renderPlaceholderPage(title, note, iconName = 'info') {
  renderBreadcrumb([{ label: title }]);
  setContentChrome(false);
  hidePagePanel();
  showMessage(iconName, title, note);
}

/** 取得 page-panel 容器（清空 grid、隱藏訊息）；呼叫端自填 HTML */
export function pagePanel() {
  showMessage('info', '');          // 重設 grid 內部清單狀態
  const msg = $('grid-msg');
  if (msg) msg.hidden = true;
  const p = $('page-panel');
  p.hidden = false;
  return p;
}

export function hidePagePanel() {
  const p = $('page-panel');
  if (p) { p.hidden = true; p.innerHTML = ''; }
}
