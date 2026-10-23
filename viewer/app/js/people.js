/* ── people.js ▸ 左欄 PEOPLE 區 + 人物頁（B5；/api/ai/faces/persons）─────
   - 側欄：當前庫人物卡（代表臉依 bbox 裁切頭像）前 8 人 + 全部人物入口 +
     「重新聚類」「建立索引」（POST /api/ai/index）+ AI 狀態面板入口；
     索引進度以 inline 進度條顯示（store 'ai-progress'，SSE 轉發）。
   - #/people = 全部人物總覽頁（page-panel）：人名/編號搜尋 + 性別/年齡篩選
     （Excire FaceTagger 屬性；缺值顯示「未知」）+ 就地命名（B1；Enter 儲存、
     Esc 取消；名字寫入本站 persons.json，重聚類以 centroid 匹配保名）。
   - #/people/{personId} = 該人全部照片虛擬視圖（ai-search renderVirtualView，
     走同一 grid 管線）；已命名者以人名為主顯示、p 編號退為次要。 */

import { api, mediaURL } from './api.js';
import { store } from './store.js';
import { navigate, parseLibId } from './router.js';
import { h } from './items.js';
import { showMessage } from './grid.js';
import { renderBreadcrumb, setContentChrome, pagePanel, renderPlaceholderPage }
  from './page-chrome.js';
import { openAiStatusPanel, startAiIndex } from './ai-status.js';
import { adaptHits, renderVirtualView } from './ai-search.js';
import { toast } from './notifications.js';
import { bustAiTags } from './ai-tags.js';

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
  /* B3：影片抽幀臉的 bbox 屬該幀（frame_ts 秒），與首幀縮圖不對位 → cover 顯示 */
  if (rep.frame_ts != null)
    return `<span class="${cls}"><img src="${src}" alt="" decoding="async" class="cover"></span>`;
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
      ${store.state.libType === 'eagle'
        ? `<button class="btn btn-ghost btn-sm" data-pp-act="video"
             title="影片以 ffmpeg 均勻抽幀補人臉索引（增量，B3）並重新聚類">影片抽幀</button>` : ''}
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
    else if (act === 'video') startAiIndex(slug, 'video-faces');
  }));
}

/* ── 索引進度（SSE 轉發；當前庫）────────────────────────────────────── */

function _onProgress(evt) {
  const bar = $('pp-progress');
  if (!bar) return;
  if (evt.phase === 'done' || evt.phase === 'error') {
    bar.hidden = true;
    if ((evt.kind === 'faces' || evt.kind === 'video-faces') && evt.phase === 'done') {
      const slug = _slug();
      if (slug) { _cache.delete(slug); renderPeopleSidebar(); }
    }
    if (evt.kind === 'tags' && evt.phase === 'done' && _slug()) bustAiTags(_slug());
    return;
  }
  bar.hidden = false;
  const p = evt.total ? Math.round((evt.done || 0) / evt.total * 100) : 100;
  const KIND_TXT = { clip: '語意', faces: '人臉', 'video-faces': '影片抽幀', tags: '標籤' };
  $('pp-progress-fill').style.width = p + '%';
  $('pp-progress-txt').textContent =
    `${KIND_TXT[evt.kind] || evt.kind}索引 ${evt.total ? `${evt.done} / ${evt.total}` : '…'}`;
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
  if (!pid) { _renderOverview(d, slug); return; }

  const p = d.persons.find(x => x.person_id === pid);
  if (!p) { renderPlaceholderPage('人物', `找不到人物：${pid}`, 'close'); return; }
  const source = libType === 'excire' ? 'excire' : 'eagle';
  showMessage('people', '載入人物照片…');
  const vms = await adaptHits((p.items || []).map(id => ({ id, lib: slug, source })));
  const label = p.name                                   // 已命名 → 人名為主、編號次要
    ? `${p.name}（${p.person_id} · ${p.count} 張臉）`
    : `${p.person_id}（${p.count} 張臉）`;
  renderVirtualView(vms, {
    crumbs: [{ label: '人物', hash: '#/people' }, { label }],
    note: '此人物沒有可顯示的照片',
  });
}

/* ── 人物總覽：搜尋（人名/編號）+ 性別/年齡篩選 + 就地命名 ──────────── */

const GENDER_LABEL = { male: '男', female: '女', unknown: '未知' };
const AGE_LABEL = { baby: '嬰兒', child: '兒童', teenager: '青少年',
                    adult: '成人', elderly: '年長', unknown: '未知' };

const _opts = (labels, cur) => Object.entries(labels)
  .map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('');

function _tileHTML(p, hasAttrs) {
  const named = !!p.name;
  const attr = hasAttrs
    ? `<span class="pp-tile-attr">${GENDER_LABEL[p.gender] || '未知'} · ${AGE_LABEL[p.age] || '未知'}</span>`
    : '';
  return `
    <div class="pp-tile" data-person="${h(p.person_id)}" tabindex="0" role="button"
         aria-label="${h(p.name || p.person_id)}">
      ${_avatarHTML(p.rep_face, 72)}
      <span class="pp-tile-name">${h(p.name || p.person_id)}</span>
      ${named ? `<span class="pp-tile-pid">${h(p.person_id)}</span>` : ''}
      ${attr}
      <span class="pp-tile-count">${p.count} 張臉 · ${(p.items || []).length} 張照片</span>
      <button class="btn btn-ghost btn-sm btn-icon pp-edit" data-edit
              title="${named ? '改名（清空即取消命名）' : '命名'}" aria-label="命名">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#i-pencil"/></svg>
      </button>
    </div>`;
}

function _startRename(tile, d, slug, rerender) {
  const pid = tile.dataset.person;
  const p = d.persons.find(x => x.person_id === pid);
  if (!p || tile.classList.contains('editing')) return;
  tile.classList.add('editing');
  const span = tile.querySelector('.pp-tile-name');
  span.innerHTML = `<input class="pp-name-input" type="text" maxlength="80"
    value="${h(p.name || '')}" placeholder="輸入人名" aria-label="人物命名">`;
  const inp = span.querySelector('input');
  inp.focus(); inp.select();
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    const val = inp.value.trim();
    if (save && val !== (p.name || '')) {
      try {
        await api.aiFacesPersonName(slug, pid, val || null);
        p.name = val || null;              // d 即 _cache 內容，同步更新
        toast(val ? `已命名：${val}` : `已清除 ${pid} 的命名`);
        renderPeopleSidebar();
      } catch (e) { toast(`命名失敗：${e.message}`, { err: true }); }
    }
    rerender();                            // 重繪 tiles（未儲存的編輯一併還原）
  };
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  inp.addEventListener('click', e => e.stopPropagation());
  inp.addEventListener('blur', () => finish(false));
}

function _renderOverview(d, slug) {
  renderBreadcrumb([{ label: '人物' }, { label: `共 ${d.persons.length} 人` }]);
  setContentChrome(false);
  const panel = pagePanel();
  const hasAttrs = !!d.attrs_available;
  const f = { q: '', gender: 'all', age: 'all' };

  panel.innerHTML = `
    <div class="pp-toolbar">
      <input class="pp-search" type="search" placeholder="搜尋人名或編號…" aria-label="搜尋人物">
      ${hasAttrs ? `
        <label class="pp-filter">性別
          <select data-pp-f="gender"><option value="all">全部</option>${_opts(GENDER_LABEL, '')}</select>
        </label>
        <label class="pp-filter">年齡
          <select data-pp-f="age"><option value="all">全部</option>${_opts(AGE_LABEL, '')}</select>
        </label>` : ''}
      <span class="pp-toolbar-count" id="pp-ov-count"></span>
    </div>
    <div class="pp-grid" id="pp-ov-grid"></div>`;

  const grid = panel.querySelector('#pp-ov-grid');
  const countEl = panel.querySelector('#pp-ov-count');

  const apply = () => {
    const q = f.q.toLowerCase();
    const list = d.persons.filter(p => {
      if (q && !`${p.name || ''} ${p.person_id}`.toLowerCase().includes(q)) return false;
      if (f.gender !== 'all' && (p.gender || 'unknown') !== f.gender) return false;
      if (f.age !== 'all' && (p.age || 'unknown') !== f.age) return false;
      return true;
    });
    grid.innerHTML = list.map(p => _tileHTML(p, hasAttrs)).join('')
      || `<p class="side-placeholder pp-empty">沒有符合條件的人物</p>`;
    countEl.textContent = list.length === d.persons.length
      ? `${d.persons.length} 人` : `${list.length} / ${d.persons.length} 人`;
    grid.querySelectorAll('.pp-tile').forEach(tile => {
      const go = () => navigate(`#/people/${encodeURIComponent(tile.dataset.person)}`);
      tile.addEventListener('click', e => {
        if (e.target.closest('[data-edit]') || tile.classList.contains('editing')) return;
        go();
      });
      tile.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && !tile.classList.contains('editing')) {
          e.preventDefault(); go();
        }
      });
      tile.querySelector('[data-edit]')?.addEventListener('click', () =>
        _startRename(tile, d, slug, apply));
    });
  };

  panel.querySelector('.pp-search').addEventListener('input', e => {
    f.q = e.target.value.trim(); apply();
  });
  panel.querySelectorAll('[data-pp-f]').forEach(sel =>
    sel.addEventListener('change', () => { f[sel.dataset.ppF] = sel.value; apply(); }));
  apply();
}
