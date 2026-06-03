'use strict';
/* ── shuffle.js  ▸  Seed-based 洗牌系統 ────────────────────────────────── */

const _TODAY    = new Date().toISOString().slice(0, 10);
const _SEED_KEY = `eagle-seeds-${_TODAY}`;

function _loadSeeds() {
  try { return JSON.parse(localStorage.getItem(_SEED_KEY) || '[]'); } catch { return []; }
}
function _saveSeeds(arr) {
  localStorage.setItem(_SEED_KEY, JSON.stringify(arr));
  for (const k of Object.keys(localStorage))
    if (k.startsWith('eagle-seeds-') && k !== _SEED_KEY) localStorage.removeItem(k);
}

export let seeds    = _loadSeeds();
export let seedIdx  = seeds.length - 1;

// t045：FIFO 上限，預設 7（Miller's Law 7±2），可由偏好設定覆蓋
export const DEFAULT_MAX_SEEDS = 7;
export function getMaxSeeds() {
  return parseInt(localStorage.getItem('eagle-pref-max-seeds') || DEFAULT_MAX_SEEDS, 10);
}

export function newSeed() {
  const maxSeeds = getMaxSeeds();
  const seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  if (seeds.length >= maxSeeds) seeds.shift(); // FIFO：移除最舊
  seeds.push(seed);
  seedIdx = seeds.length - 1;
  _saveSeeds(seeds);
  return seed;
}

export function currentSeed() {
  return seeds.length === 0 ? newSeed() : seeds[seedIdx];
}

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

/** 由外部修改 seedIdx（避免 ES module export binding 唯讀限制） */
export function setSeedIdx(n) { seedIdx = n; }

export function updateSeedNav() {
  const prev = document.getElementById('btn-seed-prev');
  const next = document.getElementById('btn-seed-next');
  const lbl  = document.getElementById('seed-idx-lbl');
  if (!prev) return;
  prev.disabled = (seedIdx <= 0);
  next.disabled = (seedIdx >= seeds.length - 1);
  lbl.textContent = seeds.length > 1 ? `${seedIdx + 1}/${seeds.length}` : '';
  prev.style.opacity = prev.disabled ? '0.35' : '1';
  next.style.opacity = next.disabled ? '0.35' : '1';
}
