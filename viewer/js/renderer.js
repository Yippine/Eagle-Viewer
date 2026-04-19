'use strict';
/* ── renderer.js  ▸  HTML 片段建構（buildCard、統計列、錯誤畫面）─────── */

import { state } from './state.js';
import { h, KIND_ICON, HIDE_TAGS, encodePath } from './utils.js';

/** 建立單張卡片 HTML */
export function buildCard(i) {
  const title    = i.name || i.id;
  const badge    = `<div class="badge">${KIND_ICON[i.kind] || '🔗'}</div>`;
  const eagle    = i.id
    ? `<a class="ov-eagle" href="eagle://item/${h(i.id)}" onclick="event.stopPropagation()" title="在 Eagle 中開啟">🦅</a>`
    : '';
  const idSafe   = h(i.id);
  const urlSafe  = h(i.url);

  const visibleTags = (i.tags || []).filter(t => !HIDE_TAGS.has(t)).slice(0, 4)
    .map(t => `<span class="tg tg-click" onclick="event.stopPropagation();_filterByTag('${h(t)}')" title="加入標籤篩選">${h(t)}</span>`)
    .join('');
  const allVisible = (i.tags || []).filter(t => !HIDE_TAGS.has(t));
  const tagSearchBtn = allVisible.length
    ? `<button class="ov-tags" data-item-id="${idSafe}" onclick="event.stopPropagation();_filterByItemTags(this)" title="以此項目所有標籤搜尋">🏷</button>`
    : '';

  const fileSrc  = i.file  ? '/' + encodePath(i.file)  : '';
  const thumbSrc = i.thumb ? '/' + encodePath(i.thumb) : '';

  let media = '';
  if (i.file && i.media_type === 'image') {
    media = `<div class="cmedia">${badge}${eagle}${tagSearchBtn}
      <img class="nat" src="${h(fileSrc)}" loading="lazy" alt="${h(title)}"
           onclick="event.stopPropagation();_imgClick('${idSafe}','${h(fileSrc)}')">
    </div>`;
  } else if (i.file && i.media_type === 'video') {
    const tAttr = thumbSrc ? `style="background:url('${h(thumbSrc)}') center/cover no-repeat"` : '';
    const ratioStyle = (i.width && i.height) ? ` style="aspect-ratio:${i.width}/${i.height}"` : '';
    media = `<div class="cmedia">${badge}${eagle}${tagSearchBtn}
      <div class="ratio-box"${ratioStyle}>
        <div class="vid-lazy" data-vsrc="${h(fileSrc)}"${i.width ? ` data-vw="${i.width}"` : ''}${i.height ? ` data-vh="${i.height}"` : ''}${thumbSrc ? ` data-vposter="${h(thumbSrc)}"` : ''}${tAttr ? ' ' + tAttr : ''}></div>
        <div class="play-ov"><div class="play-circle">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
        </div></div>
        <div class="mob-play-hint">點擊播放</div>
      </div>
    </div>`;
  } else if (i.thumb) {
    media = `<div class="cmedia">${badge}${eagle}${tagSearchBtn}
      <div class="ratio-box"><img src="${h(thumbSrc)}" loading="lazy" alt="${h(title)}"></div>
    </div>`;
  } else {
    media = `<div class="cmedia">${eagle}${tagSearchBtn}
      <div class="no-med"><span class="ni">${KIND_ICON[i.kind] || '🔗'}</span><span class="nd">${h(i.domain)}</span></div>
    </div>`;
  }

  const cbodyClick = i.url
    ? `onclick="event.stopPropagation();_cbodyClick(event,'${idSafe}','${urlSafe}')"` : '';
  return `<div class="card" data-id="${idSafe}" onclick="_cardClick(event,'${idSafe}','${urlSafe}')">
    ${media}
    <div class="cbody" ${cbodyClick} ${cbodyClick ? 'title="點擊開啟原始連結"' : ''}>
      <div class="cdomain">${h(i.domain)}</div>
      <div class="ctitle" title="${h(title)}">${h(title)}</div>
      ${visibleTags ? `<div class="ctags">${visibleTags}</div>` : ''}
    </div>
  </div>`;
}

/** 渲染頂部統計列 */
export function renderStatsRow(s) {
  if (!s) return;
  document.getElementById('stats-row').innerHTML =
    `<b>${s.total}</b> 筆 · 🎬&thinsp;<b>${s.video}</b> · 📄&thinsp;<b>${s.post}</b>` +
    ` · 🔗&thinsp;<b>${s.other}</b> · <b>${s.domains}</b> 網域`;
}

/** 顯示載入失敗提示（含重新設定按鈕） */
export function showLoadError(allowReconfigure = false) {
  const reconfigBtn = allowReconfigure
    ? `<button id="reconfig-btn" style="
        margin-top:8px;background:var(--accent);color:#fff;border:none;
        border-radius:20px;padding:8px 24px;font-size:14px;
        font-family:inherit;cursor:pointer;transition:opacity .15s"
        onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
        重新設定路徑
      </button>`
    : '';
  document.getElementById('grid').innerHTML = `
    <div class="state-loading" style="color:var(--text);column:1/-1">
      <div style="font-size:44px">📂</div>
      <div style="font-size:15px;font-weight:600">找不到資源庫</div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:4px">
        請確認選取的是 Eagle App 的 <code style="background:var(--bg);padding:1px 6px;border-radius:4px">.class</code> 資料夾
      </div>
      ${reconfigBtn}
    </div>`;
  if (allowReconfigure) {
    document.getElementById('reconfig-btn')
      ?.addEventListener('click', () => window._showSetupForm());
  }
}
