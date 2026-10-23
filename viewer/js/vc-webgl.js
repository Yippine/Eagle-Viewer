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
let _glTexW = 0, _glTexH = 0; // GL 紋理實際尺寸（與 canvas 尺寸獨立追蹤；
                              // _glClearTexture 會把紋理縮為 1×1 但 canvas 尺寸不變，
                              // 若僅比對 canvas 尺寸，下一支同尺寸影片會誤走 texSubImage2D
                              // → GL INVALID_VALUE 靜默失敗 → 紋理全黑 → 畫面黑掉）
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
  uniform float uMode[8];        // 0 = 色相選取；1 = 明度選取（黑白灰系，Resolve Luminance Qualifier 語彙）
  uniform float uTargetLum[8];
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
      float mask;
      if (uMode[i] > 0.5) {
        // 明度模式：|L − 目標| 在寬度內，且僅低飽和（中性）像素；uRange 以 0–1 明度差量傳入
        float dl = abs(hsl.z - uTargetLum[i]);
        mask = (1.0 - smoothstep(uRange[i] * 0.8, uRange[i], dl)) * (1.0 - smoothstep(0.15, 0.30, hsl.y));
      } else {
        float dist = hueDist(hsl.x, uTargetHue[i]);
        mask = 1.0 - smoothstep(uRange[i] * 0.8, uRange[i], dist);
      }
      if (mask > 0.001) {
        // 明度模式下 hue 無定義 → 「色調」滑桿直接指定上色色相（飽和 > 0 時才可見）
        vec3 adj = vec3(uMode[i] > 0.5 ? uDeltaH[i] : fract(hsl.x + uDeltaH[i]),
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

/* ── Engine 2：OKLCH 選色管線 ───────────────────────────────────────
   規格：.ai-core/tasks/eagle-viewer-filter-engine2/references/engine2-spec.md §3
   本區塊完全獨立於上方 v1 FRAG／_glRender，僅在 _glRender 開頭分流呼叫。────*/

const _E2_SEL_DEFAULT = {
  mode: 'offset',
  qual: { hW: 30, hSoft: 6, sC: 50, sW: 50, sSoft: 10, lC: 50, lW: 50, lSoft: 10 },
  target: { hex: '#2E8B57', strength: 100, keepL: 100 },
  dH: 0, dC: 0, dL: 0,
  contrast: 0,
  vibrance: 0,
  sepia: 0,
};

/** sRGB (0..255) → OKLCH {L 0..1, C 0..0.4, h 0..1 圈} — 純 JS，供上傳 uniform 前的 target/pickedRgb 換算 */
function _oklchFromSrgb01(r, g, b) {
  const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lr = toLin(r), lg = toLin(g), lb = toLin(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  const C = Math.sqrt(a * a + bb * bb);
  let h = Math.atan2(bb, a) / (2 * Math.PI);
  if (h < 0) h += 1;
  return { L, C, h };
}

/** 選色 item 的 OKLCH 色相中心（0..1 圈） */
function _oklchHueOfItem(s) {
  if (s.pickedRgb) return _oklchFromSrgb01(s.pickedRgb[0] / 255, s.pickedRgb[1] / 255, s.pickedRgb[2] / 255).h;
  const hh = ((s.targetHue || 0) % 360) / 360, sat = 0.75, l = 0.5;
  const f = n => { const k = (n + hh * 12) % 12; const a = sat * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return _oklchFromSrgb01(f(0), f(8), f(4)).h;
}
/** #RRGGBB → OKLCH {L,C,h}（h 0..1 圈） */
function _oklchFromHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return { L: 0.5, C: 0, h: 0 };
  const n = parseInt(m[1], 16);
  return _oklchFromSrgb01(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** sRGB 0..255 三通道 → OKLCH.L（0..1），供 pickedRgb → uCenterL 換算 */
function _oklchLFromRgb255(r, g, b) {
  return _oklchFromSrgb01((r || 0) / 255, (g || 0) / 255, (b || 0) / 255).L;
}

const _GL_FRAG2 = `
  precision highp float;
  uniform sampler2D uTexture;
  varying vec2 vTexCoord;
  uniform int   uSelCount;
  uniform float uMode[8];
  uniform float uHueC[8], uHueW[8], uHueSoft[8];
  uniform float uSC[8], uSW[8], uSSoft[8], uLC[8], uLW[8], uLSoft[8];
  uniform float uDH[8], uDC[8], uDL[8];
  uniform vec3  uTgt[8];
  uniform float uStrength[8], uKeepL[8];
  uniform float uCtr[8], uVib[8], uSepia[8];
  uniform float uCenterL[8];

  float srgbToLinear1(float c) {
    return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
  }
  float linearToSrgb1(float c) {
    return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(clamp(c, 0.0, 1.0), 1.0 / 2.4) - 0.055;
  }
  float cbrtSigned(float x) {
    return sign(x) * pow(abs(x), 1.0 / 3.0);
  }

  vec3 rgbToOklch(vec3 rgb) {
    float lr = srgbToLinear1(rgb.r);
    float lg = srgbToLinear1(rgb.g);
    float lb = srgbToLinear1(rgb.b);
    float l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
    float m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
    float s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
    float l_ = cbrtSigned(l), m_ = cbrtSigned(m), s_ = cbrtSigned(s);
    float L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    float a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    float b = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
    float C = length(vec2(a, b));
    float h = atan(b, a) / 6.28318530718;
    if (h < 0.0) h += 1.0;
    return vec3(L, C, h);
  }

  vec3 oklchToRgb(vec3 lch) {
    float L = lch.x, C = lch.y, h = lch.z * 6.28318530718;
    float a = cos(h) * C;
    float b = sin(h) * C;
    float l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    float m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    float s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    float l = l_ * l_ * l_;
    float m = m_ * m_ * m_;
    float s = s_ * s_ * s_;
    float lr =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    float lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    float lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    return vec3(linearToSrgb1(lr), linearToSrgb1(lg), linearToSrgb1(lb));
  }

  float hueDist2(float h1, float h2) {
    float d = abs(h1 - h2);
    return min(d, 1.0 - d);
  }

  // 最短弧色相插值（h1 → h2，t 為插值係數）
  float hueMix(float h1, float h2, float t) {
    float d = h2 - h1;
    d = d - floor(d + 0.5); // wrap 到 [-0.5, 0.5)
    return fract(h1 + d * t + 1.0);
  }

  float q(float x, float c, float w, float soft) {
    float s = max(soft, 1e-4);
    return 1.0 - smoothstep(w, w + s, abs(x - c));
  }

  vec3 applySepia2(vec3 c) {
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
      vec3 lch = rgbToOklch(rgb);
      float L = lch.x, C = lch.y, h = lch.z;

      float hd = hueDist2(h, uHueC[i]);
      float qH = q(hd, 0.0, uHueW[i], max(uHueSoft[i], 1e-4));
      // 近中性像素（C 極低）色相無意義 → 彩度閘，避免灰階被色相雜訊掃進遮罩；全色相（寬度≥半圈 = 明度選取）不閘
      if (uHueW[i] < 0.49) qH *= smoothstep(0.008, 0.03, C);
      float qS = q(clamp(C / 0.4, 0.0, 1.0), uSC[i], uSW[i], uSSoft[i]);
      float qL = q(L, uLC[i], uLW[i], uLSoft[i]);
      float mask = qH * qS * qL;

      if (mask > 0.001) {
        vec3 outLch;
        if (uMode[i] > 0.5) {
          // set 模式
          float Lset = mix(uTgt[i].x, uTgt[i].x + (L - uCenterL[i]), uKeepL[i]);
          float hSet = hueMix(h, uTgt[i].z, 1.0);
          vec3 target = vec3(Lset, uTgt[i].y, hSet);
          outLch = mix(vec3(L, C, h), target, uStrength[i]);
          outLch.z = hueMix(h, uTgt[i].z, uStrength[i]);
        } else {
          // offset 模式
          float Cn = clamp(C / 0.4, 0.0, 1.0);
          float newC = max(0.0, C * (1.0 + uDC[i]) + uVib[i] * (1.0 - pow(Cn, max(abs(uVib[i]), 1e-3))) * 0.4);
          outLch = vec3(L + uDL[i], newC, fract(h + uDH[i]));
        }

        vec3 newRgb = oklchToRgb(outLch);
        float ctr = uCtr[i];
        newRgb = clamp(vec3(
          ctr > 0.0 ? (newRgb.r - 0.5) / (1.0 - 0.99 * ctr) + 0.5 : (newRgb.r - 0.5) * (1.0 + ctr) + 0.5,
          ctr > 0.0 ? (newRgb.g - 0.5) / (1.0 - 0.99 * ctr) + 0.5 : (newRgb.g - 0.5) * (1.0 + ctr) + 0.5,
          ctr > 0.0 ? (newRgb.b - 0.5) / (1.0 - 0.99 * ctr) + 0.5 : (newRgb.b - 0.5) * (1.0 + ctr) + 0.5
        ), 0.0, 1.0);
        newRgb = mix(newRgb, applySepia2(newRgb), uSepia[i]);
        rgb = mix(rgb, newRgb, mask);
      }
    }
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

let _glProgram2 = null;
let _glLocs2    = null;
let _gl2Failed  = false;

function _glInit2() {
  if (_glProgram2 || _gl2Failed) return !!_glProgram2;
  const gl = _gl;
  if (!gl) return false;
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, _GL_VERT); gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, _GL_FRAG2); gl.compileShader(fs);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[GL2] link error:', gl.getProgramInfoLog(prog));
    console.error('[GL2] vert log:', gl.getShaderInfoLog(vs));
    console.error('[GL2] frag log:', gl.getShaderInfoLog(fs));
    _gl2Failed = true;
    return false;
  }
  const p = prog;
  _glLocs2 = {
    uTexture:  gl.getUniformLocation(p, 'uTexture'),
    uSelCount: gl.getUniformLocation(p, 'uSelCount'),
    uMode:     gl.getUniformLocation(p, 'uMode'),
    uHueC:     gl.getUniformLocation(p, 'uHueC'),
    uHueW:     gl.getUniformLocation(p, 'uHueW'),
    uHueSoft:  gl.getUniformLocation(p, 'uHueSoft'),
    uSC:       gl.getUniformLocation(p, 'uSC'),
    uSW:       gl.getUniformLocation(p, 'uSW'),
    uSSoft:    gl.getUniformLocation(p, 'uSSoft'),
    uLC:       gl.getUniformLocation(p, 'uLC'),
    uLW:       gl.getUniformLocation(p, 'uLW'),
    uLSoft:    gl.getUniformLocation(p, 'uLSoft'),
    uDH:       gl.getUniformLocation(p, 'uDH'),
    uDC:       gl.getUniformLocation(p, 'uDC'),
    uDL:       gl.getUniformLocation(p, 'uDL'),
    uTgt:      gl.getUniformLocation(p, 'uTgt'),
    uStrength: gl.getUniformLocation(p, 'uStrength'),
    uKeepL:    gl.getUniformLocation(p, 'uKeepL'),
    uCtr:      gl.getUniformLocation(p, 'uCtr'),
    uVib:      gl.getUniformLocation(p, 'uVib'),
    uSepia:    gl.getUniformLocation(p, 'uSepia'),
    uCenterL:  gl.getUniformLocation(p, 'uCenterL'),
  };
  _glProgram2 = prog;
  return true;
}

/** engine 2 版 _glRender：從 item.e2（缺→_E2_SEL_DEFAULT）+ item.targetHue/pickedRgb 組 uniform 並繪製 */
function _glRender2(selectiveList) {
  if (!_glInit2()) {
    // 編譯失敗：_gl2Failed 已設為 true，_glRender 的分流條件會跳過本函式改走 v1 繪製，避免遞迴
    return _glRender(selectiveList);
  }
  const gl = _gl, locs = _glLocs2;
  const n = Math.min((selectiveList || []).length, 8);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(_glProgram2);
  gl.bindBuffer(gl.ARRAY_BUFFER, _glPosBuf);
  const aPos = gl.getAttribLocation(_glProgram2, 'aPosition');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, _glTexture);
  gl.uniform1i(locs.uTexture, 0);
  gl.uniform1i(locs.uSelCount, n);

  const pad = (arr, len) => arr.concat(new Array(len - arr.length).fill(0));
  const sl = (selectiveList || []).slice(0, n);
  const e2s = sl.map(s => s.e2 || _E2_SEL_DEFAULT);

  gl.uniform1fv(locs.uMode,    new Float32Array(pad(e2s.map(e2 => e2.mode === 'set' ? 1 : 0), 8)));
  // 色相中心必須是 OKLCH 色相（HSL 角 ≠ OKLCH 角：HSL 綠 120° ≈ OKLCH 142°）：優先由 pickedRgb 換算，
  // 缺 pickedRgb（色環點選僅存 targetHue）則以 HSL(h,75%,50%) 代表色換算。寬度/羽化為角度 → /360（hueDist2 回傳 0..0.5 圈）。
  gl.uniform1fv(locs.uHueC,    new Float32Array(pad(sl.map(s => _oklchHueOfItem(s)), 8)));
  gl.uniform1fv(locs.uHueW,    new Float32Array(pad(e2s.map(e2 => (e2.qual.hW ?? 30) / 360), 8)));
  gl.uniform1fv(locs.uHueSoft, new Float32Array(pad(e2s.map(e2 => (e2.qual.hSoft ?? 6) / 360), 8)));
  gl.uniform1fv(locs.uSC,      new Float32Array(pad(e2s.map(e2 => (e2.qual.sC ?? 50) / 100), 8)));
  gl.uniform1fv(locs.uSW,      new Float32Array(pad(e2s.map(e2 => (e2.qual.sW ?? 50) / 100), 8)));
  gl.uniform1fv(locs.uSSoft,   new Float32Array(pad(e2s.map(e2 => (e2.qual.sSoft ?? 10) / 100), 8)));
  gl.uniform1fv(locs.uLC,      new Float32Array(pad(e2s.map(e2 => (e2.qual.lC ?? 50) / 100), 8)));
  gl.uniform1fv(locs.uLW,      new Float32Array(pad(e2s.map(e2 => (e2.qual.lW ?? 50) / 100), 8)));
  gl.uniform1fv(locs.uLSoft,   new Float32Array(pad(e2s.map(e2 => (e2.qual.lSoft ?? 10) / 100), 8)));
  gl.uniform1fv(locs.uDH,      new Float32Array(pad(e2s.map(e2 => (e2.dH ?? 0) / 360), 8)));
  gl.uniform1fv(locs.uDC,      new Float32Array(pad(e2s.map(e2 => (e2.dC ?? 0) / 100), 8)));
  gl.uniform1fv(locs.uDL,      new Float32Array(pad(e2s.map(e2 => (e2.dL ?? 0) / 100), 8)));
  const tgt = [];
  e2s.forEach(e2 => {
    const lch = _oklchFromHex(e2.target?.hex || '#2E8B57');
    tgt.push(lch.L, lch.C, lch.h);
  });
  gl.uniform3fv(locs.uTgt, new Float32Array(pad(tgt, 8 * 3)));
  gl.uniform1fv(locs.uStrength, new Float32Array(pad(e2s.map(e2 => (e2.target?.strength ?? 100) / 100), 8)));
  gl.uniform1fv(locs.uKeepL,    new Float32Array(pad(e2s.map(e2 => (e2.target?.keepL ?? 100) / 100), 8)));
  gl.uniform1fv(locs.uCtr,      new Float32Array(pad(e2s.map(e2 => (e2.contrast ?? 0) / 100), 8)));
  gl.uniform1fv(locs.uVib,      new Float32Array(pad(e2s.map(e2 => (e2.vibrance ?? 0) / 100), 8)));
  gl.uniform1fv(locs.uSepia,    new Float32Array(pad(e2s.map(e2 => (e2.sepia ?? 0) / 100), 8)));
  gl.uniform1fv(locs.uCenterL,  new Float32Array(pad(sl.map(s => {
    const p = s.pickedRgb;
    return p ? _oklchLFromRgb255(p[0], p[1], p[2]) : 0.5;
  }), 8)));

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

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
    uMode:     gl.getUniformLocation(p, 'uMode'),
    uTargetLum:gl.getUniformLocation(p, 'uTargetLum'),
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
  _glTexW = _glCanvas.width; _glTexH = _glCanvas.height;
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
  }
  if (_glTexW !== w || _glTexH !== h) {
    // 紋理尺寸不符（首次上傳／尺寸改變／_glClearTexture 後的 1×1）→ 必須 texImage2D 重配
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vid);
    _glTexW = w; _glTexH = h;
  } else {
    // 使用 texSubImage2D 前確保影片 readyState >= 2（有可用幀）
    if (vid.readyState < 2) return;
    try {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, vid);
    } catch (e) {
      // 影片解碼尺寸不符（尺寸剛改變但 readyState 未更新）→ 回退 texImage2D
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vid);
      _glTexW = w; _glTexH = h;
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
      const vid = _VCS._vid;
      if (_active.length && vid.videoWidth && vid.videoHeight &&
        vid.readyState >= 2 && _glInit(vid)) {
        _glUploadVideoFrame(vid);
        _glRender(_active);
        _glEnsureAttached(vid);
        _glShowCanvas(true);
      } else if (_active.length && _glReadyFrame && vid.seeking && vid.readyState < 2) {
        /* seek 中（方向鍵連按／手機橫拖）readyState 會短暫降到 HAVE_METADATA：
           這是暫態而非「無濾鏡」→ 保留上一幀 overlay，避免選色濾鏡閃爍消失（原畫面露出） */
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
  if (_VCS.engine === 2 && !_gl2Failed) return _glRender2(selectiveList);
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
  // 色相模式：range 為角度→/360；明度模式：range 5–60 映射為明度差 0.03–0.33（/180）
  gl.uniform1fv(locs.uRange,     new Float32Array(pad(sl.map(s => s.mode === 'lum' ? (s.range||30)/180 : (s.range||30)/360), 8)));
  gl.uniform1fv(locs.uMode,      new Float32Array(pad(sl.map(s => s.mode === 'lum' ? 1 : 0), 8)));
  gl.uniform1fv(locs.uTargetLum, new Float32Array(pad(sl.map(s => s.targetLum ?? 0.5), 8)));
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
  if (_glProgram2) _gl.deleteProgram(_glProgram2);
  _gl.deleteTexture(_glTexture);
  _gl.deleteBuffer(_glPosBuf);
  if (_glCanvas && _glCanvas.parentElement) _glCanvas.parentElement.removeChild(_glCanvas);
  _gl = _glCanvas = _glProgram = _glTexture = _glPosBuf = _glLocs = _glTexSrc = null;
  _glProgram2 = null; _glLocs2 = null; _gl2Failed = false;
  _glReadyFrame = false; _glTexW = _glTexH = 0;
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
export function _glHasReadyFrame()  { return _glReadyFrame; }
/** 清除 GL 紋理舊幀（上傳 1×1 透明像素） */
export function _glClearTexture() {
  if (_gl && _glTexture) {
    _gl.bindTexture(_gl.TEXTURE_2D, _glTexture);
    _gl.texImage2D(_gl.TEXTURE_2D, 0, _gl.RGBA, 1, 1, 0, _gl.RGBA, _gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));
    _glTexW = _glTexH = 1;   // 紋理已縮為 1×1，下次上傳必走 texImage2D 重配
  }
}
