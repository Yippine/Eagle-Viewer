'use strict';
/* ── grid.js  ▸  篩選 / 分頁 / 無限滾動 / Lazy video ────────────────────── */

import { state }                         from './state.js';
import { PAGE, isMobile }                from './utils.js';
import { seededShuffle, currentSeed }    from './shuffle.js';
import { computeFiltered }               from './search.js';
import { buildCard }                     from './renderer.js';

/* ── 無限滾動 sentinel ────────────────────────────────────────────────── */
export const sentinelObs = new IntersectionObserver(
  e => { if (e[0].isIntersecting) appendPage(); },
  { rootMargin: '300px' }
);
sentinelObs.observe(document.getElementById('sentinel'));

/* ── Lazy video（桌面才替換為真實 <video>）───────────────────────────── */
export const vidObs = new IntersectionObserver(entries => {
  entries.forEach(({ isIntersecting, target }) => {
    if (!isIntersecting) return;
    if (isMobile()) { vidObs.unobserve(target); return; }
    const src    = target.dataset.vsrc;
    const poster = target.dataset.vposter;
    if (!src) return;
    const vid = document.createElement('video');
    vid.src = src; vid.preload = 'metadata'; vid.playsInline = true;
    if (poster) vid.poster = poster;
    vid.style.cssText = 'opacity:0;width:100%;height:100%;object-fit:contain;display:block;background:#000;transition:opacity .3s';
    target.innerHTML = ''; target.appendChild(vid);
    requestAnimationFrame(() => requestAnimationFrame(() => { vid.style.opacity = '1'; }));
    vid.addEventListener('loadedmetadata', () => {
      // 若 renderer 未能從 metadata 取得尺寸，此處補正（避免保留 16:9 黑邊）
      const ratioBox = target.closest('.ratio-box');
      if (ratioBox && vid.videoWidth && vid.videoHeight) {
        const knownW = parseInt(target.dataset.vw || '0');
        const knownH = parseInt(target.dataset.vh || '0');
        if (!knownW || !knownH) {
          ratioBox.style.aspectRatio = `${vid.videoWidth} / ${vid.videoHeight}`;
        }
      }
    }, { once: true });
    vidObs.unobserve(target);
  });
}, { rootMargin: '400px 0px' });

/* ── applyFilter：重算 filtered 並重繪 grid ─────────────────────────── */
export function applyFilter() {
  const base = computeFiltered();
  state.shuffled  = seededShuffle(base, currentSeed());
  state.filtered  = state.shuffled;
  state.page      = 0;
  document.getElementById('grid').innerHTML = '';
  document.getElementById('ibar').textContent = `顯示 ${state.filtered.length} / ${state.ALL.length} 筆`;
  if (!state.filtered.length) {
    document.getElementById('grid').innerHTML =
      `<div class="state-empty" style="grid-column:1/-1;column:1/-1">
         <div class="ei">🔍</div><span>沒有符合的項目</span></div>`;
    return;
  }
  appendPage();
}

/* ── appendPage：渲染下一頁卡片 ────────────────────────────────────── */
export function appendPage() {
  const start = state.page * PAGE;
  if (start >= state.filtered.length) return;
  const loader = document.getElementById('loader');
  loader.classList.add('visible');
  requestAnimationFrame(() => {
    const slice = state.filtered.slice(start, start + PAGE);
    const frag  = document.createDocumentFragment();
    const tmp   = document.createElement('div');
    slice.forEach(item => {
      tmp.innerHTML = buildCard(item);
      while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    });
    document.getElementById('grid').appendChild(frag);
    state.page++;
    loader.classList.remove('visible');
    document.querySelectorAll('.vid-lazy[data-vsrc]:not([data-obs])').forEach(el => {
      el.dataset.obs = '1'; vidObs.observe(el);
    });
  });
}
