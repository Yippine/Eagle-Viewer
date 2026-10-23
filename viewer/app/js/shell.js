/* ── shell.js ▸ App chrome（B6 自 app.js 抽出 + 行動版行為補完）──────────
   主題三態（深/淺/跟隨系統，C65）、側欄收合/行動抽屜（ephemeral guard 佔
   返回鍵一層，spec §5.4 #5）、Inspector 行動 bottom sheet（拖把手 40/55/80vh
   三檔吸附）、底部 tabbar「更多」選單、localStorage 舊 key 一次性遷移（C67：
   濾鏡/選色/AB/快照 key 由共用 vc-* 模組與 user-data 同步天然相容，僅遷 seeds）。 */

import { navigate, pushEphemeral, popEphemeral, discardEphemerals } from './router.js';
import { store } from './store.js';

const $ = id => document.getElementById(id);
const _isNarrow = () => window.matchMedia('(max-width: 1279px)').matches;
const _isMobile = () => window.matchMedia('(max-width: 767px)').matches;

/* ── 主題（深/淺/跟隨系統）─────────────────────────────────────────── */

export function themePref() {
  try {
    return localStorage.getItem('ev-theme-pref')
        || localStorage.getItem('ev-theme') || 'dark';
  } catch (_) { return 'dark'; }
}

export function applyTheme(pref = themePref()) {
  const sys = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const t = pref === 'system' ? sys : (pref === 'light' ? 'light' : 'dark');
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('ev-theme', t); } catch (_) {}   // index.html 早期還原用
}

export function setThemePref(pref) {
  try { localStorage.setItem('ev-theme-pref', pref); } catch (_) {}
  applyTheme(pref);
}

function _initTheme() {
  applyTheme();
  $('btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || 'dark';
    setThemePref(cur === 'dark' ? 'light' : 'dark');   // 快捷鍵式切換；三態於設定頁
  });
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  mq.addEventListener?.('change', () => { if (themePref() === 'system') applyTheme('system'); });
}

/* ── 左欄：桌面 rail 收合 / 平板手機 overlay 抽屜（ephemeral guard）──── */

let _drawerPushed = false;

function _drawerEls() { return { sidebar: $('sidebar'), backdrop: $('shell-backdrop') }; }

function _closeDrawerUI() {
  _drawerPushed = false;
  const { sidebar, backdrop } = _drawerEls();
  sidebar.classList.remove('open');
  backdrop.classList.remove('show');
}

export function openSideDrawer() {
  const { sidebar, backdrop } = _drawerEls();
  if (sidebar.classList.contains('open')) return;
  sidebar.classList.add('open');
  backdrop.classList.add('show');
  pushEphemeral(_closeDrawerUI);            // 返回鍵 = 關抽屜（§5.4 #5）
  _drawerPushed = true;
}

/** UI 主動關閉；即將 navigate 時用 { navigating:true } 丟棄 guard 免競態 */
export function closeSideDrawer({ navigating = false } = {}) {
  const { sidebar } = _drawerEls();
  if (!sidebar.classList.contains('open')) return;
  if (_drawerPushed && !navigating) { popEphemeral(); return }  // popstate → _closeDrawerUI
  if (_drawerPushed) discardEphemerals();
  _closeDrawerUI();
}

function _toggleDrawer() {
  $('sidebar').classList.contains('open') ? closeSideDrawer() : openSideDrawer();
}

/* ── Inspector：桌面收合 / 平板 overlay / 手機 bottom sheet ──────────── */

let _inspPushed = false;

function _inspCloseUI() {
  _inspPushed = false;
  const insp = $('inspector');
  insp.classList.remove('open', 'sheet-40', 'sheet-55', 'sheet-80');
}

export function openInspectorPanel() {
  const insp = $('inspector');
  if (insp.classList.contains('open')) return;
  insp.classList.add('open');
  if (_isMobile()) insp.classList.add('sheet-55');
  pushEphemeral(_inspCloseUI);
  _inspPushed = true;
}

export function closeInspectorPanel({ navigating = false } = {}) {
  const insp = $('inspector');
  if (!insp.classList.contains('open')) return;
  if (_inspPushed && !navigating) { popEphemeral(); return }
  if (_inspPushed) discardEphemerals();
  _inspCloseUI();
}

/** 手機 sheet 拖把手：拖曳 → 40/55/80vh 吸附；下拉 <25vh = 關閉（C46 同模式） */
function _wireSheetGrip() {
  const insp = $('inspector');
  const grip = document.createElement('div');
  grip.className = 'sheet-grip';
  grip.id = 'insp-grip';
  grip.innerHTML = '<span></span>';
  insp.prepend(grip);

  let startY = 0, startH = 0, dragging = false;
  grip.addEventListener('touchstart', e => {
    if (!_isMobile()) return;
    dragging = true;
    startY = e.touches[0].clientY;
    startH = insp.getBoundingClientRect().height;
    insp.style.transition = 'none';
  }, { passive: true });
  grip.addEventListener('touchmove', e => {
    if (!dragging) return;
    const dy = startY - e.touches[0].clientY;         // 上拉為正
    const h = Math.max(80, Math.min(window.innerHeight * 0.88, startH + dy));
    insp.style.height = h + 'px';
  }, { passive: true });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    const vh = insp.getBoundingClientRect().height / window.innerHeight * 100;
    insp.style.transition = '';
    insp.style.height = '';
    insp.classList.remove('sheet-40', 'sheet-55', 'sheet-80');
    if (vh < 25) { closeInspectorPanel(); return; }
    const snap = vh < 48 ? 'sheet-40' : vh < 68 ? 'sheet-55' : 'sheet-80';
    insp.classList.add(snap);
  };
  grip.addEventListener('touchend', end, { passive: true });
  grip.addEventListener('touchcancel', end, { passive: true });
}

/* ── 底部 tabbar「更多」選單（統計/垃圾桶/通知/設定）────────────────── */

function _moreMenu(anchor, trashHash, openNotifs) {
  document.querySelector('.menu.tab-more-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu tab-more-menu';
  const mi = (go, icon, label) =>
    `<button class="menu-item" data-go="${go}">
       <svg class="icon icon-sm" aria-hidden="true"><use href="#i-${icon}"/></svg>${label}</button>`;
  m.innerHTML =
    mi('#/stats', 'chart', '統計') + mi('trash', 'trash', '垃圾桶') +
    mi('notifs', 'bell', '通知') + mi('#/settings/prefs', 'settings', '設定');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = (r.top - m.offsetHeight - 6) + 'px';
  const close = () => { m.remove(); document.removeEventListener('click', onDoc, true); };
  const onDoc = e => { if (!m.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('click', onDoc, true), 0);
  m.addEventListener('click', e => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    close();
    const go = b.dataset.go;
    if (go === 'trash') { const hsh = trashHash(); if (hsh) navigate(hsh); }
    else if (go === 'notifs') openNotifs();
    else navigate(go);
  });
}

/* ── C67：localStorage 一次性遷移（seeds；vc-key 與 user-data 天然共用免遷）─ */

function _migrateOnce() {
  try {
    if (localStorage.getItem('ev-migrated')) return;
    if (!localStorage.getItem('ev-seeds')) {
      const d = new Date();
      const key = `eagle-seeds-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const old = localStorage.getItem(key);
      if (old) localStorage.setItem('ev-seeds', old);
    }
    localStorage.setItem('ev-migrated', '1');
  } catch (_) {}
}

/* ── 初始化（app.js boot 呼叫）─────────────────────────────────────── */

/**
 * @param {object} ctx { trashHash: () => hash|null, openNotifs: () => void }
 */
export function initShell(ctx = {}) {
  const trashHash = ctx.trashHash || (() => null);
  const openNotifs = ctx.openNotifs || (() => {});
  _migrateOnce();
  _initTheme();
  _wireSheetGrip();

  const shell = $('shell');
  if (localStorage.getItem('ev-rail-collapsed') === '1') shell.classList.add('rail-collapsed');
  if (localStorage.getItem('ev-inspector-collapsed') === '1') shell.classList.add('inspector-collapsed');

  $('btn-rail').addEventListener('click', () => {
    if (_isNarrow()) { _toggleDrawer(); return; }     // 平板/手機：overlay 抽屜
    const c = shell.classList.toggle('rail-collapsed');
    localStorage.setItem('ev-rail-collapsed', c ? '1' : '0');
    $('btn-rail').setAttribute('aria-expanded', String(!c));
  });
  $('tab-browse').addEventListener('click', _toggleDrawer);
  $('shell-backdrop').addEventListener('click', () => closeSideDrawer());
  // 抽屜左滑關閉（M3 navigation drawer／Google Photos 標配）：dx < -60 且 |dy| < 40
  {
    let sx = 0, sy = 0, tracking = false;
    const sb = $('sidebar');
    sb.addEventListener('touchstart', e => {
      if (!sb.classList.contains('open') || e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
    }, { passive: true });
    sb.addEventListener('touchmove', e => {
      if (!tracking) return;
      const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
      if (Math.abs(dy) > 40) { tracking = false; return; }
      if (dx < -60) { tracking = false; closeSideDrawer(); }
    }, { passive: true });
    sb.addEventListener('touchend', () => { tracking = false; }, { passive: true });
  }

  $('btn-inspector').addEventListener('click', () => {
    if (_isNarrow()) {                                // 平板 overlay / 手機 sheet
      $('inspector').classList.contains('open')
        ? closeInspectorPanel() : openInspectorPanel();
      return;
    }
    const c = shell.classList.toggle('inspector-collapsed');
    localStorage.setItem('ev-inspector-collapsed', c ? '1' : '0');
    $('btn-inspector').setAttribute('aria-expanded', String(!c));
  });

  /* 平板：選取時 Inspector overlay 自右滑入（spec §1.5）；清空 = 收回 */
  store.on('selection', () => {
    if (!_isNarrow() || _isMobile()) return;
    const n = store.state.selection.size;
    if (n > 0) openInspectorPanel();
    else closeInspectorPanel();
  });

  /* SYSTEM 導覽 + 頂列設定鈕 + 新增來源 */
  document.querySelectorAll('[data-nav]').forEach(el =>
    el.addEventListener('click', () => {
      closeSideDrawer({ navigating: true });
      navigate(el.dataset.nav);
    }));
  $('btn-settings')?.addEventListener('click', () => navigate('#/settings/prefs'));
  $('btn-add-source')?.addEventListener('click', () => {
    closeSideDrawer({ navigating: true });
    navigate('#/settings/sources');
  });
  $('row-trash').addEventListener('click', () => {
    const hsh = trashHash();
    if (hsh) { closeSideDrawer({ navigating: true }); navigate(hsh); }
  });
  $('tab-more')?.addEventListener('click', e =>
    _moreMenu(e.currentTarget, trashHash, openNotifs));
  $('btn-notifs')?.addEventListener('click', openNotifs);

  /* 側欄內點庫/資料夾/相簿/智慧集合（無 Ctrl 疊加）= 導覽 → 收抽屜（guard 同步丟棄）；
     濾鏡集為多選 OR toggle → 留在抽屜內（URL 一致性由 router _curHref 補回機制保證） */
  $('sidebar').addEventListener('click', e => {
    if (e.target.closest('[data-lib], [data-folder], [data-coll], [data-smart]') && !e.ctrlKey && !e.metaKey)
      closeSideDrawer({ navigating: true });
  }, true);   // capture：須早於子鈕的 navigate（location.hash 賦值可能同步觸發 popstate，guard 未丟會吞掉 render）

  /* 斷點切換清理：桌面化時移除 sheet/overlay 殘態 */
  window.addEventListener('resize', () => {
    if (!_isNarrow()) { _closeDrawerUI(); _inspCloseUI(); }
  });
}
