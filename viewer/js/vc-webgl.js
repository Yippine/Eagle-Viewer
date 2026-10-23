'use strict';
/* ── vc-webgl.js  ▸  WebGL1 Selective Color pipeline ─────────────────
   GL context／shader／texture 上傳／RAF loop／GL canvas 對位
   （自 video-controls.js 拆分；行為不變）
══════════════════════════════════════════════════════════════════════*/

import { _VCS, _getAbSeeking }   from './vc-state.js';
import { _scheduleCanvasUpdate } from './vc-canvas.js';

/* ── WebGL1 Selective Color Backend ──────────────────────────── */
let _gl         = null;
let _glCanvas   = null;
let _glProgram  = null;
let _glTexture  = null;
let _glTexSrc   = null;
let _glLocs     = null;
let _glPosBuf   = null;
let _videoRafId = null;
let _glReadyFrame = false;   // 當前媒體已成功上傳一幀真實內容（首幀閘門）
const _GL_QUAD  = new Float32Array([0,0, 0,1, 1,0, 1,1]);

const _GL_VERT = `
  attribute vec2 aPosition;
  varying vec2 vTexCoord;
  void main() {
    vTexCoord   = aPosition;
    gl_Position = vec4(aPosition * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const _GL_FRAG = `
  precision highp float;
  uniform sampler2D uTexture;
  varying vec2 vTexCoord;
  uniform int   uSelCount;
  uniform float uTargetHue[8];
  uniform float uRange[8];
  uniform float uDeltaH[8];
  uniform float uDeltaS[8];
  uniform float uDeltaL[8];
  uniform float uContrast[8];
  uniform float uSepia[8];

  vec3 hue2rgb(float p, float q, float t) {
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 1.0/6.0) return vec3(p + (q - p) * 6.0 * t);
    if (t < 1.0/2.0) return vec3(q);
    if (t < 2.0/3.0) return vec3(p + (q - p) * (2.0/3.0 - t) * 6.0);
    return vec3(p);
  }

  vec3 RGBtoHSL(vec3 c) {
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float l    = (maxC + minC) * 0.5;
    float d    = maxC - minC;
    if (d < 0.00001) return vec3(0.0, 0.0, l);
    float s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
    float h;
    if (maxC == c.r)      h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
    else                  h = (c.r - c.g) / d + 4.0;
    return vec3(h / 6.0, s, l);
  }

  vec3 HSLtoRGB(vec3 hsl) {
    if (hsl.y < 0.00001) return vec3(hsl.z);
    float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
    float p = 2.0 * hsl.z - q;
    return vec3(
      hue2rgb(p, q, hsl.x + 1.0/3.0).r,
      hue2rgb(p, q, hsl.x).r,
      hue2rgb(p, q, hsl.x - 1.0/3.0).r
    );
  }

  float hueDist(float h1, float h2) {
    float d = abs(h1 - h2);
    return min(d, 1.0 - d);
  }

  vec3 applySepia(vec3 c) {
    return vec3(
      dot(c, vec3(0.393, 0.769, 0.189)),
      dot(c, vec3(0.349, 0.686, 0.168)),
      dot(c, vec3(0.272, 0.534, 0.131))
    );
  }

  void main() {
    vec2 uv    = vec2(vTexCoord.x, 1.0 - vTexCoord.y);
    vec4 texel = texture2D(uTexture, uv);
    vec3 rgb   = texel.rgb;

    for (int i = 0; i < 8; i++) {
      if (i >= uSelCount) break;
      vec3  hsl  = RGBtoHSL(rgb);
      float dist = hueDist(hsl.x, uTargetHue[i]);
      float mask = 1.0 - smoothstep(uRange[i] * 0.8, uRange[i], dist);
      if (mask > 0.001) {
        vec3 adj = vec3(fract(hsl.x + uDeltaH[i]),
                       clamp(hsl.y + uDeltaS[i], 0.0, 1.0),
                       clamp(hsl.z + uDeltaL[i], 0.0, 1.0));
        vec3 newRgb = HSLtoRGB(adj);
        newRgb = clamp(0.5 + (1.0 + uContrast[i]) * (newRgb - 0.5), 0.0, 1.0);
        newRgb = mix(newRgb, applySepia(newRgb), uSepia[i]);
        rgb = mix(rgb, newRgb, mask);
      }
    }
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

export function _glInit(img) {
  // Re-parent canvas if the target img has changed (singleton GL context, movable canvas)
  if (_gl) {
    if (_glCanvas && img && img.parentElement && _glCanvas.parentElement !== img.parentElement) {
      // 不修改 parent 的 position：讓 GL canvas 自然冒泡至最近 positioned ancestor
      img.parentElement.appendChild(_glCanvas);
    }
    return true;
  }
  _glCanvas = document.createElement('canvas');
  _glCanvas.id = 'vc-gl';
  _glCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;touch-action:none;display:none';
  if (img && img.parentElement) {
    img.parentElement.appendChild(_glCanvas);
  }
  // alpha:true：未繪製區域保持透明，露出底下的 video/img，避免不透明黑遮蔽
  // （shader 輸出 alpha=1.0，premultipliedAlpha:false 下已繪製區域仍為不透明）
  _gl = _glCanvas.getContext('webgl', {
    alpha: true, premultipliedAlpha: false,
    depth: false, stencil: false, antialias: false
  });
  if (!_gl) return false;
  const gl = _gl;
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, _GL_VERT); gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, _GL_FRAG); gl.compileShader(fs);
  _glProgram = gl.createProgram();
  gl.attachShader(_glProgram, vs); gl.attachShader(_glProgram, fs); gl.linkProgram(_glProgram);
  if (!gl.getProgramParameter(_glProgram, gl.LINK_STATUS)) {
    console.error('[GL] link error:', gl.getProgramInfoLog(_glProgram));
    console.error('[GL] vert log:', gl.getShaderInfoLog(vs));
    console.error('[GL] frag log:', gl.getShaderInfoLog(fs));
    _gl = null; _glCanvas = null; _glProgram = null; return false;
  }
  _glTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, _glTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  _glPosBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, _glPosBuf);
  gl.bufferData(gl.ARRAY_BUFFER, _GL_QUAD, gl.STATIC_DRAW);
  const p = _glProgram;
  _glLocs = {
    uTexture:  gl.getUniformLocation(p, 'uTexture'),
    uSelCount: gl.getUniformLocation(p, 'uSelCount'),
    uTargetHue:gl.getUniformLocation(p, 'uTargetHue'),
    uRange:    gl.getUniformLocation(p, 'uRange'),
    uDeltaH:   gl.getUniformLocation(p, 'uDeltaH'),
    uDeltaS:   gl.getUniformLocation(p, 'uDeltaS'),
    uDeltaL:   gl.getUniformLocation(p, 'uDeltaL'),
    uContrast: gl.getUniformLocation(p, 'uContrast'),
    uSepia:    gl.getUniformLocation(p, 'uSepia'),
  };
  return true;
}

export function _glUploadTexture(img) {
  const src = _VCS._imgOriginalSrc || img.src;
  if (_glTexSrc === src) { _glReadyFrame = true; return; }
  const gl = _gl;
  _glCanvas.width  = img.naturalWidth  || img.width;
  _glCanvas.height = img.naturalHeight || img.height;
  gl.viewport(0, 0, _glCanvas.width, _glCanvas.height);
  gl.bindTexture(gl.TEXTURE_2D, _glTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  _glTexSrc = src;
  _glReadyFrame = true;   // 圖片已完整載入，上傳即為真實內容
}

export function _glUploadVideoFrame(vid) {
  const gl = _gl;
  const w = vid.videoWidth, h = vid.videoHeight;
  if (!w || !h) return;
  gl.bindTexture(gl.TEXTURE_2D, _glTexture);
  if (_glCanvas.width !== w || _glCanvas.height !== h) {
    _glCanvas.width = w; _glCanvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vid);
  } else {
    // 使用 texSubImage2D 前確保影片 readyState >= 2（有可用幀）
    if (vid.readyState < 2) return;
    try {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, vid);
    } catch (e) {
      // 影片解碼尺寸不符（尺寸剛改變但 readyState 未更新）→ 回退 texImage2D
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vid);
    }
  }
}

export function _hasActiveSel() {
  return _VCS.selectiveList && _VCS.selectiveList.some(s => s.targetHue !== null);
}

export function _getTimedSelective() {
  const t = _VCS._vid?.currentTime ?? 0;
  return _VCS.selectiveList.filter(s =>
    s.targetHue !== null &&
    (s.abStart === null || (t >= s.abStart && t <= s.abEnd))
  );
}

export function _startVideoRafLoop() {
  if (_videoRafId) return;
  function loop() {
    if (!_VCS._vid || _VCS._mediaType !== 'video' || !_hasActiveSel()) {
      _videoRafId = null; return;
    }
    if (!_getAbSeeking()) {
      const _active = _getTimedSelective();
      if (_active.length && _VCS._vid.videoWidth && _VCS._vid.videoHeight &&
        _VCS._vid.readyState >= 2 && _glInit(_VCS._vid)) {
        _glUploadVideoFrame(_VCS._vid);
        _glRender(_active);
        _glEnsureAttached(_VCS._vid);
        _glShowCanvas(true);
      } else {
        _glShowCanvas(false);
      }
    }
    _videoRafId = requestAnimationFrame(loop);
  }
  _videoRafId = requestAnimationFrame(loop);
}

export function _stopVideoRafLoop() {
  if (_videoRafId) { cancelAnimationFrame(_videoRafId); _videoRafId = null; }
}

export function _glRender(selectiveList) {
  const gl = _gl, locs = _glLocs;
  const n = Math.min((selectiveList || []).length, 8);
  // 每次繪製前清為透明：resize 或上傳失敗時不殘留不透明黑
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(_glProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, _glPosBuf);
  const aPos = gl.getAttribLocation(_glProgram, 'aPosition');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, _glTexture);
  gl.uniform1i(locs.uTexture, 0);
  gl.uniform1i(locs.uSelCount, n);
  const pad = (arr, len) => arr.concat(new Array(len - arr.length).fill(0));
  const sl = (selectiveList || []).slice(0, n);
  gl.uniform1fv(locs.uTargetHue, new Float32Array(pad(sl.map(s => ((s.targetHue||0)/360)), 8)));
  gl.uniform1fv(locs.uRange,     new Float32Array(pad(sl.map(s => ((s.range||30)/360)), 8)));
  gl.uniform1fv(locs.uDeltaH,    new Float32Array(pad(sl.map(s => (s.hueShift||0)/360), 8)));
  // slider 值域 [-1,1]，直接傳入；shader 以 hsl.y + uDeltaS / hsl.z + uDeltaL 做加法 delta
  gl.uniform1fv(locs.uDeltaS,    new Float32Array(pad(sl.map(s => (s.saturate||0)), 8)));
  gl.uniform1fv(locs.uDeltaL,    new Float32Array(pad(sl.map(s => (s.brightness||0)), 8)));
  gl.uniform1fv(locs.uContrast,  new Float32Array(pad(sl.map(s => (s.contrast||0)), 8)));
  gl.uniform1fv(locs.uSepia,     new Float32Array(pad(sl.map(s => (s.sepia||0)), 8)));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function _glDestroy() {
  if (!_gl) return;
  _stopVideoRafLoop();
  _gl.deleteProgram(_glProgram);
  _gl.deleteTexture(_glTexture);
  _gl.deleteBuffer(_glPosBuf);
  if (_glCanvas && _glCanvas.parentElement) _glCanvas.parentElement.removeChild(_glCanvas);
  _gl = _glCanvas = _glProgram = _glTexture = _glPosBuf = _glLocs = _glTexSrc = null;
  _glReadyFrame = false;
}

export function _glShowCanvas(show) {
  // 首幀閘門：當前媒體的真實一幀尚未上傳前，overlay 一律不可見
  if (show && !_glReadyFrame) show = false;
  if (_glCanvas) _glCanvas.style.display = show ? '' : 'none';
}

/* 確保單例 GL canvas 掛在當前媒體的 zoomWrapper 下並同步尺寸位置
   （zoomWrapper 每次切換媒體會被 innerHTML='' 銷毀，canvas 需重掛） */
export function _glEnsureAttached(mediaEl) {
  if (!_glCanvas || !mediaEl || !mediaEl.parentElement) return;
  if (_glCanvas.parentElement !== mediaEl.parentElement) {
    mediaEl.parentElement.appendChild(_glCanvas);
  }
  vcSyncGlCanvas(mediaEl);
}

/* 首幀確認：rVFC 優先；無 rVFC 時以 canplay / 首個 timeupdate 近似 */
export function _glAwaitFirstFrame(vid) {
  const mark = () => {
    if (vid !== _VCS._vid) return;   // 已切換至其他媒體，忽略過期回呼
    _glReadyFrame = true;
    if (_hasActiveSel()) _scheduleCanvasUpdate();
  };
  if (typeof vid.requestVideoFrameCallback === 'function') {
    vid.requestVideoFrameCallback(() => mark());
  } else {
    const onReady = () => {
      vid.removeEventListener('canplay',    onReady);
      vid.removeEventListener('timeupdate', onReady);
      mark();
    };
    vid.addEventListener('canplay',    onReady);
    vid.addEventListener('timeupdate', onReady);
  }
}

/**
 * GL canvas 的 CSS 尺寸／位置對齊 img 的實際內容區域。
 *
 * 定位策略：用 parent.clientWidth/Height（pre-transform layout 尺寸）計算置中偏移，
 * 再把 img.style.transform 拷貝給 canvas，讓 translate/flip/rotate 只套用一次。
 * getBoundingClientRect 是 post-transform，若同時拷貝 transform 會雙重位移，故不用。
 *
 * 前提：_glInit 不再修改 parent 的 position，canvas(position:absolute) 的 containing block
 * 因此冒泡至 mp-video-wrap / dp-video-wrap（正確的 positioned ancestor）。
 * parent（mp-zoom-wrapper / dp-zoom-wrapper）的 clientWidth/Height 等於 video-wrap 尺寸，
 * 算出的 left/top 恰好是相對於 video-wrap 的正確偏移。
 */
export function vcSyncGlCanvas(img) {
  if (!_glCanvas || !img) return;
  const parent = img.parentElement;
  if (!parent) return;
  const pw = parent.clientWidth;
  const ph = parent.clientHeight;
  if (!pw || !ph) return;

  let w, h, left, top;
  if (img.tagName === 'VIDEO') {
    const vw = img.videoWidth || 0;
    const vh = img.videoHeight || 0;
    if (vw && vh) {
      const scl = Math.min(pw / vw, ph / vh);
      w = Math.round(vw * scl);
      h = Math.round(vh * scl);
    } else {
      w = img.clientWidth || pw; h = img.clientHeight || ph;
    }
  } else {
    w = img.clientWidth || pw; h = img.clientHeight || ph;
  }
  left = Math.round((pw - w) / 2);
  top  = Math.round((ph - h) / 2);

  _glCanvas.style.width  = w + 'px';
  _glCanvas.style.height = h + 'px';
  _glCanvas.style.left   = left + 'px';
  _glCanvas.style.top    = top  + 'px';
  _glCanvas.style.right  = '';
  _glCanvas.style.bottom = '';
  _glCanvas.style.transform       = img.style.transform;
  _glCanvas.style.transformOrigin = img.style.transformOrigin || 'center center';
}

/* ── 跨模組存取器（module-level let 無法跨模組 reassign，收攏於此）── */
export function _glResetTexSrc()    { _glTexSrc = null; }
export function _glSetReadyFrame(v) { _glReadyFrame = v; }
/** 清除 GL 紋理舊幀（上傳 1×1 透明像素） */
export function _glClearTexture() {
  if (_gl && _glTexture) {
    _gl.bindTexture(_gl.TEXTURE_2D, _glTexture);
    _gl.texImage2D(_gl.TEXTURE_2D, 0, _gl.RGBA, 1, 1, 0, _gl.RGBA, _gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));
  }
}
