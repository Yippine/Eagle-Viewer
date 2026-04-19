'use strict';
/* ── ui-filters.js  ▸  Domain chips / Tag chips / 篩選 UI ───────────────── */

import { state }         from './state.js';
import { h, HIDE_TAGS }  from './utils.js';
import { applyFilter }   from './grid.js';

/* ── Domain chips ───────────────────────────────────────────────────── */
export function buildDomainChips() {
  const cnt = {};
  state.ALL.forEach(i => { cnt[i.domain] = (cnt[i.domain] || 0) + 1; });
  const rows = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
  document.getElementById('dchips').innerHTML =
    _dchip('all', '全部', state.ALL.length, true) +
    rows.map(([d, c]) => _dchip(d, d, c, false)).join('');
  _updateFbarLabel();
}

function _dchip(d, label, cnt, on) {
  return `<button class="dchip${on ? ' on' : ''}" data-d="${h(d)}"
    onclick="setDomain('${h(d)}')">${h(label)}<span class="n">${cnt}</span></button>`;
}

export function setDomain(d) {
  state.curDomain = d;
  document.querySelectorAll('.dchip').forEach(el =>
    el.classList.toggle('on', el.dataset.d === d));
  _updateFbarLabel();
  applyFilter();
}

function _updateFbarLabel() {
  const lbl = document.getElementById('fbar-label');
  const cnt = document.getElementById('fbar-count');
  if (!lbl) return;
  if (state.curDomain === 'all') { lbl.textContent = '全部網域'; cnt.textContent = ''; }
  else {
    lbl.textContent = state.curDomain;
    const chip = document.querySelector(`.dchip[data-d="${CSS.escape(state.curDomain)}"] .n`);
    cnt.textContent = chip ? chip.textContent : '';
  }
}

export function toggleFbar() {
  state.fbarOpen = !state.fbarOpen;
  document.getElementById('fbar').classList.toggle('open', state.fbarOpen);
  document.getElementById('fbar-arrow').textContent = state.fbarOpen ? '▴' : '▾';
}

/* ── Tag chips ──────────────────────────────────────────────────────── */
export function buildTagChips() {
  const cnt = {};
  state.ALL.forEach(i => i.tags.forEach(t => {
    if (!HIDE_TAGS.has(t)) cnt[t] = (cnt[t] || 0) + 1;
  }));
  const tags = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 120).map(([t]) => t);
  const clearBtn = `<button class="ftag-clear" onclick="clearAllTags()" title="清除全部標籤">✕</button>`;
  document.getElementById('tchips').innerHTML =
    clearBtn +
    tags.map(t => `<button class="ftag" data-tag="${h(t)}" onclick="toggleTag('${h(t)}')">${h(t)}</button>`).join('');
}

export function clearAllTags() {
  state.curTags.clear();
  document.querySelectorAll('.ftag').forEach(el => el.classList.remove('on'));
  applyFilter();
}

let _tagHistoryPushed = false;

export function toggleTagPanel() {
  state.tagsOpen = !state.tagsOpen;
  document.getElementById('tag-panel').classList.toggle('open', state.tagsOpen);
  document.getElementById('tag-tog-inline')?.classList.toggle('open', state.tagsOpen);
  if (state.tagsOpen) {
    history.pushState({ overlay: 'tagpanel' }, '');
    _tagHistoryPushed = true;
  } else {
    if (_tagHistoryPushed) history.back();
    _tagHistoryPushed = false;
  }
}

export function closeTagPanel(fromPopstate = false) {
  if (!state.tagsOpen) return;
  state.tagsOpen = false;
  document.getElementById('tag-panel').classList.remove('open');
  document.getElementById('tag-tog-inline')?.classList.remove('open');
  if (!fromPopstate && _tagHistoryPushed) history.back();
  _tagHistoryPushed = false;
}

export function toggleTag(tag) {
  const el = document.querySelector(`.ftag[data-tag="${CSS.escape(tag)}"]`);
  if (state.curTags.has(tag)) { state.curTags.delete(tag); el?.classList.remove('on'); }
  else                        { state.curTags.add(tag);    el?.classList.add('on'); }
  applyFilter();
}

/* ── 標籤篩選動作 ────────────────────────────────────────────────────── */
/** 單一標籤切換（卡片 chip 點擊） */
export function filterByTag(tag) {
  if (state.curTags.has(tag)) state.curTags.delete(tag);
  else state.curTags.add(tag);
  document.querySelectorAll('.ftag').forEach(el =>
    el.classList.toggle('on', state.curTags.has(el.dataset.tag)));
  if (state.curTags.size && !state.tagsOpen) toggleTagPanel();
  applyFilter();
}

/** 套用整組標籤（清除舊選取，代入新集合） */
export function applyTagSet(tags) {
  state.curTags.clear();
  tags.forEach(t => state.curTags.add(t));
  document.querySelectorAll('.ftag').forEach(el =>
    el.classList.toggle('on', state.curTags.has(el.dataset.tag)));
  if (tags.length && !state.tagsOpen) toggleTagPanel();
  applyFilter();
}

/** 卡片 🏷 按鈕：套用該項目所有可見標籤 */
export function filterByItemTags(btn) {
  const item = state.ALL.find(x => x.id === btn.dataset.itemId);
  if (!item) return;
  const tags = (item.tags || []).filter(t => !HIDE_TAGS.has(t));
  applyTagSet(tags);
}

/* ── Preset Filter Panel ─────────────────────────────────────────── */
export function buildPresetChips() {
  const el = document.getElementById('pchips');
  if (!el) return;
  let presets = [];
  try { presets = JSON.parse(localStorage.getItem('eagle-presets') || '[]'); } catch {}
  presets = presets.filter(p => !p.deleted);
  const clearBtn = `<button class="fpreset-clear" onclick="clearPresetFilter()" title="清除濾鏡篩選">✕</button>`;
  el.innerHTML = clearBtn + presets.map(p =>
    `<button class="fpreset${state.curPreset === p.id ? ' on' : ''}" data-pid="${h(p.id)}" ` +
    `onclick="setPresetFilter('${h(p.id)}')">${h(p.name)}</button>`
  ).join('');
}

export function togglePresetPanel() {
  state.presetOpen = !state.presetOpen;
  document.getElementById('preset-panel').classList.toggle('open', state.presetOpen);
  document.getElementById('preset-tog-inline')?.classList.toggle('open', state.presetOpen);
  if (state.presetOpen) buildPresetChips();
}

export function closePresetPanel() {
  if (!state.presetOpen) return;
  state.presetOpen = false;
  document.getElementById('preset-panel').classList.remove('open');
  document.getElementById('preset-tog-inline')?.classList.remove('open');
}

export function setPresetFilter(id) {
  state.curPreset = state.curPreset === id ? null : id;
  buildPresetChips();
  applyFilter();
}

export function clearPresetFilter() {
  state.curPreset = null;
  buildPresetChips();
  applyFilter();
}
