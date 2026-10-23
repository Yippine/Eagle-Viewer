/* ── viewer-touch.js ▸ Immersive Viewer 行動輸入層（B6，C33）────────────
   TikTok 手勢語彙（同一 viewer 的觸控輸入層，非另一套 DOM）：
   縱滑 = 切換上/下一個｜橫拖（影片）= ±30s seek｜左緣右滑 = 返回｜
   捏合 = 縮放（圖片 1–8× / 影片 1–4×）｜影片單擊 = 清屏、雙擊 = 播暫｜
   touchcancel 清理。控制列/頂列上的觸控不攔截（原生按鈕行為）。 */

/**
 * @param {HTMLElement} stage
 * @param {object} hooks { isOpen, kind, nav(dir), seekBy(s), requestClose,
 *                         togglePlay, toggleUi, getZoom() → number, zoomTo(s) }
 */
export function initViewerTouch(stage, hooks) {
  let t = null;        // 單指：{ x, y, edge, t0, moved }
  let pinch = null;    // 雙指：{ d0, s0 }
  let lastTap = 0, tapTimer = 0;

  const _dist = e =>
    Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
               e.touches[0].clientY - e.touches[1].clientY);

  stage.addEventListener('touchstart', e => {
    if (!hooks.isOpen()) return;
    if (e.target.closest('.uv-nav, #uv-controls, .uv-topbar, .uv-kbd')) { t = null; return; }
    if (e.touches.length === 2) {
      pinch = { d0: _dist(e) || 1, s0: hooks.getZoom() };
      t = null;
      return;
    }
    const x = e.touches[0].clientX;
    t = { x, y: e.touches[0].clientY, edge: x < 28, t0: Date.now(), moved: false };
  }, { passive: true });

  stage.addEventListener('touchmove', e => {
    if (pinch && e.touches.length === 2) {
      hooks.zoomTo(pinch.s0 * (_dist(e) / pinch.d0));
      e.preventDefault();                       // 攔下頁面縮放
      return;
    }
    if (t) {
      const dx = e.touches[0].clientX - t.x, dy = e.touches[0].clientY - t.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) t.moved = true;
    }
  }, { passive: false });

  stage.addEventListener('touchend', e => {
    if (pinch) { if (e.touches.length < 2) pinch = null; return; }
    if (!t) return;
    const dx = e.changedTouches[0].clientX - t.x;
    const dy = e.changedTouches[0].clientY - t.y;
    const st = t;
    t = null;

    if (st.edge && dx > 60 && Math.abs(dy) < 60) {          // 左緣右滑 = 返回
      e.preventDefault(); hooks.requestClose(); return;
    }
    if (Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx) * 1.5) {   // 縱滑 = 切換
      e.preventDefault(); hooks.nav(dy < 0 ? 1 : -1); return;
    }
    if (hooks.kind() === 'video' && Math.abs(dx) > 70) {    // 橫拖 = ±30s seek
      e.preventDefault(); hooks.seekBy(dx > 0 ? 30 : -30); return;
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

  stage.addEventListener('touchcancel', () => { t = null; pinch = null; }, { passive: true });
}
