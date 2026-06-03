---
name: "WebGL Color Grading"
slug: "webgl-color-grading"
description: "WebGL/GPU 加速選色調整最佳實踐調研（Eagle Viewer 性能優化參考）"
url: "https://github.com/evanw/glfx.js"
stars: 0
license: ""
language: ["JavaScript", "GLSL"]
tags: ["webgl", "color-grading", "hsl", "selective-color", "canvas", "shader"]
checked_at: "2026-06-02"
latest_version: ""
latest_released_at: ""
tracked_version: ""
version_lag: null
default_branch: "master"
branches: []
references:
  - references/webgl-color-grading.formula.md
related: []
---

# WebGL Color Grading — Eagle Viewer 調研

$$\text{目標} = \text{JS loop}(\sim350ms,\;\text{凍結 UI}) \to \text{WebGL2 shader}(\sim8ms,\;\text{GPU 並行})$$

## 核心結論

$$\text{建議路徑} = \begin{cases}
\text{Phase 1} & \to \text{Web Worker（立即解凍 UI，成本低）} \\
\text{Phase 2} & \to \text{WebGL2 fragment shader（10× 加速）} \\
\text{Fallback} & \to \text{WebGL2} \succ \text{WebGL1} \succ \text{Worker+JS}
\end{cases}$$

## 技術棧

$$\text{glfx.js 借鑒} = \text{lazy shader init} + \text{simpleShader uniform 設定模式}$$

$$\text{不適用} = \text{glfx.js hue rotation（繞灰度軸旋轉，不支援選色範圍）}$$

## 多色塊方案

$$\leq 8\;\text{色塊} \to \text{uniform struct array，單一 draw call，shader 內 for loop}$$

詳見 `references/webgl-color-grading.formula.md`。
