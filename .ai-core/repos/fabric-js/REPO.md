---
name: "fabric.js"
slug: "fabric-js"
description: "HTML5 canvas 物件模型框架，含生產級 WebGL image filter pipeline（programCache+textureCache）"
url: "https://github.com/fabricjs/fabric.js"
stars: 29000
license: "MIT"
language: ["TypeScript", "JavaScript"]
tags: [canvas, webgl, image-filter, color-grading, program-cache, texture-cache, slider-preview]
checked_at: "2026-06-09"
latest_version: ""
latest_released_at: ""
tracked_version: ""
version_lag: null
default_branch: "master"
branches: []
references:
  - references/webgl-filter-pipeline.formula.md
related:
  - repos/webgl-color-grading
---

# fabric.js

$$\text{fabric.js} = \text{Canvas 物件模型} + \underbrace{\text{WebGL filter pipeline}}_{\text{programCache + textureCache + FBO ping-pong}} \to \text{slider preview 生產最佳實踐}$$

## 3W 定位

$$\text{3W} = \begin{cases}
What & \to \text{HTML5 Canvas 物件框架（29k stars，生產驗證）} \\
Why  & \to \text{canvas API 過於底層；fabric 提供物件、事件、序列化、濾鏡} \\
How  & \to \text{兩後端（WebGL / Canvas2d），pipeline state 傳遞，filter chain}
\end{cases}$$

## 核心架構

$$\text{兩後端} = \begin{cases}
\text{WebGLFilterBackend} & \to \text{GPU（WebGL1）：programCache + textureCache + FBO ping-pong} \\
\text{Canvas2dFilterBackend} & \to \text{CPU fallback：willReadFrequently + desynchronized}
\end{cases}$$

## 對 Eagle Viewer 的關鍵發現

$$\text{Eagle Viewer 直接可用}: \begin{cases}
P_1 & \text{WebGL1 足夠（非 WebGL2）：Electron 100\% 支援} \\
P_2 & \text{programCache：shader 編譯一次，key=type string} \\
P_3 & \text{textureCache：紋理上傳一次，key=src URL，evict on image change} \\
P_4 & \text{aPosition QUAD：[0,0, 0,1, 1,0, 1,1]，TRIANGLE\_STRIP 全屏四邊形} \\
P_5 & \text{ctx.drawImage(glCanvas) 比 readPixels 快；Eagle 可完全跳過 copy} \\
P_6 & \text{desynchronized:true + willReadFrequently:true → fallback 2D hint} \\
P_7 & \text{resources 物件：slider preview 期間 help layers 不重建}
\end{cases}$$

$$\text{陷阱（新發現）}: \begin{cases}
T_1 & \text{WebGL Y 軸翻轉：ctx.scale(1,-1) 或 shader vTexCoord.y = 1.0 - y} \\
T_2 & \text{GLSL ES 1.0 不支援動態 for loop 上限 → if-break 或 unroll}
\end{cases}$$

$$\text{fabric.js 沒有的（Eagle Viewer 需自製）}: \text{選色 HSL range filter（HueRotation 是全域 ColorMatrix，非選色）}$$

## 採用決策

不直接引入 fabric.js（過重，且缺少選色 shader）。但其 `WebGLFilterBackend` 架構作為 Eagle Viewer WebGL 實作的**設計藍本**：programCache + textureCache + aPosition QUAD + WebGL1。
