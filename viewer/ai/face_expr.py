"""臉部表情辨識（B6）：FER+ ONNX 對既有人臉索引的臉框分類 → face_expressions.json。

沿用 face_indexer 的臉框資料（faces_meta.json，不重新偵測）：每張臉以 bbox
方形外擴 EXPR_CROP_MARGIN 裁切 → 灰階 64×64 → emotion-ferplus-8 → softmax
argmax → 繁體中文八類標籤（中性/開心/驚訝/難過/生氣/厭惡/害怕/輕蔑）。

影像載入與 face_engine.detect_and_embed 完全同路徑（JPEG draft 1280）——
faces_meta 的 bbox 座標屬 draft 解碼空間，載入方式必須一致才對得上臉框；
影片多幀臉（frame_ts）以 ffmpeg 重抽該幀（video_frames.extract_frame）。

輸出（data/{lib}/ai_index/，tmp + os.replace 原子寫；只寫本專案自有檔案）：
    face_expressions.json  臉層級 {faces: {face_key: [標籤, 機率] | null}}
                           （builder 專用；大庫可達數十 MB，熱路徑勿整檔 parse）
    item_expressions.json  項目層聚合 {items: {item_id: [標籤, ...]}}（API 供前端篩選；
                           臉機率 ≥ EXPR_ITEM_MIN_SCORE 才聚合，寧缺勿濫）
    face_expr_state.json   輕量狀態 sidecar（status 輪詢唯一讀點，比照 persons_summary）

增量：face_key = "{id}|{frame_ts}|{bbox}"；已算過（含壞檔 null 註記）的臉跳過。
紅線：媒體檔 / Eagle .library / Excire SQLite 一律唯讀。
"""
import json
import os
import time
from datetime import datetime, timezone

import numpy as np
from PIL import Image

from . import _VIEWER_DIR  # noqa: F401
from config import LIBRARY_PATHS
from .fer_setup import (EXPR_LABELS_ZH, FER_INPUT_SIZE, FER_MODEL_DIR,
                        FER_MODEL_NAME, ensure_fer_model)
from .face_setup import DET_INPUT_SIZE
from .indexer import ai_index_dir

EXPR_CROP_MARGIN    = 0.25   # bbox 方形外擴比例（FER+ 訓練裁切較 SCRFD bbox 寬鬆）
EXPR_ITEM_MIN_SCORE = 0.4    # 聚合至項目層的最低 softmax 機率


# ---------------------------------------------------------------------------
# FER 引擎（單一 onnx session；lazy 建構，模式比照 face_engine）
# ---------------------------------------------------------------------------

class FerEngine:
    """emotion-ferplus-8 onnxruntime session 管理。輸入 64×64 灰階 0–255。"""

    def __init__(self, model_dir=None, providers=None):
        self.model_dir = model_dir or FER_MODEL_DIR
        self.providers = providers
        self.model_name = FER_MODEL_NAME
        self._sess = None
        self._input_name = None

    @property
    def sess(self):
        if self._sess is None:
            from .clip_engine import _import_ort
            ort = _import_ort()
            ensure_fer_model(verbose=True, check_hash=False)   # 熱路徑僅驗大小
            opts = ort.SessionOptions()
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            providers = self.providers or ["CPUExecutionProvider"]
            self._sess = ort.InferenceSession(
                str(self.model_dir / "emotion-ferplus-8.onnx"),
                sess_options=opts, providers=providers)
            self._input_name = self._sess.get_inputs()[0].name
        return self._sess

    def _crop(self, im: Image.Image, bbox) -> Image.Image:
        """bbox 方形外擴 EXPR_CROP_MARGIN 裁切 → 灰階 64×64。"""
        x1, y1, x2, y2 = bbox
        cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
        half = max(x2 - x1, y2 - y1) / 2.0 * (1.0 + EXPR_CROP_MARGIN)
        w, hgt = im.size
        l = max(0, int(round(cx - half)))
        t = max(0, int(round(cy - half)))
        r = min(w, int(round(cx + half)))
        b = min(hgt, int(round(cy + half)))
        if r <= l or b <= t:                      # 越界退化 → 原 bbox 保底
            l, t = max(0, int(x1)), max(0, int(y1))
            r, b = min(w, max(l + 1, int(x2))), min(hgt, max(t + 1, int(y2)))
        return im.crop((l, t, r, b)).convert("L").resize(
            (FER_INPUT_SIZE, FER_INPUT_SIZE), Image.BILINEAR)

    def predict(self, im: Image.Image, bbox):
        """單臉表情 → (label_zh, prob)。im 為原載入影像，bbox 同 faces_meta 座標。"""
        face = self._crop(im, bbox)
        arr = np.asarray(face, dtype=np.float32)[None, None]    # (1, 1, 64, 64)，0–255
        sess = self.sess
        out = sess.run(None, {self._input_name: arr})[0][0]     # (8,) raw scores
        e = np.exp(out - out.max())                             # softmax（數值穩定）
        prob = e / e.sum()
        idx = int(prob.argmax())
        return EXPR_LABELS_ZH[idx], float(prob[idx])


_default_fer_engine = None


def get_fer_engine() -> FerEngine:
    """模組級單例。"""
    global _default_fer_engine
    if _default_fer_engine is None:
        _default_fer_engine = FerEngine()
    return _default_fer_engine


# ---------------------------------------------------------------------------
# 持久化
# ---------------------------------------------------------------------------

def face_key(m: dict) -> str:
    """faces_meta 一列 → 穩定增量鍵（不依賴列序——影片重建/重聚類後列序會變）。"""
    ts = m.get("frame_ts")
    return (f"{m['id']}|{'' if ts is None else ts}|"
            + ",".join(str(v) for v in m["bbox"]))


def expressions_file(lib: str):
    return ai_index_dir(lib) / "face_expressions.json"


def item_expressions_file(lib: str):
    return ai_index_dir(lib) / "item_expressions.json"


def expr_state_file(lib: str):
    return ai_index_dir(lib) / "face_expr_state.json"


def _load_json(f) -> dict:
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def load_face_expressions(lib: str) -> dict:
    """臉層級全檔（builder / 分析用；大庫勿在熱路徑呼叫）。"""
    return _load_json(expressions_file(lib))


def load_item_expressions(lib: str) -> dict:
    """項目層聚合（API 熱路徑；檔案小）。不存在 / 壞檔 → {}。"""
    return _load_json(item_expressions_file(lib))


def _atomic_write(f, data: dict) -> None:
    tmp = f.with_name(f.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, f)


# ---------------------------------------------------------------------------
# 建索引（增量；批次離線）
# ---------------------------------------------------------------------------

def _load_meta(lib: str) -> list:
    f = ai_index_dir(lib) / "faces_meta.json"
    if not f.exists():
        raise RuntimeError(f"{lib} 尚無人臉索引（faces_meta.json）；"
                           "請先 POST /api/ai/index {kind: faces}")
    return json.loads(f.read_text(encoding="utf-8"))


def _image_path_resolver(lib: str):
    """→ callable(item_id) → 人臉用大圖路徑 | None（與 face_indexer 同來源規則）。

    Eagle：urls_data.json 一次成 map（便宜）。Excire：逐 item lazy 解析——
    全庫 preview 路徑映射在 DrvFS 上是分鐘級 stat 風暴（Life 實測 ~8 分鐘），
    增量批次多半只需少量 item，lazy 解析可整段省下。
    """
    if lib in LIBRARY_PATHS:
        from .face_indexer import _iter_eagle_face_items
        return dict(_iter_eagle_face_items(lib)).get
    from excire import get_excire_library
    exlib = get_excire_library(lib)
    if exlib is None or not exlib.available:
        raise RuntimeError(f"Excire 庫不可用：{lib}")

    def _get(iid):
        try:
            pid = int(str(iid).replace("excire_", ""))
        except ValueError:
            return None
        return exlib.preview_path(pid) or exlib.thumb_path(pid)
    return _get


def _aggregate_items(meta: list, faces: dict) -> dict:
    """→ {item_id: [標籤（出現次數降冪）, ...]}；只聚合機率 ≥ 門檻的臉。"""
    per_item: dict = {}
    for m in meta:
        e = faces.get(face_key(m))
        if not e or e[1] < EXPR_ITEM_MIN_SCORE:
            continue
        per_item.setdefault(m["id"], {})
        per_item[m["id"]][e[0]] = per_item[m["id"]].get(e[0], 0) + 1
    return {iid: [zh for zh, _ in sorted(cnt.items(), key=lambda kv: -kv[1])]
            for iid, cnt in per_item.items()}


def build_face_expressions(lib: str, limit: int = None, flush_every: int = 200,
                           throttle: float = 0.0, progress_cb=None) -> dict:
    """建立 / 增量更新 lib 的臉部表情索引。

    Args:
        limit:       本次最多新處理 N 張臉（大庫子集驗證用）；None = 全量
        flush_every: 每 N 個影像單元（item / 影片幀）落盤一次
        throttle:    每落盤批次間 sleep 秒數

    Returns:
        {lib, faces_new, faces_done, faces_total, items_tagged, failed,
         skipped, elapsed_s}
    """
    d = ai_index_dir(lib)
    engine = get_fer_engine()
    meta = _load_meta(lib)

    data = load_face_expressions(lib)
    faces: dict = data.get("faces", {})

    todo_all = [m for m in meta if face_key(m) not in faces]
    todo = todo_all[:limit] if limit is not None else todo_all

    # 依影像單元分組（item；影片幀以 (id, frame_ts) 為單元），每單元只開檔一次
    groups: dict = {}
    for m in todo:
        groups.setdefault((m["id"], m.get("frame_ts")), []).append(m)

    img_path = _image_path_resolver(lib)            # iid → 人臉用大圖路徑（lazy）
    video_paths: dict = {}
    if lib in LIBRARY_PATHS and any(ts is not None for _, ts in groups):
        from .face_indexer import _iter_eagle_video_items
        video_paths = dict(_iter_eagle_video_items(lib))

    t0 = time.time()
    n_new, n_failed = 0, 0
    done_before = len(meta) - len(todo_all)         # 增量：既有臉（含壞檔註記）
    draft_size = (DET_INPUT_SIZE * 2, DET_INPUT_SIZE * 2)

    def _state(final: bool = False) -> dict:
        return {
            "lib": lib, "model": FER_MODEL_NAME,
            "status": "done" if final else "running",
            "faces_done": done_before + n_new + n_failed,
            "faces_total": len(meta),
            "failed": n_failed,
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

    def _flush(final: bool = False):
        d.mkdir(parents=True, exist_ok=True)
        _atomic_write(expressions_file(lib), {
            "lib": lib, "model": FER_MODEL_NAME,
            "labels": list(EXPR_LABELS_ZH),
            "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "faces": faces,
        })
        if final:                                   # 項目層聚合只在收尾重算一次
            _atomic_write(item_expressions_file(lib), {
                "lib": lib, "model": FER_MODEL_NAME,
                "labels": list(EXPR_LABELS_ZH),
                "min_score": EXPR_ITEM_MIN_SCORE,
                "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "items": _aggregate_items(meta, faces),
            })
        _atomic_write(expr_state_file(lib), _state(final))

    group_list = list(groups.items())
    if progress_cb:                          # 重活前先回報 total，UI 及早脫離「計算工作量…」
        progress_cb(0, len(group_list))
    for gi, ((iid, ts), rows) in enumerate(group_list):
        im = None
        try:
            if ts is not None:                      # 影片多幀臉：重抽該幀
                from .video_frames import extract_frame
                vpath = video_paths.get(iid)
                if vpath is None:
                    raise RuntimeError(f"找不到影片檔：{iid}")
                im = extract_frame(vpath, ts)
            else:                                   # 與 detect_and_embed 同載入路徑
                path = img_path(iid)
                if path is None:
                    raise RuntimeError(f"找不到影像檔：{iid}")
                with Image.open(path) as raw:
                    raw.draft("RGB", draft_size)    # bbox 座標屬 draft 解碼空間
                    im = raw.convert("RGB")
        except Exception:
            n_failed += len(rows)
            for m in rows:                          # 壞檔註記 null，不重試（既有語意）
                faces[face_key(m)] = None
            continue
        for m in rows:
            try:
                zh, prob = engine.predict(im, m["bbox"])
                faces[face_key(m)] = [zh, round(prob, 3)]
                n_new += 1
            except Exception:
                n_failed += 1
                faces[face_key(m)] = None
        if (gi + 1) % flush_every == 0:
            _flush()
            if progress_cb:
                progress_cb(gi + 1, len(group_list))
            if throttle:
                time.sleep(throttle)

    _flush(final=True)
    if progress_cb:
        progress_cb(len(group_list), len(group_list))
    return {"lib": lib, "faces_new": n_new,
            "faces_done": done_before + n_new + n_failed,
            "faces_total": len(meta),
            "items_tagged": len(load_item_expressions(lib).get("items", {})),
            "failed": n_failed,
            "skipped": len(meta) - len(todo),
            "elapsed_s": round(time.time() - t0, 1)}
