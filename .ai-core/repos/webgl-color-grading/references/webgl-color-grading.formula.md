---
title: "WebGL/GPU 加速選色調整：Eagle Viewer 演算法優化調研"
domain: tech
tags: [webgl, glsl, color-grading, performance, eagle-viewer, offscreencanvas]
status: published
created: 2026-06-02
sources:
  - https://github.com/evanw/glfx.js/blob/master/src/filters/adjust/huesaturation.js
  - https://tsev.dev/posts/2020-06-19-colour-correction-with-webgl/
  - https://web.dev/articles/offscreen-canvas
  - https://medium.com/eureka-engineering/image-processing-with-webgl-c2af552e8df0
  - https://evilmartians.com/chronicles/faster-webgl-three-js-3d-graphics-with-offscreencanvas-and-web-workers
  - https://www.chilliant.com/rgb2hsv.html
  - https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
  - https://github.com/mrdoob/three.js/issues/22779
---

$$\text{Eagle-Viewer} \cdot \text{Color-Grading} = \text{WebGL}(\text{shader}) \oplus \text{Worker}(\text{fallback}) \to \text{GPU-parallel} \gg \text{JS-loop}$$

---

## 1. WebGL 方案可行性評估

### Pros（Eagle Viewer 情境）

$$\text{Pros} = \{P_1, P_2, P_3, P_4, P_5\}$$

- **P₁ 並行度**：GPU 有數百至數千個 shader core 同時處理像素，4K 圖片（約 800 萬像素）在 WebGL 中可在 1–5ms 內完成，JS loop 需 100–500ms
- **P₂ 不阻塞主執行緒**：shader 執行在 GPU，CPU 主執行緒保持響應
- **P₃ Electron 完整支援**：Electron 的 Chromium 核心對 WebGL/WebGL2 支援完整，不需 polyfill
- **P₄ 多效果合併**：6 維 delta（H/S/L/contrast/sepia/opacity）可在單一 fragment shader pass 全部套用，CPU 版本需 6 次迴圈
- **P₅ 多色塊 uniform array**：最多 8–16 個 targetHue 色塊可在一個 draw call 處理，無需多 pass

### Cons（需應對的限制）

$$\text{Cons} = \{C_1, C_2, C_3\}$$

- **C₁ 讀回開銷（最關鍵）**：`gl.readPixels()` 是同步的，會造成 GPU stall（10–50ms），若 Eagle Viewer 需要把結果寫回 `ImageData` 以供 Canvas 顯示，這是最大瓶頸
  - **解法**：使用 WebGL2 的 `PIXEL_PACK_BUFFER`（PBO）做非同步讀回，或直接用 WebGL 渲染到螢幕而非讀回
- **C₂ 初始化開銷**：WebGL context 建立約 40ms（vs Canvas 15ms），適合 lazy init 一次性建立複用
- **C₃ 調試複雜度**：GLSL shader 錯誤不易調試，需有 fallback 機制

### 關鍵決策前提

$$\text{Decision} : \text{Eagle-Viewer-output} \stackrel{?}{=} \text{render-to-screen} \mid \text{ImageData-readback}$$

若 Eagle Viewer 只需**顯示**結果（WebGL canvas 直接呈現）→ C₁ 不存在，WebGL 純優；
若必須讀回 `Uint8ClampedArray` → 需 PBO 非同步方案。

---

## 2. GLSL Shader 模板（HSL 選色 + 6 維 delta）

### 2.1 RGB ↔ HSL 轉換（GLSL）

```glsl
// RGB → HSL（基於 Chilliant 優化版）
vec3 RGBtoHSL(vec3 c) {
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float delta = maxC - minC;
    float L = (maxC + minC) * 0.5;
    float S = (L < 0.5)
        ? delta / (maxC + minC + 1e-6)
        : delta / (2.0 - maxC - minC + 1e-6);
    float H = 0.0;
    if (delta > 1e-6) {
        if (maxC == c.r)      H = (c.g - c.b) / delta + (c.g < c.b ? 6.0 : 0.0);
        else if (maxC == c.g) H = (c.b - c.r) / delta + 2.0;
        else                  H = (c.r - c.g) / delta + 4.0;
        H /= 6.0;
    }
    return vec3(H, S, L);
}

// HSL → RGB
float hue2rgb(float p, float q, float t) {
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
    if (t < 1.0/2.0) return q;
    if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
    return p;
}

vec3 HSLtoRGB(vec3 hsl) {
    float H = hsl.x, S = hsl.y, L = hsl.z;
    if (S < 1e-6) return vec3(L);
    float q = (L < 0.5) ? L * (1.0 + S) : L + S - L * S;
    float p = 2.0 * L - q;
    return vec3(
        hue2rgb(p, q, H + 1.0/3.0),
        hue2rgb(p, q, H),
        hue2rgb(p, q, H - 1.0/3.0)
    );
}
```

### 2.2 單一色塊：完整 Fragment Shader（6 維 delta）

```glsl
precision highp float;

uniform sampler2D u_texture;
uniform float u_targetHue;   // 0.0 ~ 1.0 (0=red, 1/3=green, 2/3=blue)
uniform float u_range;       // hue range radius, 0.0 ~ 0.5
uniform float u_deltaH;      // hue shift,       -0.5 ~ 0.5
uniform float u_deltaS;      // saturation shift, -1.0 ~ 1.0
uniform float u_deltaL;      // lightness shift,  -1.0 ~ 1.0
uniform float u_contrast;    // contrast,         -1.0 ~ 1.0
uniform float u_sepia;       // sepia strength,    0.0 ~ 1.0

varying vec2 v_texCoord;

// --- HSL 轉換函數（同上，省略重複） ---
// [貼入 RGBtoHSL / HSLtoRGB / hue2rgb]

// 色相環距離（處理 0/1 環繞）
float hueDist(float h1, float h2) {
    float d = abs(h1 - h2);
    return min(d, 1.0 - d);
}

// Sepia 矩陣
vec3 applySepia(vec3 c) {
    return vec3(
        dot(c, vec3(0.393, 0.769, 0.189)),
        dot(c, vec3(0.349, 0.686, 0.168)),
        dot(c, vec3(0.272, 0.534, 0.131))
    );
}

void main() {
    vec4 texel  = texture2D(u_texture, v_texCoord);
    vec3 rgb    = texel.rgb;
    vec3 hsl    = RGBtoHSL(rgb);
    float dist  = hueDist(hsl.x, u_targetHue);

    // 軟邊遮罩：落在 range 外的像素不受影響
    float mask = 1.0 - smoothstep(u_range * 0.8, u_range, dist);

    if (mask > 0.001) {
        // 套用 6 維 delta
        vec3 adjusted = hsl;
        adjusted.x = fract(hsl.x + u_deltaH);                        // H
        adjusted.y = clamp(hsl.y + u_deltaS, 0.0, 1.0);             // S
        adjusted.z = clamp(hsl.z + u_deltaL, 0.0, 1.0);             // L

        vec3 newRgb = HSLtoRGB(adjusted);

        // Contrast：以 0.5 為中心縮放
        newRgb = clamp(0.5 + (1.0 + u_contrast) * (newRgb - 0.5), 0.0, 1.0);

        // Sepia：混入
        newRgb = mix(newRgb, applySepia(newRgb), u_sepia);

        // 依 mask 強度混合
        rgb = mix(rgb, newRgb, mask);
    }

    gl_FragColor = vec4(rgb, texel.a);
}
```

### 2.3 Vertex Shader（通用全屏四邊形）

```glsl
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord  = a_texCoord;
}
```

---

## 3. glfx.js 架構摘要

$$\text{glfx.js} = \text{Texture} \otimes \text{Filter}^n \to \text{Canvas} \xrightarrow{\text{update()}} \text{Screen}$$

### 三核心概念

| 概念 | 說明 |
|------|------|
| **Texture** | 從 `<img>` 建立的原始圖片 GPU 資料 |
| **Filter** | 一個或多個 WebGL shader 的封裝，代表一種效果 |
| **Canvas** | 存放處理結果的 WebGL `<canvas>` buffer |

### 可借鑒的模式

**1. simpleShader 模式（極簡 uniform 設定）**
```javascript
// glfx.js 的 simpleShader helper：
// 自動把全屏四邊形 + uniform 傳入 → 一次 draw call
simpleShader.call(this, gl.hueSaturation, {
    hue: clamp(-1, hue, 1),
    saturation: clamp(-1, saturation, 1)
});
```

**2. hue rotation 技巧（繞灰度軸旋轉）**
glfx.js 的 hue 調整不走 RGB→HSL→RGB，而是直接旋轉 RGB 色彩向量繞灰度軸（黑到白的直線），數學上等效但計算更少：
```glsl
float angle = hue * 3.14159265;
float s = sin(angle), c = cos(angle);
vec3 weights = (vec3(2.0*c, -sqrt(3.0)*s - c, sqrt(3.0)*s - c) + 1.0) / 3.0;
color.rgb = vec3(
    dot(color.rgb, weights.xyz),
    dot(color.rgb, weights.zxy),
    dot(color.rgb, weights.yzx)
);
```
**限制**：此法是全域 hue rotation，**無法做選色範圍偵測**，Eagle Viewer 的選色需求必須走完整 RGB→HSL 路徑。

**3. lazy shader init + 物件復用**
```javascript
gl.hueSaturation = gl.hueSaturation || new Shader(null, shaderSrc);
```
shader 編譯一次後快取在 gl 物件上，之後每次呼叫只更新 uniform。

**4. Lazy WebGL context**：WebGL context 延遲到第一次 `canvas.draw()` 才建立，避免初始化阻塞。

---

## 4. Web Worker Fallback 方案

$$\text{Fallback} : \neg\text{WebGL} \to \text{OffscreenCanvas}(\text{Worker}) \to \text{ImageBitmap} \to \text{main-thread}$$

### 架構

```
Main Thread                     Worker Thread
─────────────────               ─────────────────────────────
imageData → postMessage ──────→ receive ImageData / ArrayBuffer
                                ↓
                                JS pixel loop (HSL processing)
                                ↓
                          postMessage(result, [result.buffer])
         ← transferable ←──────
display result
```

### 實作範本

**主執行緒：**
```javascript
// 建立 Worker（一次性）
const worker = new Worker('color-worker.js');

function applyColorAdjustment(imageData, params) {
    return new Promise(resolve => {
        const buffer = imageData.data.buffer;
        worker.postMessage(
            { buffer, width: imageData.width, height: imageData.height, params },
            [buffer]  // transferable：零複製傳輸
        );
        worker.onmessage = e => resolve(
            new ImageData(new Uint8ClampedArray(e.data.buffer),
                          imageData.width, imageData.height)
        );
    });
}
```

**color-worker.js：**
```javascript
self.onmessage = function({ data }) {
    const { buffer, width, height, params } = data;
    const pixels = new Uint8ClampedArray(buffer);

    for (let i = 0; i < pixels.length; i += 4) {
        const [h, s, l] = rgbToHsl(pixels[i], pixels[i+1], pixels[i+2]);
        if (hueDist(h, params.targetHue) > params.range) continue;
        // ...apply deltas
    }

    self.postMessage({ buffer: pixels.buffer }, [pixels.buffer]);
};
```

### OffscreenCanvas + WebGL in Worker（進階）

```javascript
// main-thread
const canvas = document.getElementById('myCanvas');
const offscreen = canvas.transferControlToOffscreen();
const worker = new Worker('gl-worker.js');
worker.postMessage({ canvas: offscreen, type: 'init' }, [offscreen]);

// gl-worker.js
let gl;
self.onmessage = function({ data }) {
    if (data.type === 'init') {
        gl = data.canvas.getContext('webgl2');
        initShaders(gl);
    } else if (data.type === 'process') {
        uploadTexture(gl, data.imageData);
        drawFullscreenQuad(gl);
        // 結果直接渲染到 canvas，無需 readPixels
    }
};
```

---

## 5. 多選色 Uniform Array 設計

$$\text{MultiColor} = \sum_{k=1}^{N} \text{Block}_k(\text{targetHue}_k, \text{range}_k, \Delta_k^{6}) \xrightarrow{\text{single-pass}} \text{output}$$

### Struct Array 方案（WebGL2 / GLSL ES 3.00）

```glsl
#version 300 es
precision highp float;

const int MAX_BLOCKS = 8;  // WebGL uniform limit 友好

struct ColorBlock {
    float targetHue;
    float range;
    float deltaH;
    float deltaS;
    float deltaL;
    float contrast;
    float sepia;
    float _pad;  // 對齊到 vec4 邊界
};

uniform ColorBlock u_blocks[MAX_BLOCKS];
uniform int u_blockCount;
uniform sampler2D u_texture;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
    vec4 texel = texture(u_texture, v_texCoord);
    vec3 rgb   = texel.rgb;

    for (int k = 0; k < MAX_BLOCKS; k++) {
        if (k >= u_blockCount) break;
        ColorBlock b = u_blocks[k];

        vec3 hsl  = RGBtoHSL(rgb);
        float d   = hueDist(hsl.x, b.targetHue);
        float mask = 1.0 - smoothstep(b.range * 0.8, b.range, d);

        if (mask > 0.001) {
            vec3 adj = hsl;
            adj.x = fract(adj.x + b.deltaH);
            adj.y = clamp(adj.y + b.deltaS, 0.0, 1.0);
            adj.z = clamp(adj.z + b.deltaL, 0.0, 1.0);
            vec3 newRgb = HSLtoRGB(adj);
            newRgb = clamp(0.5 + (1.0 + b.contrast) * (newRgb - 0.5), 0.0, 1.0);
            newRgb = mix(newRgb, applySepia(newRgb), b.sepia);
            rgb = mix(rgb, newRgb, mask);
        }
    }

    fragColor = vec4(rgb, texel.a);
}
```

### JavaScript 設定 Struct Array Uniforms

```javascript
function setColorBlocks(gl, program, blocks) {
    for (let k = 0; k < blocks.length; k++) {
        const b = blocks[k];
        gl.uniform1f(gl.getUniformLocation(program, `u_blocks[${k}].targetHue`), b.targetHue);
        gl.uniform1f(gl.getUniformLocation(program, `u_blocks[${k}].range`),     b.range);
        gl.uniform1f(gl.getUniformLocation(program, `u_blocks[${k}].deltaH`),    b.deltaH);
        gl.uniform1f(gl.getUniformLocation(program, `u_blocks[${k}].deltaS`),    b.deltaS);
        gl.uniform1f(gl.getUniformLocation(program, `u_blocks[${k}].deltaL`),    b.deltaL);
        gl.uniform1f(gl.getUniformLocation(program, `u_blocks[${k}].contrast`),  b.contrast);
        gl.uniform1f(gl.getUniformLocation(program, `u_blocks[${k}].sepia`),     b.sepia);
    }
    gl.uniform1i(gl.getUniformLocation(program, 'u_blockCount'), blocks.length);
}
```

### 單 pass vs 多 pass 比較

| 方案 | 優點 | 缺點 | 建議 |
|------|------|------|------|
| 單 pass（uniform array） | 最少 draw call，無中間 texture | loop 在 shader 內，GPU divergence | ≤8 色塊時優先選 |
| 多 pass（每色塊一次 draw） | shader 更簡單，易調試 | N 次 texture read/write，記憶體頻寬 2× | 色塊 >8 或複雜效果時考慮 |
| Render Target chain | 最靈活 | 最複雜，需 framebuffer 管理 | 不建議 Eagle Viewer 使用 |

---

## 6. 結論建議：Eagle Viewer 應採用哪條路徑

$$\text{Recommendation} = \text{WebGL2}(\text{primary}) \oplus \text{Worker+Canvas}(\text{fallback}) \times \{\text{lazy-init}, \text{render-to-screen}, \text{uniform-array}\}$$

### 建議架構：三層策略

```
┌─────────────────────────────────────────────────────┐
│ Layer 1：WebGL2（主路徑）                            │
│   - OffscreenCanvas in Worker（不阻塞主執行緒）     │
│   - 單一 fragment shader 處理全部色塊（uniform array）│
│   - 渲染結果直接顯示，避免 readPixels              │
└─────────────────────────────────────────────────────┘
         ↓ fallback（WebGL2 不可用）
┌─────────────────────────────────────────────────────┐
│ Layer 2：WebGL1（相容模式）                          │
│   - 同架構但使用 GLSL ES 1.00 語法                 │
│   - struct array 改用 flat uniform array           │
└─────────────────────────────────────────────────────┘
         ↓ fallback（WebGL 完全不可用）
┌─────────────────────────────────────────────────────┐
│ Layer 3：Web Worker + JS pixel loop（現有邏輯搬移） │
│   - 把現有 JS loop 移至 Worker                     │
│   - Transferable ArrayBuffer 零複製傳輸            │
│   - 至少不阻塞主執行緒                             │
└─────────────────────────────────────────────────────┘
```

### 預期性能改善

| 情境 | 現狀（JS main thread） | WebGL2 | Worker+JS |
|------|----------------------|--------|-----------|
| 2MP 圖（1920×1080） | ~80ms，阻塞 UI | ~3ms | ~80ms，非阻塞 |
| 4K 圖（3840×2160） | ~350ms，凍結 UI | ~8ms | ~350ms，非阻塞 |
| 多色塊×6 | 6× 上述時間 | 與單色塊相近（單 pass） | 線性增加 |

### 實作優先順序

1. **最高優先**：先把現有 JS loop 搬進 **Web Worker**（Layer 3），立即解決 UI 凍結問題，改動最小
2. **中期**：實作 WebGL2 shader（Layer 1），達成真正的 GPU 並行加速
3. **最終**：加入 Layer 1/2/3 自動偵測 fallback chain，確保跨裝置穩定性

### 關鍵實作注意

- **不要用 `gl.readPixels()` 同步讀回**：如需讀回，使用 WebGL2 PBO（`PIXEL_PACK_BUFFER`）非同步方案
- **shader 一次編譯，參數只更新 uniform**：避免每張圖片重新編譯 shader（參考 glfx.js 的 lazy init 模式）
- **uniform location cache**：`gl.getUniformLocation()` 結果應快取，不要每次 draw 重新查詢
- **smoothstep mask**：使用 `smoothstep` 做色相邊界軟過渡，避免硬邊 artifacts

---

## 參考來源

- [glfx.js hue/saturation shader 原始碼](https://github.com/evanw/glfx.js/blob/master/src/filters/adjust/huesaturation.js)
- [Colour correction with WebGL - Tim Severien](https://tsev.dev/posts/2020-06-19-colour-correction-with-webgl/)
- [OffscreenCanvas Web Workers - web.dev](https://web.dev/articles/offscreen-canvas)
- [Image Processing with WebGL - Eureka Engineering](https://medium.com/eureka-engineering/image-processing-with-webgl-c2af552e8df0)
- [Faster WebGL with OffscreenCanvas - Evil Martians](https://evilmartians.com/chronicles/faster-webgl-three-js-3d-graphics-with-offscreencanvas-and-web-workers)
- [RGB to HSL/HSV optimized HLSL - Chilliant](https://www.chilliant.com/rgb2hsv.html)
- [WebGL Best Practices - MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- [Canvas vs WebGL Performance - DigitalAdBlog 2025](https://digitaladblog.com/2025/05/21/comparing-canvas-vs-webgl-for-javascript-chart-performance/)
- [WebGL2 Async Readback PBO - three.js issue](https://github.com/mrdoob/three.js/issues/22779)
