/* ── download-center.js ▸ 下載中心（B5，C57–C59 子集）───────────────────
   #/downloads 頁（page-panel）：
   - URL 貼上（多行批次）→ 目標庫/資料夾 → 引擎自動路由顯示（douyin/xhs/
     LINE VOOM/cobalt，鏡射後端 _classify_platform）→ POST /api/import/url
   - 任務列表：輪詢 /api/import/status/{id}（進度/成功/失敗/重試），完成項
     「檢視」一鍵跳轉 grid 定位（lib-invalidate 重載 + ?item= 開啟 viewer）
   - 檔案上傳：面板按鈕/拖放 + 全域拖放（任何頁拖入檔案 → 導向本頁上傳）
   - 服務健康：/api/services/health 燈號
   B6：後端 /api/import/url、/api/import/upload 已支援 folder_id/folder，
   下載與上傳皆寫入所選資料夾（metadata.json folders + 資料夾 tags）。 */

import { api } from './api.js';
import { store } from './store.js';
import { navigate } from './router.js';
import { h } from './items.js';
import { toast } from './notifications.js';
import { renderBreadcrumb, setContentChrome, pagePanel } from './page-chrome.js';
import { invalidateLibCache } from './ai-search.js';

const $ = id => document.getElementById(id);
const _icon = n => `<svg class="icon icon-sm" aria-hidden="true"><use href="#i-${n}"/></svg>`;

let _ctx = { libs: () => [] };            // app.js 注入（可寫入庫 = eagle）
let _seq = 0;
const T = { tasks: [], timer: 0 };        // 任務（localStorage 持久化，C59；新→舊）

/* ── 任務歷史持久化（C59：跨重啟保留；上限 50）─────────────────────── */

const HIST_KEY = 'ev-dl-tasks';

function _persist() {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(T.tasks.slice(0, 50).map(t => ({
      key: t.key, kind: t.kind, url: t.url, lib: t.lib, folder: t.folder || '',
      engine: t.engine, status: t.status, progress: t.progress,
      taskId: t.taskId, error: t.error, result: t.result, at: t.at,
    }))));
  } catch (_) {}
}

async function _restoreHistory() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (_) {}
  if (!Array.isArray(saved) || !saved.length) return;
  T.tasks = saved;
  _seq = saved.length;
  saved.forEach((t, i) => { t.key = `r${i}`; });
  /* 重啟時仍在途的任務：上傳無法續傳 → 中斷；URL 任務向後端補問一次狀態 */
  let anyRunning = false;
  for (const t of T.tasks) {
    if (t.kind === 'upload' && t.status === 'uploading') {
      t.status = 'failed'; t.error = '重新整理中斷';
    } else if (t.kind === 'url' && ['pending', 'running'].includes(t.status)) {
      if (!t.taskId) { t.status = 'failed'; t.error = '重新整理中斷'; continue; }
      try {
        const s = await api.importStatus(t.taskId);
        t.status = s.status || t.status;
        t.progress = s.progress ?? t.progress;
        t.error = s.error || null;
        t.result = s.result || t.result;
        if (['pending', 'running'].includes(t.status)) anyRunning = true;
      } catch (_) { t.status = 'failed'; t.error = '任務已不存在（伺服器重啟）'; }
    }
  }
  _persist();
  _renderTasks(); _updateBadge();
  if (anyRunning) _startPoll();
}

/* ── 引擎路由（鏡射後端 api_import._classify_platform）──────────────── */

const ENGINES = {
  douyin:   { label: '抖音 Evil0ctal', cls: 'douyin' },
  xhs:      { label: '小紅書 XHS-DL',  cls: 'xhs' },
  linevoom: { label: 'LINE VOOM',      cls: 'line' },
  cobalt:   { label: 'cobalt',         cls: 'cobalt' },
};

export function classifyEngine(url) {
  const u = String(url).toLowerCase();
  if (u.includes('douyin.com')) return 'douyin';
  if (u.includes('xiaohongshu.com') || u.includes('xhslink.com')) return 'xhs';
  if (u.includes('linevoom.line.me')) return 'linevoom';
  return 'cobalt';
}

const _isUrl = s => /^https?:\/\/\S+$/i.test(s);

/* ── 初始化（全域拖放 + badge）──────────────────────────────────────── */

export function initDownloadCenter(ctx = {}) {
  Object.assign(_ctx, ctx);
  _restoreHistory();                      // C59：任務歷史跨重啟
  document.addEventListener('dragover', e => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', e => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    if (!location.hash.startsWith('#/downloads')) navigate('#/downloads');
    // 等 route render 完成（select 就緒）再入列
    setTimeout(() => _queueUploads(files), 50);
  });
}

function _writableLibs() { return _ctx.libs().filter(l => l.type === 'eagle'); }

function _defaultLib() {
  const libs = _writableLibs();
  const cur = libs.find(l => l.id === store.state.libId);
  return (cur || libs[0])?.slug || '';
}

function _updateBadge() {
  const el = $('dl-badge');
  if (!el) return;
  const n = T.tasks.filter(t => ['pending', 'running', 'uploading'].includes(t.status)).length;
  el.hidden = !n;
  el.textContent = n ? String(n) : '';
}

/* ── 頁面渲染 ───────────────────────────────────────────────────────── */

export function renderDownloads(route) {
  renderBreadcrumb([{ label: '下載中心' }]);
  setContentChrome(false);
  const panel = pagePanel();
  const libs = _writableLibs();
  const selLib = _defaultLib();
  const prefill = route?.query?.get('url') || '';

  panel.innerHTML = `
  <div class="dl-page">
    <section class="dl-card">
      <h3 class="dl-title">${_icon('download')} URL 下載 <span class="dl-health" id="dl-health">檢查中…</span></h3>
      <textarea id="dl-urls" class="dl-textarea" rows="4" spellcheck="false"
        placeholder="貼上網址，每行一筆（x.com / 抖音 / 小紅書 / LINE VOOM / YouTube…）">${h(prefill)}</textarea>
      <div class="dl-lines" id="dl-lines"></div>
      <div class="dl-row">
        <label>目標庫
          <select id="dl-lib">${libs.map(l =>
            `<option value="${h(l.slug)}"${l.slug === selLib ? ' selected' : ''}>${h(l.label)}</option>`).join('')}
          </select></label>
        <label>資料夾
          <select id="dl-folder"><option value="">（庫根目錄）</option></select></label>
        <span style="flex:1"></span>
        <button class="btn btn-primary btn-sm" id="dl-submit">${_icon('download')} 開始下載</button>
      </div>
      <p class="dl-err" id="dl-err" hidden></p>
    </section>

    <section class="dl-card">
      <h3 class="dl-title">${_icon('upload')} 檔案上傳</h3>
      <div class="dl-drop" id="dl-drop">
        ${_icon('upload')} 拖放檔案到這裡（全域皆可拖入），或
        <button class="btn btn-sm" id="dl-pick">選擇檔案</button>
        <input type="file" id="dl-file" multiple hidden>
        <span class="dl-hint">上限 2GB／檔；上傳至上方選定的目標庫</span>
      </div>
    </section>

    <section class="dl-card dl-tasks-card">
      <h3 class="dl-title">${_icon('history')} 任務列表
        <button class="btn btn-ghost btn-sm" id="dl-clear" title="清除已完成/失敗">清除已結束</button>
      </h3>
      <div class="dl-tasks" id="dl-tasks"></div>
    </section>
  </div>`;

  if (!libs.length) {
    $('dl-submit').disabled = true;
    $('dl-err').hidden = false;
    $('dl-err').textContent = '沒有可寫入的 Eagle 資源庫（Excire/Folder 來源唯讀）';
  }

  _wire(panel);
  _renderLines();
  _renderTasks();
  _loadFolders($('dl-lib')?.value);
  _loadHealth();
}

function _wire(panel) {
  $('dl-urls').addEventListener('input', _renderLines);
  $('dl-lib').addEventListener('change', () => _loadFolders($('dl-lib').value));
  $('dl-submit').addEventListener('click', _submitUrls);
  $('dl-pick').addEventListener('click', () => $('dl-file').click());
  $('dl-file').addEventListener('change', e => {
    _queueUploads([...e.target.files]);
    e.target.value = '';
  });
  const drop = $('dl-drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', () => drop.classList.remove('over'));
  $('dl-clear').addEventListener('click', () => {
    T.tasks = T.tasks.filter(t => ['pending', 'running', 'uploading'].includes(t.status));
    _renderTasks(); _updateBadge();
  });
  panel.querySelector('#dl-tasks').addEventListener('click', _onTaskAction);
}

/* ── URL 行解析與引擎顯示 ───────────────────────────────────────────── */

function _parseLines() {
  return ($('dl-urls')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
}

function _renderLines() {
  const box = $('dl-lines');
  if (!box) return;
  const lines = _parseLines();
  box.innerHTML = lines.slice(0, 20).map(u => {
    if (!_isUrl(u)) return `<div class="dl-line bad">${_icon('close')}<span class="dl-line-url">${h(u)}</span><span class="engine-badge bad">無效網址</span></div>`;
    const eng = ENGINES[classifyEngine(u)];
    return `<div class="dl-line">${_icon('link')}<span class="dl-line-url">${h(u)}</span><span class="engine-badge ${eng.cls}">${h(eng.label)}</span></div>`;
  }).join('');
  const err = $('dl-err');
  if (err && !err.textContent.includes('資源庫')) err.hidden = true;
}

/* ── 目標資料夾 ─────────────────────────────────────────────────────── */

async function _loadFolders(slug) {
  const sel = $('dl-folder');
  if (!sel || !slug) return;
  sel.innerHTML = `<option value="">（庫根目錄）</option>`;
  try {
    const d = await api.folders(slug);
    const flat = [];
    const walk = (nodes, depth) => (nodes || []).forEach(n => {
      flat.push([n.id, `${'　'.repeat(depth)}${n.name || n.id}`]);
      walk(n.children, depth + 1);
    });
    walk(d.folders || [], 0);
    sel.innerHTML += flat.map(([id, name]) =>
      `<option value="${h(id)}">${h(name)}</option>`).join('');
  } catch (_) { /* 資料夾清單失敗不阻斷 */ }
}

/* ── 服務健康 ───────────────────────────────────────────────────────── */

async function _loadHealth() {
  const el = $('dl-health');
  if (!el) return;
  try {
    const d = await api.servicesHealth();
    el.innerHTML = Object.entries(d.services || {}).map(([svc, s]) =>
      `<span class="svc-dot${s.ok ? ' ok' : ''}" title="${h(svc)}：${s.ok ? '正常' : h(s.error || '離線')}"></span>${h(svc)}`
    ).join(' ');
  } catch (_) { el.textContent = ''; }
}

/* ── URL 任務 ───────────────────────────────────────────────────────── */

async function _submitUrls() {
  const lines = _parseLines();
  const err = $('dl-err');
  if (!lines.length) { err.hidden = false; err.textContent = '請先貼上至少一行網址'; return; }
  const bad = lines.filter(u => !_isUrl(u));
  if (bad.length) {
    err.hidden = false;
    err.textContent = `有 ${bad.length} 行不是有效網址（需 http(s):// 開頭），請修正後再送出`;
    return;
  }
  err.hidden = true;
  const lib = $('dl-lib').value, folder = $('dl-folder').value;
  for (const url of lines) await _startUrlTask(url, lib, folder);
  $('dl-urls').value = '';
  _renderLines();
  toast(`已加入 ${lines.length} 筆下載任務`);
}

async function _startUrlTask(url, lib, folder) {
  const task = {
    key: `t${++_seq}`, kind: 'url', url, lib, folder,
    engine: classifyEngine(url), status: 'pending', progress: 0,
    taskId: null, error: null, result: null, at: Date.now(),
  };
  T.tasks.unshift(task);
  _renderTasks(); _updateBadge();
  try {
    const d = await api.importUrl({ url, lib, name: '', folder_id: folder || '' });
    task.taskId = d.task_id;
    task.status = 'running';
    _startPoll();
  } catch (e) {
    task.status = 'failed';
    task.error = e.message;
  }
  _renderTasks(); _updateBadge();
}

function _startPoll() {
  if (T.timer) return;
  T.timer = setInterval(async () => {
    const active = T.tasks.filter(t => t.kind === 'url' && t.taskId &&
      ['pending', 'running'].includes(t.status));
    if (!active.length) { clearInterval(T.timer); T.timer = 0; _updateBadge(); return; }
    for (const t of active) {
      try {
        const s = await api.importStatus(t.taskId);
        t.status = s.status || t.status;
        t.progress = s.progress ?? t.progress;
        t.error = s.error || null;
        t.result = s.result || null;
        if (t.status === 'completed') invalidateLibCache();
      } catch (_) { /* 保留現狀，下輪再試 */ }
    }
    _renderTasks(); _updateBadge();
  }, 1200);
}

/* ── 上傳任務（XHR：需要 upload progress）──────────────────────────── */

function _queueUploads(files) {
  const lib = $('dl-lib')?.value || _defaultLib();
  const folder = $('dl-folder')?.value || '';
  if (!lib) { toast('沒有可寫入的 Eagle 資源庫', { err: true }); return; }
  for (const f of files) {
    if (f.size > 2 * 1024 * 1024 * 1024) {
      toast(`${f.name} 超過 2GB 上限`, { err: true });
      continue;
    }
    _uploadOne(f, lib, folder);
  }
}

function _uploadOne(file, lib, folder = '') {
  const task = {
    key: `t${++_seq}`, kind: 'upload', url: file.name, lib,
    engine: null, status: 'uploading', progress: 0,
    error: null, result: null, at: Date.now(),
  };
  T.tasks.unshift(task);
  _renderTasks(); _updateBadge();

  const fd = new FormData();
  fd.append('file', file, file.name);
  fd.append('lib', lib);
  if (folder) fd.append('folder', folder);       // B6：後端已支援指定資料夾
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/import/upload');
  xhr.upload.addEventListener('progress', e => {
    if (e.lengthComputable) {
      task.progress = Math.round(e.loaded / e.total * 100);
      _renderTasks();
    }
  });
  xhr.addEventListener('load', () => {
    try {
      const d = JSON.parse(xhr.responseText || '{}');
      if (xhr.status === 200 && d.ok) {
        task.status = 'completed'; task.progress = 100;
        task.result = { id: d.id, name: d.name };
        invalidateLibCache();
      } else {
        task.status = 'failed'; task.error = d.error || `HTTP ${xhr.status}`;
      }
    } catch (_) { task.status = 'failed'; task.error = `HTTP ${xhr.status}`; }
    _renderTasks(); _updateBadge();
  });
  xhr.addEventListener('error', () => {
    task.status = 'failed'; task.error = '網路錯誤';
    _renderTasks(); _updateBadge();
  });
  xhr.send(fd);
}

/* ── 任務列表 ───────────────────────────────────────────────────────── */

const STATUS_LABEL = {
  pending: '等待中', running: '下載中', uploading: '上傳中',
  completed: '完成', failed: '失敗',
};

function _renderTasks() {
  _persist();                             // 任務任何變動即落地（C59）
  const box = $('dl-tasks');
  if (!box) { _updateBadge(); return; }
  if (!T.tasks.length) {
    box.innerHTML = `<p class="dl-hint">尚無任務——貼上網址或拖入檔案開始</p>`;
    return;
  }
  box.innerHTML = T.tasks.map(t => {
    const eng = t.engine ? ENGINES[t.engine] : null;
    const active = ['pending', 'running', 'uploading'].includes(t.status);
    const count = t.result?.count > 1 ? `（${t.result.count} 項）` : '';
    return `<div class="dl-task ${t.status}" data-key="${h(t.key)}">
      <span class="dl-task-icon">${_icon(t.kind === 'upload' ? 'upload' : 'download')}</span>
      <div class="dl-task-main">
        <div class="dl-task-name" title="${h(t.url)}">${h(t.result?.name || t.url)}${count}</div>
        <div class="dl-task-meta">
          ${eng ? `<span class="engine-badge ${eng.cls}">${h(eng.label)}</span>` : ''}
          <span>→ ${h(t.lib)}</span>
          <span class="dl-status ${t.status}">${STATUS_LABEL[t.status] || t.status}</span>
          ${t.error ? `<span class="dl-task-err" title="${h(t.error)}">${h(t.error)}</span>` : ''}
        </div>
        ${active ? `<span class="cov-bar"><span class="cov-fill" style="width:${t.progress || 3}%"></span></span>` : ''}
      </div>
      <span class="dl-task-acts">
        ${t.status === 'failed' && t.kind === 'url'
          ? `<button class="btn btn-ghost btn-sm" data-t-act="retry" title="重試">${_icon('retry')} 重試</button>` : ''}
        ${t.status === 'completed' && _resultId(t)
          ? `<button class="btn btn-primary btn-sm" data-t-act="view" title="跳轉至 grid 定位並開啟">檢視</button>` : ''}
        ${!active ? `<button class="btn btn-ghost btn-sm btn-icon" data-t-act="remove" title="移除" aria-label="移除">${_icon('close')}</button>` : ''}
      </span>
    </div>`;
  }).join('');
}

function _resultId(t) { return t.result?.id || (t.result?.ids || [])[0] || null; }

function _onTaskAction(e) {
  const btn = e.target.closest('[data-t-act]');
  if (!btn) return;
  const task = T.tasks.find(t => t.key === btn.closest('[data-key]')?.dataset.key);
  if (!task) return;
  const act = btn.dataset.tAct;
  if (act === 'remove') {
    T.tasks = T.tasks.filter(t => t !== task);
    _renderTasks(); _updateBadge();
  } else if (act === 'retry') {
    T.tasks = T.tasks.filter(t => t !== task);
    _startUrlTask(task.url, task.lib, task.folder || '');
  } else if (act === 'view') {
    const id = _resultId(task);
    if (!id) return;
    store.emit('lib-invalidate');                 // 強制重載庫（新項目進 allItems）
    invalidateLibCache();
    navigate(`#/lib/${encodeURIComponent('eagle--' + task.lib)}?sort=date&dir=desc&item=${encodeURIComponent(id)}`);
  }
}
