/* ── settings.js ▸ 設定頁（B6，#/settings/{tab}；C61/C64/C65 + 預設 UI）──
   prefs：主題三態/seed 上限/密度/精簡卡片/預設 UI（cookie ev_ui）
   sources：來源清單 + web 路徑輸入 + 伺服器端目錄瀏覽（取代 tkinter，C02）
   sync：資料夾→標籤、素材標籤 diff 預覽 + 套用（C64）
   notifications：本次連線通知紀錄（notifications.js 事件日誌）（C61 子集） */

import { api } from './api.js';
import { store } from './store.js';
import { navigate } from './router.js';
import { h } from './items.js';
import { renderBreadcrumb, setContentChrome, pagePanel } from './page-chrome.js';
import { themePref, setThemePref } from './shell.js';
import { toast, getNotifLog, clearNotifLog, notifRowsHTML } from './notifications.js';

const TABS = [['prefs', '偏好'], ['sources', '來源'], ['sync', '標籤同步'], ['notifications', '通知']];
const _icon = n => `<svg class="icon icon-sm" aria-hidden="true"><use href="#i-${n}"/></svg>`;

export function renderSettingsRoute(route, ctx) {
  const tab = TABS.some(([t]) => t === route.params.tab) ? route.params.tab : 'prefs';
  renderBreadcrumb([{ label: '設定' }, { label: TABS.find(([t]) => t === tab)[1] }]);
  setContentChrome(false);
  const panel = pagePanel();
  panel.innerHTML = `<div class="settings-page">
    <div class="seg-tabs">${TABS.map(([t, l]) =>
      `<button class="seg-tab${t === tab ? ' on' : ''}" data-tab="${t}">${l}</button>`).join('')}</div>
    <div id="settings-body"></div>
  </div>`;
  panel.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () =>
    navigate(`#/settings/${b.dataset.tab}`, { replace: true })));
  const body = panel.querySelector('#settings-body');
  if (tab === 'prefs') _prefs(body);
  else if (tab === 'sources') _sources(body, ctx);
  else if (tab === 'sync') _sync(body, ctx);
  else _notifs(body);
}

/* ── 偏好（C65）─────────────────────────────────────────────────────── */

function _cookieUi() {
  const m = document.cookie.match(/(?:^|;\s*)ev_ui=(\w+)/);
  return m ? m[1] : 'new';
}

function _prefs(body) {
  const pref = themePref();
  const maxSeeds = parseInt(localStorage.getItem('eagle-pref-max-seeds') || '7', 10) || 7;
  const st = store.state;
  body.innerHTML = `
    <section class="set-card">
      <h3>${_icon('theme')} 主題</h3>
      <div class="set-row" role="radiogroup" aria-label="主題">
        ${[['dark', '深色'], ['light', '淺色'], ['system', '跟隨系統']].map(([v, l]) =>
          `<label class="set-radio"><input type="radio" name="theme" value="${v}" ${pref === v ? 'checked' : ''}>${l}</label>`).join('')}
      </div>
    </section>
    <section class="set-card">
      <h3>${_icon('density')} 瀏覽</h3>
      <div class="set-row"><span>卡片密度</span>
        <select class="insp-input set-select" data-density>
          ${[['comfy', '舒適（大卡片）'], ['cozy', '標準'], ['compact', '緊湊（多欄）']].map(([v, l]) =>
            `<option value="${v}" ${st.density === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      <div class="set-row"><span>精簡卡片（隱藏標題資訊）</span>
        <label class="set-radio"><input type="checkbox" data-clean ${st.clean ? 'checked' : ''}>啟用</label></div>
      <div class="set-row"><span>隨機 seed 歷史上限</span>
        <select class="insp-input set-select" data-max-seeds>
          ${[5, 7, 10].map(n => `<option value="${n}" ${maxSeeds === n ? 'selected' : ''}>${n}</option>`).join('')}
        </select></div>
    </section>
    <section class="set-card">
      <h3>${_icon('external')} 預設介面</h3>
      <p class="insp-note">目前預設：<b data-ui-cur>${_cookieUi() === 'classic' ? '舊版（classic）' : '新版（app）'}</b>；
        開啟 <code>/</code> 時依此導向。任何時候可用 <code>/?ui=classic</code> 回舊版。</p>
      <div class="set-row">
        <button class="btn btn-sm" data-ui="new">以新版為預設</button>
        <button class="btn btn-ghost btn-sm" data-ui="classic">以舊版為預設</button>
        <a class="btn btn-ghost btn-sm" href="/?ui=classic">${_icon('external')}立即開啟舊版</a>
      </div>
    </section>`;

  body.querySelectorAll('[name=theme]').forEach(r => r.addEventListener('change', () => {
    setThemePref(r.value);
    toast(`主題：${{ dark: '深色', light: '淺色', system: '跟隨系統' }[r.value]}`);
  }));
  body.querySelector('[data-density]').addEventListener('change', e => {
    store.state.density = e.target.value;
    try { localStorage.setItem('ev-density', e.target.value); } catch (_) {}
    store.emit('view-changed');
  });
  body.querySelector('[data-clean]').addEventListener('change', e => {
    store.state.clean = e.target.checked;
    try { localStorage.setItem('ev-clean', e.target.checked ? '1' : '0'); } catch (_) {}
    store.emit('view-changed');
  });
  body.querySelector('[data-max-seeds]').addEventListener('change', e => {
    try { localStorage.setItem('eagle-pref-max-seeds', e.target.value); } catch (_) {}
  });
  body.querySelectorAll('[data-ui]').forEach(b => b.addEventListener('click', () => {
    document.cookie = `ev_ui=${b.dataset.ui}; path=/; max-age=31536000; SameSite=Lax`;
    body.querySelector('[data-ui-cur]').textContent =
      b.dataset.ui === 'classic' ? '舊版（classic）' : '新版（app）';
    toast('已更新預設介面');
  }));
}

/* ── 來源（庫路徑管理，C02 web 化）──────────────────────────────────── */

function _sources(body, ctx) {
  const libs = ctx.libs();
  const group = (type, label, icon) => {
    const rows = libs.filter(l => l.type === type);
    if (!rows.length) return '';
    return `<div class="set-sub">${label}</div>` + rows.map(l => `
      <div class="set-row src-row">${_icon(icon)}<span class="src-name">${h(l.label)}</span>
        ${l.count != null ? `<span class="count-pill">${l.count.toLocaleString()}</span>` : ''}
        ${l.readOnly ? _icon('lock-ro') : ''}</div>`).join('');
  };
  body.innerHTML = `
    <section class="set-card">
      <h3>${_icon('library-eagle')} 已設定來源</h3>
      ${group('eagle', 'Eagle 庫', 'library-eagle')}
      ${group('excire', 'Excire 庫（唯讀，config.json 設定）', 'library-excire')}
      ${group('dir', 'Folder 來源', 'folder-scan')}
    </section>
    <section class="set-card">
      <h3>${_icon('plus')} 新增來源</h3>
      <div class="set-row">
        <select class="insp-input set-select" data-src-type>
          <option value="eagle">Eagle 資源庫（.library 資料夾）</option>
          <option value="dir">Folder 來源（一般資料夾）</option>
        </select>
      </div>
      <div class="set-row">
        <input class="insp-input" data-src-path placeholder="輸入伺服器上的路徑（支援 C:\\… 或 /mnt/…）" style="flex:1">
        <button class="btn btn-ghost btn-sm" data-src-browse>瀏覽…</button>
        <button class="btn btn-sm" data-src-add>加入</button>
      </div>
      <div class="dir-browser" data-dir-browser hidden></div>
    </section>`;

  const pathInput = body.querySelector('[data-src-path]');
  const browser = body.querySelector('[data-dir-browser]');

  async function browse(path) {
    browser.hidden = false;
    browser.innerHTML = `<p class="insp-note">載入中…</p>`;
    try {
      const d = await api.browseDir(path);
      browser.innerHTML = `
        <div class="dir-cur">${_icon('folder-open')}<code>${h(d.path || '（根層）')}</code>
          ${d.path ? `<button class="btn btn-ghost btn-sm" data-pick>選用此目錄</button>` : ''}</div>
        ${d.parent != null ? `<button class="dir-item" data-dir="${h(d.parent)}">${_icon('chevron-l')}上一層</button>` : ''}
        ${d.dirs.map(x => `<button class="dir-item" data-dir="${h(x.path)}">${_icon('folder')}${h(x.name)}</button>`).join('')
          || '<p class="insp-note">（無子目錄）</p>'}`;
      browser.querySelectorAll('[data-dir]').forEach(b =>
        b.addEventListener('click', () => browse(b.dataset.dir)));
      browser.querySelector('[data-pick]')?.addEventListener('click', () => {
        pathInput.value = d.path;
        browser.hidden = true;
      });
    } catch (e) { browser.innerHTML = `<p class="insp-note">讀取失敗：${h(e.message)}</p>`; }
  }

  body.querySelector('[data-src-browse]').addEventListener('click', () =>
    browser.hidden ? browse(pathInput.value.trim()) : (browser.hidden = true));

  body.querySelector('[data-src-add]').addEventListener('click', async () => {
    const p = pathInput.value.trim();
    if (!p) { toast('請先輸入來源路徑', { err: true }); return; }
    const type = body.querySelector('[data-src-type]').value;
    const btn = body.querySelector('[data-src-add]');
    btn.disabled = true; btn.textContent = '加入中…';
    try {
      type === 'eagle' ? await api.addLibrary(p) : await api.addFolderSource(p);
      toast('來源已加入；索引將於背景建立');
      await ctx.reloadSources();
      _sources(body, ctx);                        // 重新渲染清單
    } catch (e) {
      toast(`加入失敗：${e.message}`, { err: true });
      btn.disabled = false; btn.textContent = '加入';
    }
  });
}

/* ── 標籤同步（C64）─────────────────────────────────────────────────── */

function _sync(body, ctx) {
  const eagleLibs = ctx.libs().filter(l => l.type === 'eagle');
  if (!eagleLibs.length) { body.innerHTML = `<p class="insp-note">尚無 Eagle 庫</p>`; return; }
  const cur = store.state.libId;
  body.innerHTML = `
    <div class="set-row"><span>資源庫</span>
      <select class="insp-input set-select" data-sync-lib>
        ${eagleLibs.map(l => `<option value="${h(l.slug)}" ${l.id === cur ? 'selected' : ''}>${h(l.label)}</option>`).join('')}
      </select></div>
    ${[['tags-sync', '資料夾 → 標籤', '依資料夾階層更新 metadata.json 內各資料夾的 tags'],
       ['items-tags-sync', '素材標籤', '依所屬資料夾階層更新每個素材的 tags']].map(([kind, title, note]) => `
    <section class="set-card" data-sync="${kind}">
      <h3>${_icon('retry')} ${title}</h3>
      <p class="insp-note">${note}</p>
      <div class="set-row">
        <button class="btn btn-ghost btn-sm" data-diff>預覽 diff</button>
        <button class="btn btn-sm" data-apply disabled>套用</button>
      </div>
      <div class="sync-diff" data-diff-out hidden></div>
    </section>`).join('')}`;

  const libSel = body.querySelector('[data-sync-lib]');
  body.querySelectorAll('[data-sync]').forEach(card => {
    const kind = card.dataset.sync;
    const out = card.querySelector('[data-diff-out]');
    const applyBtn = card.querySelector('[data-apply]');
    card.querySelector('[data-diff]').addEventListener('click', async () => {
      out.hidden = false;
      out.innerHTML = '<p class="insp-note">比對中…</p>';
      try {
        const d = await api.tagsSyncDiff(kind, libSel.value);
        const ch = d.changes || [];
        applyBtn.disabled = !ch.length;
        out.innerHTML = ch.length
          ? `<p class="insp-note">共 ${d.total} 筆差異</p>` + ch.slice(0, 30).map(c => `
              <div class="diff-row"><b>${h(c.name || c.id)}</b>
                <span class="diff-tags">${(c.current_tags || []).map(t => `<s>${h(t)}</s>`).join(' ') || '（無）'}
                → ${(c.expected_tags || []).map(t => `<i>${h(t)}</i>`).join(' ')}</span></div>`).join('')
            + (ch.length > 30 ? `<p class="insp-note">… 其餘 ${ch.length - 30} 筆省略</p>` : '')
          : '<p class="insp-note">已同步，無差異 ✓</p>';
      } catch (e) { out.innerHTML = `<p class="insp-note">比對失敗：${h(e.message)}</p>`; }
    });
    applyBtn.addEventListener('click', async () => {
      applyBtn.disabled = true;
      try {
        const r = await api.tagsSyncApply(kind, libSel.value);
        toast(`已套用 ${r.applied ?? 0} 筆標籤同步`);
        out.innerHTML = `<p class="insp-note">已套用 ${r.applied ?? 0} 筆 ✓</p>`;
      } catch (e) { toast(`套用失敗：${e.message}`, { err: true }); applyBtn.disabled = false; }
    });
  });
}

/* ── 通知（C61：三類分類 + 持久化紀錄）──────────────────────────────── */

function _notifs(body) {
  const log = getNotifLog();
  const catBtn = (c, l) => `<button class="chip${c === 'all' ? ' active' : ''}" data-cat="${c}">${l}</button>`;
  body.innerHTML = `
    <section class="set-card">
      <h3>${_icon('bell')} 通知紀錄</h3>
      <div class="set-row">
        <span class="insp-note">${log.length} 則（持久化保留最近 100 則，跨重啟補追）；即時事件以 toast 顯示，亦可自頂列 🔔 開啟</span>
        <button class="btn btn-ghost btn-sm" data-clear ${log.length ? '' : 'disabled'}>清除</button>
      </div>
      <div class="notif-cats">${catBtn('all', '全部')}${catBtn('system', '系統')}${catBtn('download', '下載')}${catBtn('ai', 'AI')}</div>
      <div class="notif-list" data-notif-list>${notifRowsHTML()}</div>
    </section>`;
  body.querySelector('[data-clear]')?.addEventListener('click', () => {
    clearNotifLog();
    _notifs(body);
  });
  body.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => {
    body.querySelectorAll('[data-cat]').forEach(x => x.classList.toggle('active', x === b));
    body.querySelector('[data-notif-list]').innerHTML = notifRowsHTML(b.dataset.cat);
  }));
}
