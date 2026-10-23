/* ── ai-tags.js ▸ B5 人數/場景/運動標籤（/api/ai/tags 快取 + 篩選判定）──
   - 後端 scene_tags.json（人數 = 自建人臉數；場景/運動 = Excire 關鍵字優先
     + Chinese-CLIP zero-shot 補），本模組僅做每庫一次的 lazy fetch 快取。
   - filterItems（items.js）經 opts.aiTags 消費；載入前 aiTagsSync 回 null
     → 不過濾（lib-data.js 於載入完成後重繪）。
   - 分類名全繁體中文；「背影/無臉者不計入人數」為已知限制（B5 報告）。 */

import { api } from './api.js';
import { peopleMatch } from './items.js';

export { peopleMatch };

/* 篩選選單選項（與後端 scene_tags.SCENE_LABELS / SPORT_LABELS 同步） */
export const PEOPLE_OPTS = [
  ['', '任意人數'], ['1', '1 人'], ['2', '2 人'], ['3-5', '3–5 人'], ['6+', '6 人以上'],
];
export const SCENE_OPTS = ['捷運', '火車', '公車', '教室', '場館', '廁所',
                           '客廳', '浴室', '走廊', '宿舍', '戶外'];
export const SPORT_OPTS = ['籃球', '足球', '羽毛球', '棒球', '賽車', '拳擊'];

const _cache = new Map();     // slug → items map（{} = 已載入但無資料）
const _pending = new Map();   // slug → Promise

/** 已載入 → items map；未載入 → null（呼叫端自行 loadAiTags 後重繪） */
export function aiTagsSync(slug) {
  return _cache.has(slug) ? _cache.get(slug) : null;
}

export function loadAiTags(slug) {
  if (!slug) return Promise.resolve({});
  if (_cache.has(slug)) return Promise.resolve(_cache.get(slug));
  if (_pending.has(slug)) return _pending.get(slug);
  const p = api.aiTags(slug)
    .then(d => (d.ok && d.built ? (d.items || {}) : {}))
    .catch(() => ({}))
    .then(m => { _cache.set(slug, m); _pending.delete(slug); return m; });
  _pending.set(slug, p);
  return p;
}

/** 標籤索引重建後（kind=tags 完成）呼叫使快取失效 */
export function bustAiTags(slug) { _cache.delete(slug); _pending.delete(slug); }
