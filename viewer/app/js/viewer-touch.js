/* ── viewer-touch.js ▸ Immersive Viewer 行動輸入層（B6，C33）────────────
   TikTok 手勢語彙（同一 viewer 的觸控輸入層，非另一套 DOM）：
   縱滑 = 切換上/下一個｜橫拖（影片）= 即時 seek（線性：全寬 ≈ min(時長,90s)，
   VLC／MX Player／YouTube 細拖語彙，中央顯示 ±秒數與目標時間）｜左緣右滑 = 返回｜
   捏合 = 以兩指中點為錨點縮放（圖片 1–8× / 影片 1–4×）+ 中點位移 = 雙指平移｜
   放大中單指拖曳 = 平移（停用切換/seek/邊緣返回）｜影片單擊 = 清屏、雙擊 = 播暫｜
   touchcancel 清理。控制列/頂列上的觸控不攔截（原生按鈕行為）。 */

/**
 * @param {HTMLElement} stage
 * @param {object} hooks { isOpen, kind, nav(dir), seekBy(s), requestClose,
 *                         togglePlay, toggleUi, getZoom() → number, zoomTo(s, ax?, ay?), panBy(dx, dy),
 *                         seekInfo() → {t, d} | null, seekTo(t), seekHint(text|null) }
 */
export function initViewerTouch(stage, hooks) {
  let t = null;        // 單指：{ x, y, edge, t0, moved, seek:{t0, d, span, target}|null, axis:'h'|'v'|null }
  /* 橫拖 seek 參數：死區 12px 後鎖定水平軸；位移線性映射，整個舞台寬 = span 秒，
     span = clamp(時長, 10s, 90s)：短片全寬即全片、長片全寬 90s（避免 28s 影片一滑到底、
     51s 影片一滑 30s）。拖曳中 rAF 節流即時 seek，放手定稿。 */
  const SEEK_DEAD = 12, SEEK_SPAN_MIN = 10, SEEK_SPAN_MAX = 90;
  let seekRaf = 0;
  let pinch = null;    // 雙指：{ d0, s0, mx, my }（mx/my = 上一幀中點，供雙指平移）
  let lastTap = 0, tapTimer = 0;

  const _dist = e =>
    Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
               e.touches[0].clientY - e.touches[1].clientY);
  const _mid = e => ({ x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                       y: (e.touches[0].clientY + e.touches[1].clientY) / 2 });
  const _zoomed = () => hooks.getZoom() > 1.005;

  stage.addEventListener('touchstart', e => {
    if (!hooks.isOpen()) return;
    if (e.target.closest('.uv-nav, #uv-controls, .uv-topbar, .uv-kbd')) { t = null; return; }
    if (e.touches.length === 2) {
      const m = _mid(e);
      pinch = { d0: _dist(e) || 1, s0: hooks.getZoom(), mx: m.x, my: m.y };
      t = null;
      return;
    }
    const x = e.touches[0].clientX;
    /* 已放大 → 單指拖曳 = 平移畫面（不切換/不 seek/不邊緣返回） */
    t = { x, y: e.touches[0].clientY, edge: x < 28 && !_zoomed(), t0: Date.now(), moved: false,
          seek: null, axis: null, pan: _zoomed(), lx: x, ly: e.touches[0].clientY };
  }, { passive: true });

  stage.addEventListener('touchmove', e => {
    if (pinch && e.touches.length === 2) {
      /* 捏合：以兩指中點為錨點縮放（Google Photos／iOS Photos 語彙），中點位移 = 雙指平移 */
      const m = _mid(e);
      hooks.zoomTo(pinch.s0 * (_dist(e) / pinch.d0), m.x, m.y);
      if (_zoomed()) hooks.panBy?.(m.x - pinch.mx, m.y - pinch.my);
      pinch.mx = m.x; pinch.my = m.y;
      e.preventDefault();                       // 攔下頁面縮放
      return;
    }
    if (t) {
      const dx = e.touches[0].clientX - t.x, dy = e.touches[0].clientY - t.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) t.moved = true;
      if (t.pan) {                              // 放大中：單指平移
        e.preventDefault();
        hooks.panBy?.(e.touches[0].clientX - t.lx, e.touches[0].clientY - t.ly);
        t.lx = e.touches[0].clientX; t.ly = e.touches[0].clientY;
        return;
      }
      // 軸向鎖定（一次決定，不在過程中改判）
      if (!t.axis && (Math.abs(dx) > SEEK_DEAD || Math.abs(dy) > SEEK_DEAD))
        t.axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (t.axis === 'h' && !t.edge && hooks.kind() === 'video' && hooks.seekInfo) {
        if (!t.seek) {
          const info = hooks.seekInfo();
          if (info && info.d > 0) {
            const span = Math.min(SEEK_SPAN_MAX, Math.max(SEEK_SPAN_MIN, info.d));
            t.seek = { t0: info.t, d: info.d, span, target: info.t };
          }
        }
        if (t.seek) {
          e.preventDefault();                     // 鎖住水平手勢（避免頁面/瀏覽器手勢）
          const W = stage.clientWidth || window.innerWidth || 1;
          const delta = (dx / W) * t.seek.span;
          t.seek.target = Math.max(0, Math.min(t.seek.d, t.seek.t0 + delta));
          const sgn = delta >= 0 ? '+' : '−';
          hooks.seekHint?.(`${sgn}${Math.round(Math.abs(delta))}s · ${_fmtT(t.seek.target)} / ${_fmtT(t.seek.d)}`);
          if (!seekRaf) seekRaf = requestAnimationFrame(() => {
            seekRaf = 0; if (t?.seek) hooks.seekTo?.(t.seek.target);
          });
        }
      }
    }
  }, { passive: false });

  stage.addEventListener('touchend', e => {
    if (pinch) { if (e.touches.length < 2) pinch = null; return; }
    if (!t) return;
    if (t.pan && t.moved) { t = null; return; }               // 平移結束：不觸發切換（未移動仍視為 tap）
    const dx = e.changedTouches[0].clientX - t.x;
    const dy = e.changedTouches[0].clientY - t.y;
    const st = t;
    t = null;

    if (st.seek) {                                            // 橫拖 seek 定稿
      e.preventDefault();
      if (seekRaf) { cancelAnimationFrame(seekRaf); seekRaf = 0; }
      hooks.seekTo?.(st.seek.target);
      hooks.seekHint?.(null);
      return;
    }
    if (st.edge && dx > 60 && Math.abs(dy) < 60) {          // 左緣右滑 = 返回
      e.preventDefault(); hooks.requestClose(); return;
    }
    if (st.axis === 'v' && Math.abs(dy) > 70) {              // 縱滑 = 切換
      e.preventDefault(); hooks.nav(dy < 0 ? 1 : -1); return;
    }
    /* tap：影片 = 單擊清屏 / 雙擊播暫（攔下合成 click 的桌面語彙）；
       圖片 = 不攔（沿用 click：點空白關閉、雙擊重置縮放） */
    if (!st.moved && Date.now() - st.t0 < 400 && hooks.kind() === 'video') {
      e.preventDefault();
      const now = Date.now();
      clearTimeout(tapTimer);
      if (now - lastTap < 300) { lastTap = 0; hooks.togglePlay(); }
      else {
        lastTap = now;
        tapTimer = setTimeout(() => { lastTap = 0; hooks.toggleUi(); }, 300);
      }
    }
  }, { passive: false });

  stage.addEventListener('touchcancel', () => {
    if (t?.seek) hooks.seekHint?.(null);
    t = null; pinch = null;
  }, { passive: true });
}

const _fmtT = s => {
  if (!isFinite(s)) return '–:––';
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60), ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}`;
};
