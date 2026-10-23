---
title: "fabric.js WebGL Filter Pipeline 深度調研：Eagle Viewer 選色即時化最佳實踐"
domain: tech
tags: [fabric-js, webgl, filter-pipeline, texture-cache, program-cache, eagle-viewer, selective-color]
status: published
created: 2026-06-09
sources:
  - src/filters/WebGLFilterBackend.ts
  - src/filters/BaseFilter.ts
  - src/filters/Canvas2dFilterBackend.ts
  - src/filters/HueRotation.ts
  - src/filters/RemoveColor.ts
  - src/filters/Vibrance.ts
  - src/filters/typedefs.ts
  - src/filters/shaders/removeColor.ts
---

$$\text{fabric.js WebGL} = \underbrace{\text{programCache}}_{\text{compile once}} + \underbrace{\text{textureCache}}_{\text{upload once}} + \underbrace{\text{aPosition QUAD}}_{\text{全屏四邊形}} + \underbrace{\text{FBO ping-pong}}_{\text{多 pass}} \to \text{slider preview 零重建}$$

---

## 1. 架構全景（生產級 29k stars 驗證）

### 1.1 雙後端設計

```
WebGLFilterBackend        ← 主路徑（GPU）
  ├─ this.canvas          ← 專用離屏 WebGL canvas（使用者不可見）
  ├─ this.gl              ← WebGL1 context（非 WebGL2）
  ├─ programCache         ← shader 程式快取（key = filter type）
  ├─ textureCache         ← 圖片紋理快取（key = image cacheKey / src）
  └─ resources            ← help layers 快取（slider preview 專用）

Canvas2dFilterBackend     ← fallback（CPU JS loop）
  ├─ willReadFrequently: true
  └─ desynchronized: true  ← 關鍵：減少同步阻塞
```

### 1.2 關鍵決策：WebGL1 而非 WebGL2

fabric.js 使用 `canvas.getContext('webgl', ...)` 而非 `webgl2`：
- WebGL1 在 Electron / 所有主流瀏覽器 100% 支援
- 我們的選色 shader 不需要 WebGL2 專有功能
- **結論：Eagle Viewer 用 WebGL1 即可，無需 WebGL2**

---

## 2. 核心性能模式（直接可移植至 Eagle Viewer）

### 2.1 programCache — Shader 只編譯一次

```typescript
retrieveShader(options: TWebGLPipelineState): TWebGLProgramCacheItem {
  const key = this.getCacheKey();           // filter type name
  if (!options.programCache[key]) {
    options.programCache[key] = this.createProgram(options.context);  // 僅首次編譯
  }
  return options.programCache[key];
}
```

$$\text{programCache 律}: \text{getCacheKey()} \to \text{type string} \to \text{compile once} \to \text{reuse forever}$$

**Eagle Viewer 移植**：`_glProgram` 全域變數，lazy init 一次，之後只做 `gl.useProgram(_glProgram)`。

### 2.2 textureCache — 圖片紋理只上傳一次

```typescript
getCachedTexture(uniqueId: string, textureImageSource: TexImageSource): WebGLTexture | null {
  if (this.textureCache[uniqueId]) return this.textureCache[uniqueId];  // cache hit
  const texture = this.createTexture(this.gl, w, h, textureImageSource);
  this.textureCache[uniqueId] = texture;
  return texture;
}
```

$$\text{textureCache 律}: \text{cacheKey（src URL）} \to \text{texImage2D once} \to \text{每次 slider 僅 uniform update}$$

**Eagle Viewer 移植**：用 `_VCS._imgOriginalSrc` 作為 cacheKey，圖片換頁時 `evictCachesForKey` + 重新上傳。

### 2.3 全屏四邊形（aPosition 模式）

```typescript
aPosition: Float32Array = new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]);
// TRIANGLE_STRIP：左下→左上→右下→右上，覆蓋整個 UV 空間

gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
```

**Eagle Viewer 移植**：完全相同，aPosition buffer 建立一次，每次 draw 前 bind。

### 2.4 copyGLTo2D — ctx.drawImage 而非 readPixels

```typescript
copyGLTo2D(gl, pipelineState) {
  const ctx = targetCanvas.getContext('2d');
  ctx.translate(0, targetCanvas.height);
  ctx.scale(1, -1);                         // WebGL Y 軸翻轉修正
  ctx.drawImage(glCanvas, 0, sourceY, w, h, 0, 0, w, h);
}
```

$$\text{copyGLTo2D} = ctx.drawImage(\text{glCanvas}) \ll gl.readPixels() \quad (\text{GPU→GPU copy vs GPU→CPU stall})$$

**Eagle Viewer 移植策略**：更激進——**直接顯示 glCanvas，完全跳過 copy**。見 §3。

### 2.5 resources 物件 — Slider Preview 專用設計

```typescript
// Canvas2dFilterBackend 的明確設計說明（原文）：
// "If you are previewing a filter with a slider you probably do not want
//  to create help layers every filter step."
resources: TPipelineResources = {};  // blurLayer1, blurLayer2, sliceByTwo...
```

**直接確認**：fabric.js 明確為 slider preview 設計了 help layer 快取，避免每次重建 canvas。

---

## 3. Eagle Viewer 的最優架構（超越 fabric.js）

$$\text{Eagle Viewer 優勢} = \text{不需要 copyGLTo2D} \to \text{直接顯示 glCanvas}$$

fabric.js 之所以要 copyGLTo2D，是因為它需要把結果塞回 fabric canvas（2D context）。  
Eagle Viewer 不需要：`<img>` 只是顯示用，替換成 `<canvas>` 顯示 WebGL 結果即可。

### 3.1 最終架構

```
<div class="img-wrapper" style="position:relative">
  <img id="vid" style="filter: brightness(...) ...">          ← CSS 全域濾鏡
  <canvas id="vc-gl" style="position:absolute; inset:0; width:100%; height:100%">
    ← WebGL 選色疊加（pointer-events:none）
    ← 圖片完全透明時隱藏（display:none）
</div>
```

**Slider 觸發路徑（目標）：**
```
slider oninput → cancelAnimationFrame + requestAnimationFrame
  → updateUniforms(selectiveList)    // ~0.1ms
  → gl.drawArrays(TRIANGLE_STRIP, 0, 4)  // ~5–15ms GPU
  → display ✓（無 copy、無 blob、無 img.src 替換）
```

### 3.2 圖片切換時（換頁）

```javascript
// evict old texture
if (_glTextureSrc !== newSrc) {
  _gl.deleteTexture(_glTexture);
  _glTexture = _gl.createTexture();
  _glTextureSrc = null;
}
// lazy upload on next render
```

### 3.3 全域 CSS filter 與 WebGL 疊加的精確性

**潛在誤差**：CSS `hue-rotate(Xdeg)` 在 WebGL canvas 疊加層之後再生效，兩者順序不同於 fabric.js 的單一 pipeline。

**解法（選擇一）**：CSS filter 疊加 → 視覺上可接受，全域調整先 CSS，選色後 WebGL。  
**解法（選擇二）**：把全域調整也移進 WebGL shader，完全一致。shader uniforms 加：
```glsl
uniform float uBrightness, uContrast, uSaturate, uHueRotate, uSepia;
```
→ 全域 + 選色一次 drawCall，100% 精確，無疊加誤差。

**建議**：Phase 2 先做選擇一（快），Phase 3 可做選擇二（精準）。

---

## 4. Shader 實作（結合 fabric.js 模式 + webgl-color-grading 算法）

### 4.1 Vertex Shader（fabric.js aPosition 模式）

```glsl
precision highp float;
attribute vec2 aPosition;
varying vec2 vTexCoord;

void main() {
  vTexCoord = aPosition;                    // UV 直接用頂點座標
  gl_Position = vec4(aPosition * 2.0 - 1.0, 0.0, 1.0);  // NDC 轉換
}
```

### 4.2 Fragment Shader（選色 + 多 block）

```glsl
precision highp float;
uniform sampler2D uTexture;
varying vec2 vTexCoord;

// 最多 8 個選色 blocks（可依需求調整）
const int MAX_SEL = 8;
uniform int    uSelCount;
uniform float  uTargetHue[8];   // 0.0~1.0
uniform float  uRange[8];       // 色相範圍半徑
uniform float  uDeltaH[8];      // 色相偏移
uniform float  uDeltaS[8];      // 飽和偏移
uniform float  uDeltaL[8];      // 亮度偏移
uniform float  uContrast[8];    // 對比偏移
uniform float  uSepia[8];       // 復古強度

// RGB ↔ HSL（見 webgl-color-grading.formula.md 完整實作）
// ...（略，已在既有調研中完整定義）

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
  vec4 texel = texture2D(uTexture, vTexCoord);
  vec3 rgb   = texel.rgb;

  for (int i = 0; i < 8; i++) {
    if (i >= uSelCount) break;
    vec3 hsl  = RGBtoHSL(rgb);
    float dist = hueDist(hsl.x, uTargetHue[i]);
    float mask = 1.0 - smoothstep(uRange[i] * 0.8, uRange[i], dist);
    if (mask > 0.001) {
      vec3 adj = hsl;
      adj.x = fract(hsl.x + uDeltaH[i]);
      adj.y = clamp(hsl.y + uDeltaS[i], 0.0, 1.0);
      adj.z = clamp(hsl.z + uDeltaL[i], 0.0, 1.0);
      vec3 newRgb = HSLtoRGB(adj);
      newRgb = clamp(0.5 + (1.0 + uContrast[i]) * (newRgb - 0.5), 0.0, 1.0);
      newRgb = mix(newRgb, applySepia(newRgb), uSepia[i]);
      rgb = mix(rgb, newRgb, mask);
    }
  }

  gl_FragColor = vec4(rgb, texel.a);
}
```

**注意**：WebGL1 不支援 `for(i<uSelCount)` 動態上限（GLSL ES 1.0 限制）。  
**解法**：用 `if (i >= uSelCount) break;` 或直接 unroll 8 個 if-block。

### 4.3 Uniform Array 送出（fabric.js sendUniformData 模式）

```javascript
function _sendSelectiveUniforms(gl, locs, selectiveList) {
  const n = Math.min(selectiveList.length, 8);
  gl.uniform1i(locs.uSelCount, n);
  const targetHues = new Float32Array(8);
  const ranges = new Float32Array(8);
  const deltaH = new Float32Array(8);
  const deltaS = new Float32Array(8);
  const deltaL = new Float32Array(8);
  const contrast = new Float32Array(8);
  const sepia = new Float32Array(8);
  for (let i = 0; i < n; i++) {
    const s = selectiveList[i];
    targetHues[i] = (s.targetHue || 0) / 360;
    ranges[i]    = (s.range || 30) / 360;
    deltaH[i]    = (s.hueShift || 0) / 360;
    deltaS[i]    = s.saturate || 0;
    deltaL[i]    = s.brightness || 0;
    contrast[i]  = s.contrast || 0;
    sepia[i]     = s.sepia || 0;
  }
  gl.uniform1fv(locs.uTargetHue, targetHues);
  gl.uniform1fv(locs.uRange, ranges);
  gl.uniform1fv(locs.uDeltaH, deltaH);
  gl.uniform1fv(locs.uDeltaS, deltaS);
  gl.uniform1fv(locs.uDeltaL, deltaL);
  gl.uniform1fv(locs.uContrast, contrast);
  gl.uniform1fv(locs.uSepia, sepia);
}
```

---

## 5. 新增知識 vs 既有調研

| 項目 | 既有調研 | fabric.js 新增 |
|------|---------|---------------|
| WebGL 版本 | 建議 WebGL2 | **WebGL1 足夠，生產驗證** |
| Shader 編譯 | 提到 lazy init | **programCache 精確模式（key=type）** |
| 紋理快取 | 提到 upload once | **textureCache[cacheKey] 精確 evict 時機** |
| readback 方式 | 建議 PBO 非同步 | **ctx.drawImage(glCanvas) 更簡單，我們可完全跳過** |
| Fallback | Worker + JS | **desynchronized: true + willReadFrequently: true 兩個關鍵 hint** |
| slider 設計 | RAF throttle | **resources 物件：help layers 在 slider preview 不重建** |
| 選色 shader | 完整 HSL shader | **fabric.js 無此功能 → 確認自製 shader 是唯一路徑** |
| Y 軸翻轉 | 未提 | **WebGL Y 軸翻轉：copyGLTo2D 中 ctx.scale(1, -1) 修正** ← 重要 |
| for loop | 未提 | **GLSL ES 1.0 不支援動態 loop 上限 → 需 unroll 或 if-break** ← 重要 |

---

## 6. Eagle Viewer 實作清單（可直接開工）

$$\text{Phase 1（5 行）}: video\text{-}controls.js:399 \to \text{RAF throttle}$$

$$\text{Phase 2（\sim200 行）}:$$

| # | 工作 | 檔案 | 關鍵點 |
|---|------|------|--------|
| 2.1 | WebGL1 context 初始化 | video-controls.js | lazy init，alpha:false，深度/抗鋸齒關閉 |
| 2.2 | Vertex shader | inline string | aPosition UV 直接用，NDC 轉換 |
| 2.3 | Fragment shader | inline string | HSL 轉換 + 選色 + 8 blocks |
| 2.4 | programCache | `_glProgram` 全域 | compile once |
| 2.5 | textureCache | `_glTexture + _glTextureSrc` | 圖換才重傳 |
| 2.6 | `<canvas id="vc-gl">` | index.html | position:absolute inset:0 pointer-events:none |
| 2.7 | Y 軸翻轉修正 | fragment shader | `vTexCoord.y = 1.0 - vTexCoord.y` ← 或 vertex shader 處理 |
| 2.8 | GLSL loop 上限 | fragment shader | `if (i >= uSelCount) break;` 或 unroll |
| 2.9 | Fallback | Canvas2dFilterBackend 模式 | `desynchronized: true` + `willReadFrequently: true` |
| 2.10 | toBlob 路徑保留 | 儲存/匯出 | 用 gl canvas 的 `canvas.toBlob()` |

---

$$\delta(\text{fabric-js 調研}) = \text{WebGL1(生產驗證)} + \text{programCache+textureCache(精確模式)} + \text{drawImage-skip(Eagle優化)} + \text{Y-flip+loop限制(陷阱規避)} + \text{desynchronized+willReadFrequently(fallback)} \to \text{實作清單完整可開工}$$
