/* ── ai-tags.js ▸ B5 人數/場景/運動 + B6 表情標籤（AI 標籤快取 + 篩選判定）──
   - 後端 scene_tags.json（人數 = 自建人臉數；場景/運動 = Excire 關鍵字優先
     + Chinese-CLIP zero-shot 補）與 item_expressions.json（B6 FER+ 臉部表情，
     項目層 = 該圖各臉表情集合），本模組合併為單一 map、每庫一次 lazy fetch 快取。
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
export const SCENE_OPTS = ['捷運', '火車', '高鐵', '公車', '教室', '場館', '廁所',
                           '客廳', '浴室', '走廊', '宿舍', '戶外'];
export const SPORT_OPTS = ['籃球', '足球', '羽毛球', '棒球', '賽車', '拳擊'];
/* 動作粗類（item 4；與後端 scene_tags.ACTION_LABELS 同步） */
export const ACTION_OPTS = ['站立', '坐著', '跑步', '跳躍', '游泳', '攀爬', '親吻'];
/* B6 表情八類（與後端 fer_setup.EXPR_LABELS_ZH 同步；順序依常用度） */
export const EXPR_OPTS = ['開心', '難過', '生氣', '驚訝', '害怕', '厭惡', '中性', '輕蔑'];
/* 服裝粗類 fallback（與後端 clothing_tags.CLOTHING_SLOTS 同步；載入前 / 失敗時使用，
   實際選單優先由 API 回傳的 labels 動態產生——後端詞表為唯一 SSOT，見 toolbar.js _dimMenu） */
export const CLOTHING_OPTS = [
  '球帽', '毛帽', '安全帽',
  '帽T', 'T恤', '襯衫', '外套', '毛衣', '背心', '西裝', '球衣',
  '長褲', '短褲', '牛仔褲', '裙子',
  '運動鞋', '皮鞋', '涼拖鞋', '靴子',
  '校服', '運動服', '洋裝', '泳裝',
];

const _cache = new Map();     // slug → items map（{} = 已載入但無資料）
const _pending = new Map();   // slug → Promise
let _clothingLabels = null;   // 最近一次 API 回傳的 labels（{slot:[...]}）攤平陣列，動態選單用

/** 已載入 → items map；未載入 → null（呼叫端自行 loadAiTags 後重繪） */
export function aiTagsSync(slug) {
  return _cache.has(slug) ? _cache.get(slug) : null;
}

export function loadAiTags(slug) {
  if (!slug) return Promise.resolve({});
  if (_cache.has(slug)) return Promise.resolve(_cache.get(slug));
  if (_pending.has(slug)) return _pending.get(slug);
  const p = Promise.all([
    api.aiTags(slug)
      .then(d => (d.ok && d.built ? (d.items || {}) : {})).catch(() => ({})),
    api.aiExpressions(slug)                       // B6：item → [表情, ...]
      .then(d => (d.ok && d.built ? (d.items || {}) : {})).catch(() => ({})),
    api.aiClothing(slug)                          // 服裝粗類：item → {tags, persons}
      .then(d => (d.ok && d.built ? d : null)).catch(() => null),
  ]).then(([tags, exprs, clothing]) => {
    const m = { ...tags };
    for (const [id, ex] of Object.entries(exprs)) m[id] = { ...(m[id] || {}), expr: ex };
    if (clothing) {
      _clothingLabels = Object.values(clothing.labels || {}).flat();
      for (const [id, entry] of Object.entries(clothing.items || {})) {
        m[id] = { ...(m[id] || {}), clothing: entry.tags || [] };
      }
    }
    _cache.set(slug, m); _pending.delete(slug); return m;
  });
  _pending.set(slug, p);
  return p;
}

/** 已載入的服裝詞表（後端 SSOT，動態選單用）；尚未載入 → null（呼叫端 fallback CLOTHING_OPTS） */
export function clothingLabelsSync() { return _clothingLabels; }

/** 標籤索引重建後（kind=tags 完成）呼叫使快取失效 */
export function bustAiTags(slug) { _cache.delete(slug); _pending.delete(slug); }
