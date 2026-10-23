/* ── people.js ▸ 左欄 PEOPLE 區 + 人物頁（B5；/api/ai/faces/persons）─────
   - 側欄：當前庫人物卡（代表臉依 bbox 裁切頭像）前 8 人 + 全部人物入口 +
     「重新聚類」「建立索引」（POST /api/ai/index）+ AI 狀態面板入口；
     索引進度以 inline 進度條顯示（store 'ai-progress'，SSE 轉發）。
   - #/people = 全部人物總覽頁（page-panel）；#/people/{personId} = 該人
     全部照片虛擬視圖（ai-search renderVirtualView，走同一 grid 管線）。 */

import { api, mediaURL } from './api.js';
import { store } from './store.js';
import { navigate, parseLibId } from './router.js';
import { h } from './items.js';
import { showMessage } from './grid.js';
import { renderBreadcrumb, setContentChrome, pagePanel, renderPlaceholderPage }
  from './page-chrome.js';
import { openAiStatusPanel, startAiIndex } from './ai-status.js';
import { adaptHits, renderVirtualView } from './ai-search.js';

const $ = id => document.getElementById(id);
const _cache = new Map();   // slug → persons payload（body）

/* ── 初始化 ─────────────────────────────────────────────────────────── */

export function initPeople() {
  store.on('lib-context', () => renderPeopleSidebar());
  store.on('ai-progress', _onProgress);
}

function _slug() { return parseLibId(store.state.libId || '')?.slug || null; }

async function _fetch(slug, force = false) {
  if (!force && _cache.has(slug)) return _cache.get(slug);
  const r = await api.aiFacesPersons(slug);
  const body = r.status === 200 ? r.body : { ok: false, error: r.body.error || `HTTP ${r.status}` };
  _cache.set(slug, body);
  return body;
}

/* ── 代表臉頭像（bbox 像素座標 → 依原圖尺寸換算裁切）────────────────── */

const AV = 44;              // 側欄頭像框 px（CSS .pp-avatar 同步；lg = 72）

function _avatarHTML(rep, size = AV) {
  const cls = 'pp-avatar' + (size > AV ? ' lg' : '');
  if (!rep?.thumb) return `<span class="${cls} empty"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-people"/></svg></span>`;
  const src = h(mediaURL(rep.thumb.replace(/^\//, '')));
  const it = store.state.allItems.find(i => i.id === rep.item);
  const W = it?.width || 0, H = it?.height || 0;
  const [x1, y1, x2, y2] = rep.bbox || [];
  if (W > 0 && H > 0 && x2 > x1 && y2 > y1) {
    const m = Math.max(x2 - x1, y2 - y1);
    const s = Math.min(0.72 * size / m, 6 * size / W);   // 臉佔 72%，放大上限 6×
    const left = size / 2 - (x1 + x2) / 2 * s;
    const top  = size / 2 - (y1 + y2) / 2 * s;
    return `<span class="${cls}"><img src="${src}" alt="" decoding="async"
      style="width:${(W * s).toFixed(1)}px;left:${left.toFixed(1)}px;top:${top.toFixed(1)}px"></span>`;
  }
  return `<span class="${cls}"><img src="${src}" alt="" decoding="async" class="cover"></span>`;
}

/* ── 側欄 PEOPLE 區 ─────────────────────────────────────────────────── */

export async function renderPeopleSidebar() {
  const box = $('people-panel');
  if (!box) return;
  const slug = _slug();
  if (!slug) { box.innerHTML = `<p class="side-placeholder">選擇資源庫後顯示人物</p>`; return; }
  box.innerHTML = `<p class="side-placeholder">人物載入中…</p>`;

  let d;
  try { d = await _fetch(slug); }
  catch (e) { d = { ok: false, error: e.message }; }
  if (slug !== _slug()) return;                     // 已切庫

  let bodyHTML;
  if (d.ok === false) {
    bodyHTML = `<p class="side-placeholder">AI 模組未就緒</p>`;
  } else if (!d.clustered || !(d.persons || []).length) {
    bodyHTML = `<p class="side-placeholder">此庫尚未進行人臉聚類</p>`;
  } else {
    const cards = d.persons.slice(0, 8).map(p => `
      <button class="pp-card" data-person="${h(p.person_id)}"
              title="${h(p.name || p.person_id)}：${p.count} 張臉">
        ${_avatarHTML(p.rep_face)}
        <span class="pp-count">${p.count}</span>
      </button>`).join('');
    bodyHTML = `<div class="pp-cards">${cards}</div>
      <button class="side-row" data-people-all>
        <svg class="icon icon-sm" aria-hidden="true"><use href="#i-people"/></svg>
        <span class="row-label">全部人物</span>
        <span class="count-pill">${d.persons.length}</span>
      </button>`;
  }

  box.innerHTML = `${bodyHTML}
    <div class="pp-progress" id="pp-progress" hidden>
      <span class="cov-bar"><span class="cov-fill" id="pp-progress-fill"></span></span>
      <span class="pp-progress-txt" id="pp-progress-txt"></span>
    </div>
    <div class="pp-actions">
      <button class="btn btn-ghost btn-sm" data-pp-act="recluster" title="增量重建人臉索引並重新聚類">重新聚類</button>
      <button class="btn btn-ghost btn-sm" data-pp-act="index" title="建立 clip + faces 索引">建立索引</button>
      <button class="btn btn-ghost btn-sm btn-icon" data-pp-act="status" title="AI 索引狀態" aria-label="AI 索引狀態">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#i-sparkle"/></svg>
      </button>
    </div>`;

  box.querySelectorAll('[data-person]').forEach(el =>
    el.addEventListener('click', () => navigate(`#/people/${encodeURIComponent(el.dataset.person)}`)));
  box.querySelector('[data-people-all]')?.addEventListener('click', () => navigate('#/people'));
  box.querySelectorAll('[data-pp-act]').forEach(el => el.addEventListener('click', () => {
    const act = el.dataset.ppAct;
    if (act === 'status') openAiStatusPanel();
    else if (act === 'recluster') startAiIndex(slug, 'faces');
    else if (act === 'index') startAiIndex(slug, 'both');
  }));
}

/* ── 索引進度（SSE 轉發；當前庫）────────────────────────────────────── */

function _onProgress(evt) {
  const bar = $('pp-progress');
  if (!bar) return;
  if (evt.phase === 'done' || evt.phase === 'error') {
    bar.hidden = true;
    if (evt.kind === 'faces' && evt.phase === 'done') {
      const slug = _slug();
      if (slug) { _cache.delete(slug); renderPeopleSidebar(); }
    }
    return;
  }
  bar.hidden = false;
  const p = evt.total ? Math.round((evt.done || 0) / evt.total * 100) : 100;
  $('pp-progress-fill').style.width = p + '%';
  $('pp-progress-txt').textContent =
    `${evt.kind === 'clip' ? '語意' : '人臉'}索引 ${evt.total ? `${evt.done} / ${evt.total}` : '…'}`;
}

/* ── #/people 路由（app.js dispatch）────────────────────────────────── */

export async function renderPeopleRoute(route) {
  const slug = _slug();
  const libType = store.state.libType;
  if (!slug) { renderPlaceholderPage('人物', '請先選擇資源庫', 'people'); return; }

  let d;
  try { d = await _fetch(slug); }
  catch (e) { renderPlaceholderPage('人物', e.message, 'close'); return; }
  if (d.ok === false || !d.clustered || !(d.persons || []).length) {
    renderBreadcrumb([{ label: '人物' }]);
    setContentChrome(false);
    showMessage('people', '此庫尚未有人物',
      d.ok === false ? (d.error || 'AI 模組未就緒') : '先建立人臉索引並聚類',
      `<button class="btn btn-sm" data-pp-index>建立人臉索引</button>`);
    document.querySelector('#grid-msg [data-pp-index]')
      ?.addEventListener('click', () => startAiIndex(slug, 'faces'));
    return;
  }

  const pid = route.params.personId;
  if (!pid) { _renderOverview(d); return; }

  const p = d.persons.find(x => x.person_id === pid);
  if (!p) { renderPlaceholderPage('人物', `找不到人物：${pid}`, 'close'); return; }
  const source = libType === 'excire' ? 'excire' : 'eagle';
  showMessage('people', '載入人物照片…');
  const vms = await adaptHits((p.items || []).map(id => ({ id, lib: slug, source })));
  renderVirtualView(vms, {
    crumbs: [{ label: '人物', hash: '#/people' },
             { label: `${p.name || p.person_id}（${p.count} 張臉）` }],
    note: '此人物沒有可顯示的照片',
  });
}

function _renderOverview(d) {
  renderBreadcrumb([{ label: '人物' }, { label: `共 ${d.persons.length} 人` }]);
  setContentChrome(false);
  const panel = pagePanel();
  panel.innerHTML = `<div class="pp-grid">${d.persons.map(p => `
    <button class="pp-tile" data-person="${h(p.person_id)}">
      ${_avatarHTML(p.rep_face, 72)}
      <span class="pp-tile-name">${h(p.name || p.person_id)}</span>
      <span class="pp-tile-count">${p.count} 張臉 · ${(p.items || []).length} 張照片</span>
    </button>`).join('')}</div>`;
  panel.querySelectorAll('[data-person]').forEach(el =>
    el.addEventListener('click', () => navigate(`#/people/${encodeURIComponent(el.dataset.person)}`)));
}
