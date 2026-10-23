/* ── ai-status.js ▸ AI 索引狀態面板（B5；UX 重構）───────────────────────
   dialog：引擎就緒度（onnxruntime/CLIP/Face 模型/文字塔）+ 各庫五維度
   （語意 clip / 人臉 faces / 標籤 tags / 表情 expr / 服裝 clothing）
   每維度一行＝覆蓋率 + 觸發按鈕行內化（POST /api/ai/index）。
   頂部分層入口：基礎索引（clip+faces）/ 進階辨識全量（tags+expr+clothing）
   / 全部庫×單維度 chip。
   進度：SSE ai-index-progress（notifications.js 轉發 store 'ai-progress'）
   為主、面板開啟時輪詢 /api/ai/index/progress 為備援；前端維護簡單速率
   估計顯示 ETA（純前端，不落後端）。 */

import { api } from './api.js';
import { store } from './store.js';
import { h } from './items.js';
import { toast } from './notifications.js';

let _dlg = null;
let _pollTimer = 0;
let _rateHist = {};   // "lib|kind" → [{t, done}]（近 N 筆速率估計，job 開始時清空）

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

const _DIM_CHIPS = [
  { kind: 'clip', label: '語意' },
  { kind: 'faces', label: '人臉' },
  { kind: 'tags', label: '標籤' },
  { kind: 'expressions', label: '表情' },
  { kind: 'clothing', label: '服裝' },
];

function _build() {
  _dlg = document.createElement('dialog');
  _dlg.className = 'dlg ai-dlg';
  _dlg.innerHTML = `
    <h3 class="dlg-title">AI 索引狀態</h3>
    <div class="ai-engine" id="ai-engine">載入中…</div>
    <div class="ai-actions-top">
      <button class="btn btn-sm btn-primary" data-act="index-all">基礎索引（語意+人臉）</button>
      <button class="btn btn-sm" data-act="index-advanced">進階辨識全量（標籤+表情+服裝）</button>
      <span class="ai-hint">大庫需數小時，背景執行</span>
    </div>
    <div class="ai-dim-chips">
      <span class="ai-hint">全部庫 × 單維度：</span>
      ${_DIM_CHIPS.map(d => `<button class="chip" data-act="index-dim" data-kind="${d.kind}">${d.label}</button>`).join('')}
    </div>
    <div class="ai-libs" id="ai-libs"></div>
    <div class="ai-job" id="ai-job" hidden></div>
    <p class="ai-job-hint">關閉視窗不會中斷索引，可隨時回來查看進度</p>
    <div class="dlg-actions">
      <button class="btn btn-sm" data-act="refresh">重新整理</button>
      <span style="flex:1"></span>
      <button class="btn btn-sm" data-act="close">關閉</button>
    </div>`;
  document.body.appendChild(_dlg);
  _dlg.addEventListener('close', _stopPoll);
  _dlg.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') _dlg.close();
    else if (act === 'refresh') _refresh();
    else if (act === 'index-all') startAiIndex('all', 'both');
    else if (act === 'index-advanced') startAiIndex('all', 'advanced');
    else if (act === 'index-dim') startAiIndex('all', e.target.closest('[data-kind]').dataset.kind);
    else if (act === 'index-lib') startAiIndex(e.target.closest('[data-lib]').dataset.lib, 'both');
    else if (act === 'index-row') {
      const row = e.target.closest('[data-lib][data-kind]');
      startAiIndex(row.dataset.lib, row.dataset.kind);
    }
  });
  store.on('ai-progress', evt => { if (_dlg?.open) _renderJobLine(evt); });
}

const _pct = (a, b) => b ? Math.min(100, Math.round(a / b * 100)) : 0;

/* ── 每維度一行：覆蓋率條/終態文字 + 行內觸發按鈕 ───────────────────── */

function _covRow(lib, kindKey, label, done, total, running) {
  const p = total ? _pct(done || 0, total) : 0;
  const numTxt = running
    ? (total ? `索引中 ${(done || 0).toLocaleString()} / ${total.toLocaleString()}（${p}%）` : '計算工作量…')
    : `${(done || 0).toLocaleString()}${total ? ` / ${total.toLocaleString()}` : ''}（${p}%）`;
  return `<div class="cov-row" data-lib="${h(lib)}" data-kind="${kindKey}">
    <span class="cov-label">${h(label)}</span>
    <span class="cov-bar"><span class="cov-fill${running && !total ? ' indet' : ''}" style="width:${p}%"></span></span>
    <span class="cov-num">${numTxt}</span>
    <button class="btn btn-xs" data-act="index-row" ${running ? 'disabled' : ''}>${running ? '進行中' : '索引'}</button>
  </div>`;
}

function _tagsRow(lib, l, running) {
  const built = !!l?.tags?.built;
  const dateTxt = l?.tags?.built_at ? l.tags.built_at.slice(0, 10) : '';
  const txt = running ? '索引中…' : (built ? `已建 · ${dateTxt}` : '未建');
  return `<div class="cov-row" data-lib="${h(lib)}" data-kind="tags">
    <span class="cov-label">標籤 tags</span>
    <span class="cov-num" style="flex:1">${h(txt)}</span>
    <button class="btn btn-xs" data-act="index-row" ${running ? 'disabled' : ''}>${running ? '進行中' : '索引'}</button>
  </div>`;
}

function _libRows(lib, l, current) {
  const match = kind => !!current && current.lib === lib && current.kind === kind;
  return [
    _covRow(lib, 'clip', '語意 clip', l.clip?.indexed || 0, l.total || 0, match('clip')),
    _covRow(lib, 'faces', '人臉 faces', l.faces?.items_done || 0, l.total || 0, match('faces')),
    _tagsRow(lib, l, match('tags')),
    _covRow(lib, 'expressions', '表情 expr', l.expr?.faces_done || 0, l.expr?.faces_total || 0, match('expressions')),
    _covRow(lib, 'clothing', '服裝 clothing', l.clothing?.todo_done || 0, l.clothing?.todo_total || 0, match('clothing')),
  ].join('');
}

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

  const job = st.index_job || {};
  const current = job.status === 'running' ? job.current : null;

  _dlg.querySelector('#ai-libs').innerHTML = Object.entries(st.libs || {}).map(([name, l]) => `
    <div class="ai-lib" data-lib="${h(name)}">
      <div class="ai-lib-head">
        <svg class="icon icon-sm" aria-hidden="true">
          <use href="#i-${l.source === 'excire' ? 'library-excire' : 'library-eagle'}"/></svg>
        <span class="ai-lib-name">${h(name)}</span>
        <span class="ai-lib-persons">${l.persons ? `${l.persons.n_persons} 人物` : '未聚類'}</span>
        <button class="btn btn-xs" data-act="index-lib" title="建立此庫 clip+faces 基礎索引">基礎</button>
      </div>
      ${_libRows(name, l, current)}
    </div>`).join('') || '<p class="side-placeholder">尚無資源庫</p>';

  const jobEl = _dlg.querySelector('#ai-job');
  if (job.status === 'running') {
    jobEl.hidden = false;
    const c = job.current || {};
    jobEl.innerHTML = _jobHTML(c.lib, c.kind, c.done, c.total);
  } else {
    jobEl.hidden = true;
  }
}

const _KIND = { clip: '語意索引', faces: '人臉索引',
                'video-faces': '影片抽幀人臉索引', tags: '人數/場景/運動標籤',
                expressions: '臉部表情辨識', clothing: '服裝標籤索引' };

/* ── ETA：前端維護最近幾筆 (t, done) 移動估計速率，純前端不落後端 ──── */

function _etaText(lib, kind, done, total) {
  if (!total) return '';
  const key = `${lib}|${kind}`;
  const hist = (_rateHist[key] ||= []);
  hist.push({ t: Date.now(), done });
  while (hist.length > 6) hist.shift();
  if (hist.length < 2) return '';
  const first = hist[0], last = hist[hist.length - 1];
  const dt = (last.t - first.t) / 1000, dd = last.done - first.done;
  if (dt <= 0 || dd <= 0) return '';
  const remain = total - done;
  if (remain <= 0) return '';
  const etaSec = remain / (dd / dt);
  return etaSec < 60 ? '（不到 1 分鐘）' : `（約 ${Math.round(etaSec / 60)} 分鐘）`;
}

function _jobHTML(lib, kind, done, total) {
  const p = total ? _pct(done || 0, total) : null;
  const eta = total ? _etaText(lib, kind, done || 0, total) : '';
  return `<span>索引中：${h(lib || '')} · ${h(_KIND[kind] || kind || '')}</span>
    <span class="cov-bar"><span class="cov-fill${p == null ? ' indet' : ''}"
      style="width:${p == null ? 100 : p}%"></span></span>
    <span class="cov-num">${total ? `${done} / ${total}${eta}` : '計算工作量…'}</span>`;
}

/* 就地更新單一維度列（不觸發整面板重繪，避免行進中閃爍）── */
function _updateLibRow(lib, kind, done, total) {
  const row = _dlg?.querySelector(`.cov-row[data-lib="${CSS.escape(lib)}"][data-kind="${CSS.escape(kind)}"]`);
  if (!row) return;
  const btn = row.querySelector('[data-act="index-row"]');
  if (btn) { btn.disabled = true; btn.textContent = '進行中'; }
  if (kind === 'tags') {
    const num = row.querySelector('.cov-num');
    if (num) num.textContent = '索引中…';
    return;
  }
  const p = total ? _pct(done || 0, total) : 0;
  const fill = row.querySelector('.cov-fill');
  const num = row.querySelector('.cov-num');
  if (fill) { fill.style.width = p + '%'; fill.classList.toggle('indet', !total); }
  if (num) num.textContent = total
    ? `索引中 ${(done || 0).toLocaleString()} / ${total.toLocaleString()}（${p}%）`
    : '計算工作量…';
}

function _renderJobLine(evt) {
  const jobEl = _dlg.querySelector('#ai-job');
  if (evt.phase === 'done' || evt.phase === 'error') { _refresh(); return; }
  if (evt.phase === 'start') delete _rateHist[`${evt.lib}|${evt.kind}`];
  jobEl.hidden = false;
  jobEl.innerHTML = _jobHTML(evt.lib, evt.kind, evt.done, evt.total);
  _updateLibRow(evt.lib, evt.kind, evt.done, evt.total);
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
        _updateLibRow(c.lib, c.kind, c.done, c.total);
      }
    } catch (_) { /* 靜默 */ }
  }, 3000);
}

function _stopPoll() { clearInterval(_pollTimer); _pollTimer = 0; }
