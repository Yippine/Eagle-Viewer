'use strict';
/* ── search.js  ▸  查詢解析 + 項目篩選（純邏輯，無 DOM）────────────────── */

import { state } from './state.js';

/** 中文→英文欄位別名 */
const _FA = { '名稱': 'name', '標籤': 'tag', '網域': 'domain', '類型': 'kind', '網址': 'url' };

/** 解析搜尋字串為 term 陣列 */
export function parseQuery(raw) {
  const terms = [];
  const re = /(-?)(?:"([^"]*)"|([\S]+))/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const ex = m[1] === '-';
    const rv = (m[2] !== undefined ? m[2] : m[3] || '').trim();
    if (!rv) continue;
    const v = rv.toLowerCase();
    const c = v.indexOf(':');
    if (c > 0) {
      let f = v.slice(0, c), vv = v.slice(c + 1);
      f = _FA[f] || f;
      if (vv) terms.push({ field: f, value: vv, exclude: ex });
    } else {
      terms.push({ field: '*', value: v, exclude: ex });
    }
  }
  return terms;
}

/** 判斷單個項目是否符合 terms */
export function matchItem(item, terms) {
  if (!terms.length) return true;
  const n  = (item.name   || '').toLowerCase();
  const u  = (item.url    || '').toLowerCase();
  const d  = (item.domain || '').toLowerCase();
  const tg = (item.tags   || []).map(t => t.toLowerCase());
  const k  = (item.kind   || '').toLowerCase();
  const id = (item.id     || '').toLowerCase();

  for (const { field, value, exclude } of terms) {
    let m = false;
    switch (field) {
      case '*':      m = n.includes(value) || u.includes(value) || d.includes(value) || tg.some(t => t.includes(value)); break;
      case 'name':   m = n.includes(value); break;
      case 'tag':    m = tg.some(t => t.includes(value)); break;
      case 'domain': m = d.includes(value); break;
      case 'url':    m = u.includes(value); break;
      case 'kind':   m = k.includes(value); break;
      case 'id':     m = id.includes(value); break;
      default:       m = n.includes(value) || tg.some(t => t.includes(value));
    }
    if (exclude &&  m) return false;
    if (!exclude && !m) return false;
  }
  return true;
}

/** 遞迴檢查 itemFolderSet 是否包含 fid 的任一後代 folder
 *  用於「點父節點 = 包含其所有後代 items」的篩選語意 */
function _isInBranch(itemFolderSet, fid, folderMap) {
  const f = folderMap?.[fid];
  if (!f) return false;
  for (const cid of (f.childrenIds || [])) {
    if (itemFolderSet.has(cid) || _isInBranch(itemFolderSet, cid, folderMap)) return true;
  }
  return false;
}

/** 根據目前 state 篩選條件計算結果（不修改 state） */
export function computeFiltered() {
  const terms = parseQuery(state.curQ);
  return state.ALL.filter(i => {
    // 垃圾桶模式：只顯示封存素材；一般模式：隱藏封存素材
    const isArchived = (i.tags || []).includes('archived');
    if ( state.trashMode && !isArchived) return false;
    if (!state.trashMode &&  isArchived) return false;
    if (state.curDomains?.size && !state.curDomains.has(i.domain)) return false;

    /* 類型篩選（新邏輯：bookmark / video / gif / image） */
    if (state.curType !== 'all') {
      const mt  = (i.media_type || '').toLowerCase();
      const ext = i.file ? i.file.toLowerCase().split('.').pop() : '';
      const isGif = mt === 'gif' || ext === 'gif';
      switch (state.curType) {
        case 'bookmark': if (i.file)                          return false; break;
        case 'video':    if (mt !== 'video')                  return false; break;
        case 'gif':      if (!isGif)                          return false; break;
        case 'image':    if (mt !== 'image' || isGif)         return false; break;
        default:         if (i.kind !== state.curType)        return false; break;
      }
    }

    if (state.curTags.size && ![...state.curTags].every(t => (i.tags || []).includes(t))) return false;

    // 資料夾篩選（AND 邏輯）：item 的 folders 必須覆蓋所有 curFolderIds
    // 每個 fid 的匹配：item.folders 包含 fid 自身 OR 屬於 fid 的任一後代 folder
    // → 點「室內」= item 在室內或任何室內子資料夾（房間/教室...）均視為命中
    if (state.curFolderIds?.size) {
      const itemFolderSet = new Set(i.folders || []);
      const ok = [...state.curFolderIds].every(
        fid => itemFolderSet.has(fid) || _isInBranch(itemFolderSet, fid, state.folderMap)
      );
      if (!ok) return false;
    }

    // 濾鏡篩選（多選 OR：item 的 presetIds 與 curPresets 有任一交集即命中）（w020）
    if (state.curPresets?.size) {
      try {
        const vd = JSON.parse(localStorage.getItem(`eagle-media-filter-${i.id}`) || '{}');
        if (!(vd.presetIds || []).some(pid => state.curPresets.has(pid))) return false;
      } catch { return false; }
    }

    return matchItem(i, terms);
  });
}
