'use strict';
/* ── renderer.js  ▸  HTML 片段建構（buildCard、統計列、錯誤畫面）─────── */

import { state } from './state.js';
import { h, KIND_ICON, HIDE_TAGS, encodePath } from './utils.js';

function _fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024)       return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function _fmtRelTime(ms) {
  if (!ms) return '';
  const d = Math.floor((Date.now() - ms) / 86400000);
  if (d < 1)   return '今天';
  if (d < 30)  return d + ' 天前';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + ' 個月前';
  return Math.floor(mo / 12) + ' 年前';
}

function _fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function _fmtStars(n) {
  const f = Math.min(Math.max(n || 0, 0), 5);
  return `<span class="sort-stars">${'★'.repeat(f)}</span><span class="sort-stars-empty">${'☆'.repeat(5 - f)}</span>`;
}

function _fmtSizeBar(bytes) {
  if (!bytes) return '';
  const label = _fmtSize(bytes);
  const { sizeMin: mn, sizeMax: mx } = state;
  let pct = 50;
  if (mn > 0 && mx > mn) {
    const lv = Math.log(bytes), lm = Math.log(mn), lx = Math.log(mx);
    pct = Math.max(4, Math.min(100, Math.round((lv - lm) / (lx - lm) * 100)));
  }
  return `<span class="sort-size-bar" style="--fill:${pct}%"><span class="sort-size-fill" style="width:${pct}%"></span><span class="sort-size-label">${label}</span><span class="sort-size-label-inv">${label}</span></span>`;
}

function _fmtDuration(sec) {
  if (!sec) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  return `${m}:${String(ss).padStart(2,'0')}`;
}

// ext → CSS 類型群（image/video/audio/doc/other）
const _EXT_TYPE = (() => {
  const m = new Map();
  ['jpg','jpeg','png','gif','webp','svg','bmp','tiff','tif','ico','avif','heic','heif','raw','cr2','nef','arw'].forEach(e => m.set(e, 'image'));
  ['mp4','mov','avi','mkv','webm','flv','wmv','m4v','3gp','ts','mts','mpg','mpeg'].forEach(e => m.set(e, 'video'));
  ['mp3','wav','aac','flac','ogg','m4a','wma','aiff','opus'].forEach(e => m.set(e, 'audio'));
  ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','csv','json','xml','html','htm'].forEach(e => m.set(e, 'doc'));
  return m;
})();

function _fmtExtChip(ext) {
  if (!ext) return '';
  const type = _EXT_TYPE.get(ext.toLowerCase()) || 'other';
  return `<span class="sort-ext-chip sort-ext-${type}">${ext.toUpperCase()}</span>`;
}

function _fmtDimBar(w, h) {
  if (!w || !h) return '';
  const px    = w * h;
  const label = `${w}×${h}`;
  const { dimMin: mn, dimMax: mx } = state;
  let pct = 50;
  if (mn > 0 && mx > mn) {
    const lv = Math.log(px), lm = Math.log(mn), lx = Math.log(mx);
    pct = Math.max(4, Math.min(100, Math.round((lv - lm) / (lx - lm) * 100)));
  }
  return `<span class="sort-size-bar" style="--fill:${pct}%"><span class="sort-size-fill" style="width:${pct}%"></span><span class="sort-size-label">${label}</span><span class="sort-size-label-inv">${label}</span></span>`;
}

function _fmtDurationBar(sec) {
  if (!sec) return '';
  const label = _fmtDuration(sec);
  const { durationMin: mn, durationMax: mx } = state;
  let pct = 50;
  if (mn > 0 && mx > mn) {
    const lv = Math.log(sec), lm = Math.log(mn), lx = Math.log(mx);
    pct = Math.max(4, Math.min(100, Math.round((lv - lm) / (lx - lm) * 100)));
  }
  return `<span class="sort-size-bar" style="--fill:${pct}%"><span class="sort-size-fill" style="width:${pct}%"></span><span class="sort-size-label">${label}</span><span class="sort-size-label-inv">${label}</span></span>`;
}

/** 卡片 .cfolders：顯示 item 所屬資料夾 chips（client-side folderMap，全部顯示，OR 邏輯 toggle）
 *  注意：Eagle 在 item.folders 存放所有直接隸屬的 folder（非 leaf-only），
 *  故移除 isLeaf 限制，使 x.com / facebook 等中間節點也正常顯示。*/
function _getFolderChips(item) {
  const fmap = state.folderMap || {};
  const leafFolders = (item.folders || [])
    .map(id => ({ id, ...fmap[id] }))
    .filter(f => f?.name);   // 只要 name 存在（folder 有效）即顯示，不限 isLeaf
  if (!leafFolders.length) return '';
  const chips = leafFolders
    .map(f => {
      const active = state.curFolderIds?.has(f.id) ? ' folder-chip-active' : '';
      return `<span class="folder-chip${active}" onclick="event.stopPropagation();_filterByFolderId('${h(f.id)}')" title="資料夾篩選（點擊疊加/取消）">📁 ${h(f.name)}</span>`;
    })
    .join('');
  return `<div class="cfolders">${chips}</div>`;
}

function _getSortMeta(i, key) {
  switch (key) {
    case 'star':     return _fmtStars(i.star);
    case 'size':     return _fmtSizeBar(i.size);
    case 'mtime':    return _fmtDate(i.mtime);
    case 'date':     return _fmtDate(parseInt(i.id ? i.id.slice(0, 8) : '0', 36));
    case 'ext':      return _fmtExtChip(i.ext);
    case 'dim':      return _fmtDimBar(i.width, i.height);
    case 'duration': return _fmtDurationBar(i.duration);
    default:         return '';
  }
}

function _readSnapTx(itemId) {
  try {
    const raw = localStorage.getItem('eagle-transform-' + itemId);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || snap.deleted) return null;
    const tx = snap.tx;
    if (!tx) return null;
    if (tx.scaleX === 1 && tx.scaleY === 1 && tx.translateX === 0 && tx.translateY === 0
        && tx.rotate === 0 && !tx.flipH && !tx.flipV) return null;
    return tx;
  } catch { return null; }
}

/** 建立單張卡片 HTML */
export function buildCard(i) {
  const folderChips = _getFolderChips(i);
  const sortMeta    = _getSortMeta(i, state.curSortKey);
  const title       = i.name || i.id;
  const idSafe      = h(i.id);
  const urlSafe     = h(i.url);

  // badge：種類 icon，移至 cbody domain 行（不再占用 cmedia 左上角）
  const kindIcon   = KIND_ICON[i.kind] || '';
  const domainLine = kindIcon
    ? `<div class="cdomain"><span class="kind-badge">${kindIcon}</span>${h(i.domain)}</div>`
    : `<div class="cdomain">${h(i.domain)}</div>`;

  // ov-bar：底部 action bar（📂/🔍 + 🦅 + ⋮）
  const hasLeafFolders = folderChips !== '';
  const folderFilterIcon = hasLeafFolders ? '📂' : '🔍';
  const folderFilterTitle = hasLeafFolders ? '套用此項目資料夾篩選（取代目前篩選）' : '套用此項目標籤篩選';
  // 🔍 只在有 leaf folders 或有可見標籤時顯示
  const allVisible = (i.tags || []).filter(t => !HIDE_TAGS.has(t));
  const filterBtn  = (hasLeafFolders || allVisible.length) && i.id
    ? `<button class="ov-tags" data-item-id="${idSafe}" onclick="event.stopPropagation();_filterByItemTags(this)" title="${folderFilterTitle}">${folderFilterIcon}</button>`
    : '';
  const eagle = i.id
    ? `<a class="ov-eagle" href="eagle://item/${h(i.id)}" onclick="event.stopPropagation()" title="在 Eagle 中開啟">🦅</a>`
    : '';
  const moreBtn = i.id
    ? `<button class="ov-more" onclick="event.stopPropagation();openActionSheet('${idSafe}')" title="更多操作">⋮</button>`
    : '';
  const ovBar = (filterBtn || eagle || moreBtn)
    ? `<div class="ov-bar">${filterBtn}${eagle}${moreBtn}</div>`
    : '';

  const fileSrc  = i.file  ? '/' + encodePath(i.file)  : '';
  const thumbSrc = i.thumb ? '/' + encodePath(i.thumb) : '';

  let media = '';
  if (i.file && i.media_type === 'image') {
    const dimAttrs = (i.width && i.height) ? ` width="${i.width}" height="${i.height}"` : '';
    media = `<div class="cmedia">
      <img class="nat" src="${h(fileSrc)}" loading="lazy" alt="${h(title)}"${dimAttrs}
           onclick="event.stopPropagation();_imgClick('${idSafe}','${h(fileSrc)}')">
      ${ovBar}
    </div>`;
  } else if (i.file && i.media_type === 'video') {
    const snapTx = (i.id && i.width && i.height) ? _readSnapTx(i.id) : null;
    const tAttr = (!snapTx && thumbSrc) ? `style="background:url('${h(thumbSrc)}') center/cover no-repeat"` : '';
    const ratioStyle = (i.width && i.height) ? ` style="aspect-ratio:${i.width}/${i.height}"` : '';
    const snapAttrs = i.id
      ? ` data-snap-id="${idSafe}"${i.width ? ` data-snap-nw="${i.width}"` : ''}${i.height ? ` data-snap-nh="${i.height}"` : ''}`
      : '';
    const snapContent = (snapTx && thumbSrc) ? `<img class="snap-thumb" src="${h(thumbSrc)}" alt="" loading="lazy">` : '';
    media = `<div class="cmedia">
      <div class="ratio-box"${ratioStyle}>
        <div class="vid-lazy${snapTx ? ' vid-snap' : ''}" data-vsrc="${h(fileSrc)}"${i.width ? ` data-vw="${i.width}"` : ''}${i.height ? ` data-vh="${i.height}"` : ''}${thumbSrc ? ` data-vposter="${h(thumbSrc)}"` : ''}${tAttr ? ' ' + tAttr : ''}${snapAttrs}>${snapContent}</div>
        <div class="play-ov"><div class="play-circle">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
        </div></div>
        <div class="mob-play-hint">點擊播放</div>
      </div>
      ${ovBar}
    </div>`;
  } else if (i.thumb) {
    const ratioStyle = (i.width && i.height) ? ` style="aspect-ratio:${i.width}/${i.height}"` : '';
    media = `<div class="cmedia">
      <div class="ratio-box"${ratioStyle}><img src="${h(thumbSrc)}" loading="lazy" alt="${h(title)}"></div>
      ${ovBar}
    </div>`;
  } else {
    media = `<div class="cmedia">
      <div class="no-med"><span class="ni">${KIND_ICON[i.kind] || '🔗'}</span><span class="nd">${h(i.domain)}</span></div>
      ${ovBar}
    </div>`;
  }

  const cbodyClick = i.url
    ? `onclick="event.stopPropagation();_cbodyClick(event,'${idSafe}','${urlSafe}')"` : '';
  return `<div class="card" data-id="${idSafe}" onclick="_cardClick(event,'${idSafe}','${urlSafe}')">
    ${media}
    <div class="cbody" ${cbodyClick} ${cbodyClick ? 'title="點擊開啟原始連結"' : ''}>
      ${domainLine}
      <div class="ctitle" title="${h(title)}">${h(title)}</div>
      ${folderChips}
      <div class="sort-meta">${sortMeta}</div>
    </div>
  </div>`;
}

/**
 * 即時更新卡片的 .sort-meta（僅在 curSortKey === key 時生效）
 * @param {string} id    item id
 * @param {string} key   sort key（e.g. 'star'）
 * @param {*}      value 新值
 */
export function patchCardSortMeta(id, key, value) {
  if (state.curSortKey !== key) return;
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const meta = card.querySelector('.sort-meta');
  if (!meta) return;
  const dummy = { [key]: value };
  meta.innerHTML = _getSortMeta(dummy, key);
}

/**
 * 即時更新卡片的 .ctags 區塊（標籤異動後呼叫，不重繪整張卡片）
 * 注意：buildCard 已不再渲染 .ctags（卡片改顯示資料夾），此函式保留為 no-op
 * @param {string} id    item id
 * @param {string[]} tags 新標籤陣列（含 archived 等隱藏標籤）
 */
export function patchCardTags(id, tags) {
  // 卡片 cbody 已改為僅顯示 .cfolders，不再顯示 .ctags
  // 標籤異動記錄在 item.tags，但不更新卡片視覺（folder chips 不變）
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const cbody = card.querySelector('.cbody');
  if (!cbody) return;

  const allVis  = (tags || []).filter(t => !HIDE_TAGS.has(t));
  const show    = allVis.slice(0, 4);
  const extra   = allVis.length - show.length;
  const visibleTags = show
    .map(t => `<span class="tg tg-click" onclick="event.stopPropagation();_filterByTag('${h(t)}')" title="加入標籤篩選">${h(t)}</span>`)
    .join('')
    + (extra > 0 ? `<span class="tg tg-more" title="還有 ${extra} 個標籤">+${extra}</span>` : '');

  // 只移除已存在的 ctags（不新增），保持卡片只顯示 .cfolders
  let ctags = cbody.querySelector('.ctags');
  if (visibleTags) {
    if (ctags) {
      ctags.innerHTML = visibleTags;
    }
    // else: 不新增 ctags — 卡片設計只顯示資料夾
  } else {
    ctags?.remove();
  }
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
