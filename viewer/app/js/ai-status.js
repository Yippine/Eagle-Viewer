/* ── ai-status.js ▸ AI 索引狀態小面板（B5）───────────────────────────────
   dialog：引擎就緒度（onnxruntime/CLIP/Face 模型/文字塔）+ 各庫 clip/faces
   覆蓋率條 + persons 數 + 單庫索引 / 一鍵全量索引（POST /api/ai/index）。
   進度：SSE ai-index-progress（notifications.js 轉發 store 'ai-progress'）
   為主、面板開啟時輪詢 /api/ai/index/progress 為備援。 */

import { api } from './api.js';
import { store } from './store.js';
import { h } from './items.js';
import { toast } from './notifications.js';

let _dlg = null;
let _pollTimer = 0;

/* ── 對外：啟動索引（people.js / 面板共用）──────────────────────────── */

export async function startAiIndex(lib, kind) {
  let r;
  try { r = await api.aiIndex(lib, kind); }
  catch (e) { toast(`索引啟動失敗：${e.message}`, { err: true }); return false; }
  if (r.status === 409) { toast('已有索引任務進行中，請稍候', { err: true }); return false; }
  if (r.status >= 400 || r.body.ok === false) {
    toast(`索引啟動失敗：${r.body.error || `HTTP ${r.status}`}`, { err: true }); return false;
  }
  toast(`AI 索引任務已啟動（${Array.isArray(r.body.libs) ? r.body.libs.length : 1} 庫 / ${kind}）`);
  if (_dlg?.open) _refresh();
  return true;
}

/* ── 面板 ───────────────────────────────────────────────────────────── */

export function openAiStatusPanel() {
  if (!_dlg) _build();
  _dlg.showModal();
  _refresh();
  _startPoll();
}

function _build() {
  _dlg = document.createElement('dialog');
  _dlg.className = 'dlg ai-dlg';
  _dlg.innerHTML = `
    <h3 class="dlg-title">AI 索引狀態</h3>
    <div class="ai-engine" id="ai-engine">載入中…</div>
    <div class="ai-libs" id="ai-libs"></div>
    <div class="ai-job" id="ai-job" hidden></div>
    <div class="dlg-actions">
      <button class="btn btn-sm" data-act="refresh">重新整理</button>
      <span style="flex:1"></span>
      <button class="btn btn-sm btn-primary" data-act="index-all">一鍵全量索引</button>
      <button class="btn btn-sm" data-act="close">關閉</button>
    </div>`;
  document.body.appendChild(_dlg);
  _dlg.addEventListener('close', _stopPoll);
  _dlg.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') _dlg.close();
    else if (act === 'refresh') _refresh();
    else if (act === 'index-all') startAiIndex('all', 'both');
    else if (act === 'index-lib') startAiIndex(e.target.closest('[data-lib]').dataset.lib, 'both');
  });
  store.on('ai-progress', evt => { if (_dlg?.open) _renderJobLine(evt); });
}

const _pct = (a, b) => b ? Math.min(100, Math.round(a / b * 100)) : 0;

const _cov = (label, done, total) => {
  const p = _pct(done, total);
  return `<div class="cov-row">
    <span class="cov-label">${h(label)}</span>
    <span class="cov-bar"><span class="cov-fill" style="width:${p}%"></span></span>
    <span class="cov-num">${(done || 0).toLocaleString()}${total ? ` / ${total.toLocaleString()}` : ''}（${p}%）</span>
  </div>`;
};

async function _refresh() {
  let st;
  try { st = await api.aiStatus(); }
  catch (e) {
    _dlg.querySelector('#ai-engine').innerHTML =
      `<span class="ai-bad">無法取得狀態：${h(e.message)}</span>`;
    return;
  }
  const ok = v => v ? '<span class="ai-ok">✓</span>' : '<span class="ai-bad">✗</span>';
  const eng = st.clip_engine || {};
  _dlg.querySelector('#ai-engine').innerHTML = `
    <span>${ok(st.onnxruntime)} onnxruntime</span>
    <span>${ok(st.clip_model_ready)} CLIP 模型</span>
    <span>${ok(st.face_model_ready)} 人臉模型</span>
    <span>文字引擎：${h(eng.status || 'unloaded')}</span>`;

  _dlg.querySelector('#ai-libs').innerHTML = Object.entries(st.libs || {}).map(([name, l]) => `
    <div class="ai-lib" data-lib="${h(name)}">
      <div class="ai-lib-head">
        <svg class="icon icon-sm" aria-hidden="true">
          <use href="#i-${l.source === 'excire' ? 'library-excire' : 'library-eagle'}"/></svg>
        <span class="ai-lib-name">${h(name)}</span>
        <span class="ai-lib-persons">${l.persons ? `${l.persons.n_persons} 人物` : '未聚類'}</span>
        <button class="btn btn-sm" data-act="index-lib">索引</button>
      </div>
      ${_cov('語意 clip', l.clip?.indexed || 0, l.total || 0)}
      ${_cov('人臉 faces', l.faces?.items_done || 0, l.total || 0)}
    </div>`).join('') || '<p class="side-placeholder">尚無資源庫</p>';

  const job = st.index_job || {};
  const jobEl = _dlg.querySelector('#ai-job');
  if (job.status === 'running') {
    jobEl.hidden = false;
    const c = job.current || {};
    jobEl.innerHTML = _jobHTML(c.lib, c.kind, c.done, c.total);
  } else {
    jobEl.hidden = true;
  }
}

const _KIND = { clip: '語意索引', faces: '人臉索引' };

function _jobHTML(lib, kind, done, total) {
  const p = total ? _pct(done || 0, total) : null;
  return `<span>索引中：${h(lib || '')} · ${h(_KIND[kind] || kind || '')}</span>
    <span class="cov-bar"><span class="cov-fill${p == null ? ' indet' : ''}"
      style="width:${p == null ? 100 : p}%"></span></span>
    <span class="cov-num">${total ? `${done} / ${total}` : '準備中…'}</span>`;
}

function _renderJobLine(evt) {
  const jobEl = _dlg.querySelector('#ai-job');
  if (evt.phase === 'done' || evt.phase === 'error') { _refresh(); return; }
  jobEl.hidden = false;
  jobEl.innerHTML = _jobHTML(evt.lib, evt.kind, evt.done, evt.total);
}

/* SSE 只涵蓋當前庫 → 面板開啟時輪詢備援（全量索引跨庫進度） */
function _startPoll() {
  _stopPoll();
  _pollTimer = setInterval(async () => {
    if (!_dlg?.open) { _stopPoll(); return; }
    try {
      const d = await api.aiIndexProgress();
      if (d.job?.status === 'running') {
        const c = d.job.current || {};
        const jobEl = _dlg.querySelector('#ai-job');
        jobEl.hidden = false;
        jobEl.innerHTML = _jobHTML(c.lib, c.kind, c.done, c.total);
      }
    } catch (_) { /* 靜默 */ }
  }, 3000);
}

function _stopPoll() { clearInterval(_pollTimer); _pollTimer = 0; }
