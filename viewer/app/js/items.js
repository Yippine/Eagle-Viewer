/* ── items.js ▸ 統一 item 視圖模型 adapter + 純函式引擎（無 DOM、無 import）─
   Eagle（urls_data.json）與 Excire（/api/excire/{lib}/photos）兩資料源
   統一為單一 vm 形；查詢語法 parse/match 沿用舊版 search.js（6 欄位 + 中文
   別名），seeded shuffle 沿用舊版 shuffle.js 演算法（seed 可重播）。
   本檔為純函式模組——node 可直接 import 做煙霧測試。 */

/* ── HTML escape（共用工具）─────────────────────────────────────────── */

export const h = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── 統一視圖模型 ───────────────────────────────────────────────────── */

/** raw item 的 mediaType：'bookmark' | 'video' | 'gif' | 'image' | 'other' */
export function mediaTypeOf(raw) {
  if (!raw.file) return 'bookmark';                      // 無本地檔 = 書籤
  const mt  = (raw.media_type || '').toLowerCase();
  const ext = (raw.ext || String(raw.file).split('.').pop() || '').toLowerCase();
  if (mt === 'video') return 'video';
  if (mt === 'gif' || ext === 'gif') return 'gif';
  if (mt === 'image') return 'image';
  return 'other';
}

/** Eagle id（base36 時間戳前綴）→ 加入時間 ms；無效 → null */
export function btimeFromId(id) {
  const n = parseInt(String(id || '').slice(0, 8), 36);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** raw（eagle/dir/excire）→ 統一 vm。source ∈ 'eagle' | 'dir' | 'excire' */
export function adaptItem(raw, source = 'eagle') {
  const isExcire = source === 'excire' || raw.source === 'excire';
  const src = isExcire ? 'excire' : source;
  return {
    id:       String(raw.id),
    name:     raw.name || String(raw.id),
    url:      raw.url || '',
    domain:   raw.domain || '',
    kind:     raw.kind || '',
    tags:     raw.tags || [],
    folders:  raw.folders || [],
    star:     raw.star || 0,
    size:     raw.size ?? null,
    width:    raw.width ?? null,
    height:   raw.height ?? null,
    duration: raw.duration ?? null,
    mtime:    raw.mtime ?? null,
    btime:    isExcire ? (raw.mtime ?? null) : btimeFromId(raw.id),
    ext:      (raw.ext || '').toLowerCase(),
    mediaType: mediaTypeOf(raw),
    thumb:    raw.thumb || '',
    file:     raw.file || '',
    preview:  raw.preview || raw.file || '',
    aesthetics: raw.aesthetics ?? null,
    annotation: raw.annotation || '',
    photoId:  raw.photo_id ?? null,
    readOnly: isExcire,
    source:   src,
  };
}

/* ── 查詢語法（6 欄位 + 中文別名；沿用舊版 search.js）────────────────── */

const FIELD_ALIAS = {
  '名稱': 'name', '標籤': 'tag', '網域': 'domain',
  '網址': 'url', '類型': 'kind', '編號': 'id',
};
export const QUERY_FIELDS = ['name', 'tag', 'domain', 'url', 'kind', 'id'];

/** 搜尋字串 → terms：[{ field, value, exclude }]；field '*' = 全欄位 */
export function parseQuery(raw) {
  const terms = [];
  const re = /(-?)(?:"([^"]*)"|([\S]+))/g;
  let m;
  while ((m = re.exec(String(raw || ''))) !== null) {
    const ex = m[1] === '-';
    const rv = (m[2] !== undefined ? m[2] : m[3] || '').trim();
    if (!rv) continue;
    const v = rv.toLowerCase();
    const c = v.indexOf(':');
    if (c > 0) {
      let f = v.slice(0, c);
      const vv = v.slice(c + 1);
      f = FIELD_ALIAS[f] || f;
      if (vv && QUERY_FIELDS.includes(f)) { terms.push({ field: f, value: vv, exclude: ex }); continue; }
    }
    terms.push({ field: '*', value: v, exclude: ex });
  }
  return terms;
}

/** terms → 查詢字串（⌘K chips 序列化）。含空白時引號包住整個 term
 *  （`"tag:制服 外套"`）——parseQuery 對引號內容同樣做欄位切分，可round-trip。 */
export function serializeTerms(terms) {
  return terms.map(t => {
    const body = t.field === '*' ? t.value : `${t.field}:${t.value}`;
    return `${t.exclude ? '-' : ''}${/\s/.test(body) ? `"${body}"` : body}`;
  }).join(' ');
}

/** 單 item 是否符合 terms（AND；exclude 命中即淘汰） */
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

/* ── 篩選（型別/星等/標籤/日期/尺寸 + 網域/資料夾/q）────────────────── */

const DATE_DAYS = { today: 1, '7d': 7, '30d': 30, '365d': 365 };
const MP = 1e6;   // megapixel
const SIZE_MP = { s: [0, MP], m: [MP, 4 * MP], l: [4 * MP, 12 * MP], xl: [12 * MP, Infinity] };

/** 人數 bucket 判定（B5；純函式——ai-tags.js 亦取用）：'1'|'2'|'3-5'|'6+' */
export function peopleMatch(bucket, n) {
  if (bucket === '1') return n === 1;
  if (bucket === '2') return n === 2;
  if (bucket === '3-5') return n >= 3 && n <= 5;
  if (bucket === '6+') return n >= 6;
  return true;
}

/** 尺寸分級：width×height 像素量 → '' | 's' | 'm' | 'l' | 'xl' */
export function sizeBucket(w, hgt) {
  const px = (w || 0) * (hgt || 0);
  if (!px) return '';
  for (const [k, [lo, hi]] of Object.entries(SIZE_MP)) if (px >= lo && px < hi) return k;
  return 'xl';
}

/**
 * 依 filters 過濾 items（純函式）。
 * @param {object} f defaultFilters() 形
 * @param {object} opts { folderSets?: Set<string>[]（每選中資料夾一個含後代集合，AND）,
 *                        trash?: boolean, now?: number,
 *                        aiTags?: {id: {people, scene, sport, expr}}|null（B5/B6；
 *                        null/未給 = 尚未載入 → 人數/場景/運動/表情維度不過濾） }
 */
export function filterItems(items, f, opts = {}) {
  const terms = parseQuery(f.q || '');
  const now = opts.now ?? Date.now();
  const folderSets = opts.folderSets || [];
  const domains = f.domains?.length ? new Set(f.domains) : null;
  const dateMin = f.date && DATE_DAYS[f.date] ? now - DATE_DAYS[f.date] * 86400000 : null;
  const aiTags = opts.aiTags || null;

  return items.filter(i => {
    const archived = (i.tags || []).includes('archived');
    if (opts.trash ? !archived : archived) return false;

    if (f.type && f.type !== 'all' && i.mediaType !== f.type) return false;
    if (f.star > 0 && (i.star || 0) < f.star) return false;
    if (f.tags?.length && !f.tags.every(t => (i.tags || []).includes(t))) return false;
    if (dateMin !== null && !(i.mtime >= dateMin)) return false;
    if (f.size && sizeBucket(i.width, i.height) !== f.size) return false;
    if (domains && !domains.has(i.domain)) return false;

    if (aiTags && (f.people || f.scene || f.sport || f.action || f.expr || f.clothing)) { // B5/B6 + 服裝
      const t = aiTags[i.id] || {};
      if (f.people && !peopleMatch(f.people, t.people || 0)) return false;
      if (f.scene && t.scene !== f.scene) return false;
      if (f.sport && t.sport !== f.sport) return false;
      if (f.action && t.action !== f.action) return false;
      if (f.expr && !(t.expr || []).includes(f.expr)) return false; // 任一臉命中即符合
      if (f.clothing && !(t.clothing || []).includes(f.clothing)) return false; // 一圖多件服裝
    }

    if (folderSets.length) {
      const own = i.folders || [];
      if (!folderSets.every(set => own.some(fid => set.has(fid)))) return false;
    }
    return matchItem(i, terms);
  });
}

/* ── 排序（8 鍵 + Excire 美學分數；shuffle 於外部走 seededShuffle）───── */

export const SORT_KEYS = [
  ['shuffle',    '隨機'],
  ['date',       '加入日期'],
  ['mtime',      '修改日期'],
  ['name',       '名稱'],
  ['star',       '評分'],
  ['size',       '大小'],
  ['ext',        '副檔名'],
  ['dim',        '尺寸'],
  ['duration',   '時長'],
  ['aesthetics', '美學分數'],    // Excire 庫追加（+1 鍵）
];

export function sortItems(arr, key, dir = 'desc') {
  const a = [...arr];
  const sign = dir === 'asc' ? 1 : -1;
  const num = get => (x, y) => sign * ((get(x) ?? 0) - (get(y) ?? 0));
  switch (key) {
    case 'date':     return a.sort(num(x => x.btime));
    case 'mtime':    return a.sort(num(x => x.mtime));
    case 'name':     return a.sort((x, y) => sign * x.name.localeCompare(y.name, 'zh-TW'));
    case 'star':     return a.sort(num(x => x.star));
    case 'size':     return a.sort(num(x => x.size));
    case 'dim':      return a.sort(num(x => (x.width || 0) * (x.height || 0)));
    case 'duration': return a.sort(num(x => x.duration));
    case 'aesthetics': return a.sort(num(x => x.aesthetics ?? -1));
    case 'ext':      return a.sort((x, y) => {
      const cmp = (x.ext || '').localeCompare(y.ext || '', 'zh-TW');
      return cmp !== 0 ? sign * cmp : sign * x.name.localeCompare(y.name, 'zh-TW');
    });
    default:         return a;
  }
}

/* ── Seeded shuffle（沿用舊版 shuffle.js 演算法；同 seed 可重播）─────── */

export function seededShuffle(arr, seed) {
  let s = seed >>> 0;
  function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ── 顯示格式 ───────────────────────────────────────────────────────── */

export function fmtDuration(sec) {
  if (!sec) return '';
  const s = Math.round(sec);
  const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh > 0 ? `${hh}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
                : `${m}:${String(ss).padStart(2, '0')}`;
}

export function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024)       return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

export function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 排序態卡片 sort-meta 文字（C16 精簡版） */
export function sortMetaText(i, key) {
  switch (key) {
    case 'star':       return i.star ? '★'.repeat(Math.min(i.star, 5)) : '';
    case 'size':       return fmtSize(i.size);
    case 'mtime':      return fmtDate(i.mtime);
    case 'date':       return fmtDate(i.btime);
    case 'ext':        return (i.ext || '').toUpperCase();
    case 'dim':        return i.width && i.height ? `${i.width}×${i.height}` : '';
    case 'duration':   return fmtDuration(i.duration);
    case 'aesthetics': return i.aesthetics != null ? `美學 ${i.aesthetics.toFixed(2)}` : '';
    default:           return '';
  }
}
