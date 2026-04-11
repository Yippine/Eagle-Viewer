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

/** 根據目前 state 篩選條件計算結果（不修改 state） */
export function computeFiltered() {
  const terms = parseQuery(state.curQ);
  return state.ALL.filter(i => {
    if (state.curDomain !== 'all' && i.domain !== state.curDomain) return false;

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
    return matchItem(i, terms);
  });
}
