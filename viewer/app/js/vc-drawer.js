/* ── vc-drawer.js ▸ Viewer 右側控制 drawer（B3）──────────────────────────
   直接重用舊版 vc-panel 模組（#vc-panel DOM 已搬入 app/index.html，id 全數
   保留 vc-*）：開合 = toggleVcPanel/closeVcPanel、tab 切換 = vcSwitchTab、
   手機 bottom-sheet 拖曳三檔吸附 = vcInitDragHandle（皆為舊版行為原樣）。
   本模組只負責：app 端開合入口、`&drawer=` URL 參數（replaceState，不佔
   history，spec §5.4 #2）、與 ⓘ 資訊 pane（檔名/庫/資料夾/尺寸…）渲染。 */

import { toggleVcPanel, closeVcPanel as _vcClose, vcSwitchTab, vcSyncPanel,
         vcInitDragHandle }
  from '../../viewer/js/video-controls.js';
import { h, fmtSize, fmtDate, fmtDuration } from './items.js';

/* tab ↔ URL 參數（spec §5.3：drawer=info|play|filter|color|geo）*/
const TAB2PARAM = { info: 'info', playback: 'play', filters: 'filter',
                    color: 'color', transform: 'geo', image: 'view' };
const PARAM2TAB = Object.fromEntries(Object.entries(TAB2PARAM).map(([k, v]) => [v, k]));

const $ = id => document.getElementById(id);

export function initDrawer() {
  vcInitDragHandle();                       // 手機拖把手（40/55/80vh 吸附，舊版行為）
  // tab 點擊（inline onclick 已呼叫 vcSwitchTab）→ 追記 URL 參數
  document.querySelectorAll('.vc-tab-btn').forEach(b =>
    b.addEventListener('click', _writeParam));
}

export function isDrawerOpen() {
  return !!$('vc-panel')?.classList.contains('open');
}

function _activeTab() {
  return document.querySelector('.vc-tab-btn.active')?.dataset.tab || 'playback';
}

/** 開啟 drawer（可指定 tab）；已開啟則只切 tab */
export function openDrawer(tab = null) {
  if (!isDrawerOpen()) toggleVcPanel();     // toggleVcPanel 內含 vcSyncPanel + preset 渲染
  if (tab) vcSwitchTab(tab);
  vcSyncPanel();
  _writeParam();
}

export function closeDrawer() {
  _vcClose();
  _writeParam();
}

/** 同 tab 再按 = 關閉；否則開啟至該 tab */
export function toggleDrawer(tab) {
  if (isDrawerOpen() && (!tab || _activeTab() === tab)) closeDrawer();
  else openDrawer(tab);
}

/* ── URL 同步（replaceState，不進 history）───────────────────────────── */

function _writeParam() {
  const raw = (location.hash || '').replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  const q = new URLSearchParams(qs);
  if (isDrawerOpen() && q.get('item')) q.set('drawer', TAB2PARAM[_activeTab()] || 'play');
  else q.delete('drawer');
  const s = q.toString();
  history.replaceState(history.state, '', '#' + path + (s ? '?' + s : ''));
}

/** viewer 開啟/深連結時依 ?drawer= 還原 drawer 狀態 */
export function syncDrawerFromQuery(query) {
  const tab = PARAM2TAB[query?.get('drawer') || ''];
  if (tab) openDrawer(tab);
}

/* ── ⓘ 資訊 pane（Inspector 單選內容平移進 viewer，spec §3.2）────────── */

/**
 * @param {object} it  vm item（items.js adaptItem 形）
 * @param {object} ctx { libLabel: string, folderNames: string[] }
 */
export function setDrawerInfo(it, ctx = {}) {
  const pane = $('vc-pane-info');
  if (!pane) return;
  if (!it) { pane.innerHTML = ''; return; }

  const row = (label, val) => val
    ? `<div class="vc-info-row"><span class="vc-info-k">${h(label)}</span><span class="vc-info-v">${val}</span></div>`
    : '';
  const tags = (it.tags || []).filter(t => t !== 'archived');
  const dims = it.width && it.height ? `${it.width}×${it.height}` : '';

  pane.innerHTML = `
    <div class="vc-section">
      <div class="vc-info-name" title="${h(it.name)}">${h(it.name)}</div>
      ${row('庫', h(ctx.libLabel || ''))}
      ${row('資料夾', (ctx.folderNames || []).map(n => h(n)).join('、'))}
      ${row('尺寸', h(dims))}
      ${row('大小', h(fmtSize(it.size)))}
      ${row('時長', h(fmtDuration(it.duration)))}
      ${row('星等', it.star ? '★'.repeat(Math.min(it.star, 5)) : '')}
      ${row('網域', it.domain && it.domain !== 'local' ? h(it.domain) : '')}
      ${row('加入', h(fmtDate(it.btime)))}
      ${row('修改', h(fmtDate(it.mtime)))}
      ${row('美學分數', it.aesthetics != null ? h(it.aesthetics.toFixed(2)) : '')}
      ${it.url ? row('連結', `<a href="${h(it.url)}" target="_blank" rel="noopener">${h(it.url)}</a>`) : ''}
      ${it.annotation ? row('AI 標註', h(it.annotation)) : ''}
      ${tags.length ? `<div class="vc-info-tags">${tags.map(t => `<span class="vc-info-tag">${h(t)}</span>`).join('')}</div>` : ''}
      ${it.readOnly ? `<div class="vc-info-ro">唯讀庫（Excire）</div>` : ''}
    </div>`;
}
