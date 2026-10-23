"""服裝辨識（粗類）：YOLOX-Tiny person 偵測 + Chinese-CLIP zero-shot →
clothing_tags.json（斷點續跑，偏離 scene_tags 全量模式）。

策略（five-slot 分組 + 開放詞彙）：
    每張影像先以 person_detect 偵測 ≤6 個 person bbox（見 person_detect.py），
    每個 person crop 各自送 Chinese-CLIP 影像塔（clip_engine.encode_pil_images，
    記憶體內編碼、不落地暫存檔），再對 CLOTHING_SLOTS 五槽位（headwear/top/
    bottom/footwear/outfit）各自做 zero-shot 分類：槽內 argmax + 閾值 + margin
    （寧缺勿濫，沿用 scene_tags 校準哲學），槽位間互不排斥（天然多標籤）。
    item 層將全部 person 命中標籤 union，依出現次數降冪（仿 item_expressions）。

**偏離 scene_tags 全量模式的理由**：scene_tags 直接消費既有 clip_vectors.npy
（全庫矩陣內積，免重新推論影像）；服裝需逐圖跑 YOLOX person 偵測 + 逐 person
CLIP 編碼，成本遠高於 scene_tags，必須採 face_expr.py/face_indexer.py 的
增量/斷點續跑模式（done_items 已處理即跳過）。

影像來源：與 CLIP 索引同源（indexer.list_items，Eagle 縮圖優先/Excire 480px
縮圖），影片 v1 僅用 Eagle 現成首幀縮圖（多幀為後續增強，不在本次範圍）。

輸出（data/{lib}/ai_index/，tmp + os.replace 原子寫；只寫本專案自有檔案）：
    clothing_tags.json   {lib, built_at, model, thresholds,
                          labels: {slot: [...]}, items: {item_id:
                          {tags: [標籤...]（union，出現次數降冪）, persons: N}}}
    clothing_state.json  輕量狀態 sidecar {status, done_items, todo_total,
                          todo_done, failed, updated_at}（API 輪詢唯一讀點）

紅線：Eagle 原圖 / Excire SQLite 一律唯讀；本模組只寫本專案自有 ai_index。
"""
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

from . import _VIEWER_DIR  # noqa: F401
from config import DATA_DIR, EXCIRE_PATHS, LIBRARY_PATHS
from .indexer import ai_index_dir, list_items
from .person_detect import get_person_detector
from .person_setup import PERSON_MODEL_NAME

# ── 五槽位詞表（全繁體中文；種子類別覆蓋使用者指名 + 常見粗類補齊）───────────
# 開放詞彙：新增類別 = 後端此處加一行，前端零改動（詳見規格裁決五）。
CLOTHING_SLOTS = {
    "headwear": [
        ("球帽", {"prompts": ["戴著棒球帽的人", "戴鴨舌帽的人"]}),
        ("毛帽", {"prompts": ["戴著毛帽的人", "戴針織帽的人"]}),
        ("安全帽", {"prompts": ["戴著安全帽的人", "騎車戴安全帽的人"]}),
    ],
    "top": [
        ("帽T", {"prompts": ["穿著帽T的人", "穿連帽上衣的人"]}),
        ("T恤", {"prompts": ["穿著T恤的人", "穿短袖上衣的人"]}),
        ("襯衫", {"prompts": ["穿著襯衫的人", "穿有領子上衣的人"]}),
        ("外套", {"prompts": ["穿著外套的人", "穿夾克的人"]}),
        ("毛衣", {"prompts": ["穿著毛衣的人", "穿針織上衣的人"]}),
        ("背心", {"prompts": ["穿著背心的人", "穿無袖上衣的人"]}),
        ("西裝", {"prompts": ["穿著西裝的人", "穿西裝外套打領帶的人"]}),
        ("球衣", {"prompts": ["穿著運動球衣的人", "穿隊服球衣的人"]}),
    ],
    "bottom": [
        ("長褲", {"prompts": ["穿著長褲的人", "穿休閒長褲的人"]}),
        ("短褲", {"prompts": ["穿著短褲的人", "穿運動短褲的人"]}),
        ("牛仔褲", {"prompts": ["穿著牛仔褲的人", "穿丹寧褲的人"]}),
        ("裙子", {"prompts": ["穿著裙子的人", "穿短裙的人"]}),
    ],
    "footwear": [
        ("運動鞋", {"prompts": ["穿著運動鞋的人", "穿球鞋的人"]}),
        ("皮鞋", {"prompts": ["穿著皮鞋的人", "穿正式皮鞋的人"]}),
        ("涼拖鞋", {"prompts": ["穿著拖鞋的人", "穿涼鞋的人"]}),
        ("靴子", {"prompts": ["穿著靴子的人", "穿長靴的人"]}),
    ],
    "outfit": [
        ("校服", {"prompts": ["穿著學校制服的學生", "穿制服的人"]}),
        ("運動服", {"prompts": ["穿著運動服的人", "穿全套運動裝的人"]}),
        ("洋裝", {"prompts": ["穿著洋裝的人", "穿連身裙的人"]}),
        ("泳裝", {"prompts": ["穿著泳裝的人", "穿泳衣的人"]}),
    ],
}
CLOTHING_SLOT_ORDER = ("headwear", "top", "bottom", "footwear", "outfit")

# 每槽位 distractor prompt（F2）：不輸出為標籤，僅作為 softmax 對照項，
# 「真標籤須勝過 distractor」取代原本的 margin 機制。
CLOTHING_DISTRACTORS = {
    "headwear": "沒有戴帽子的人",
    "top": "看不清楚上衣的人",
    "bottom": "看不清楚褲子或裙子的人",
    "footwear": "看不到腳部的人",
    "outfit": "穿著普通日常衣服的人",
}

# r02 校準值（1-fix.md 記錄逐輪迭代數據）。
# cosine 為粗濾下限（distractor 對照為主要鑑別器，margin 已廢除）。
CLIP_COSINE_FLOOR = 0.46
CLIP_SOFTMAX_TAU = 100.0
CLIP_P_MIN = 0.80

# F3：原圖座標系 crop 尺寸門檻（服裝不可辨 / 背景路人 → 跳過該 person）
MIN_CROP_SHORT_SIDE = 96      # px
MIN_BBOX_AREA_FRAC = 0.015    # 佔全圖面積比例
CROP_EXPAND_FRAC = 0.08       # bbox 外擴比例（5-10% 區間取中）

CLOTHING_MODEL_NAME = "chinese-clip-vit-b16+yolox-tiny"
CLOTHING_ALGO_VERSION = 2   # F5：演算法版本；與既有 state 不符 → 自動全量重建

DEBUG_SCORES = bool(os.environ.get("CLOTHING_DEBUG_SCORES"))


def clothing_tags_file(lib: str):
    return ai_index_dir(lib) / "clothing_tags.json"


def clothing_state_file(lib: str):
    return ai_index_dir(lib) / "clothing_state.json"


def _load_json(f) -> dict:
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def load_clothing_tags(lib: str) -> dict:
    """讀取 clothing_tags.json；不存在 / 壞檔 → {}。"""
    return _load_json(clothing_tags_file(lib))


def load_clothing_state(lib: str) -> dict:
    return _load_json(clothing_state_file(lib))


def _atomic_write(f, data: dict) -> None:
    tmp = f.with_name(f.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, f)


# ---------------------------------------------------------------------------
# CLIP 文字塔：五槽位各自的 label 文字矩陣（沿用 scene_tags._encode_label_texts 手法）
# ---------------------------------------------------------------------------

_slot_matrix_cache: dict = {}   # slot → (float32 (n_labels+1, 512), labels 不含 distractor)


def _encode_slot_texts(slot: str):
    """每類多 prompt 編碼後 mean → 再 L2-normalize；末列附加 distractor 向量。

    回傳 (mat (n_labels+1, 512), labels)；mat[-1] 為該槽位 distractor 向量，
    labels 長度 = n_labels（不含 distractor）。
    """
    cached = _slot_matrix_cache.get(slot)
    if cached is not None:
        return cached
    from .clip_engine import get_engine
    eng = get_engine()
    rows = []
    labels = []
    for zh, spec in CLOTHING_SLOTS[slot]:
        t = eng.encode_texts(spec["prompts"])            # (k, 512) L2-normalized
        v = t.mean(axis=0)
        v /= max(float(np.linalg.norm(v)), 1e-12)
        rows.append(v)
        labels.append(zh)
    dvec = eng.encode_texts([CLOTHING_DISTRACTORS[slot]])[0]
    rows.append(dvec)
    mat = np.stack(rows).astype(np.float32)
    out = (mat, labels)
    _slot_matrix_cache[slot] = out
    return out


def _classify_slot(vec: np.ndarray, slot: str, debug: list = None):
    """單一 person crop 向量 → 該槽位命中標籤 | None。

    F2：softmax(τ×cosine) 對照 distractor——真標籤須勝過 distractor 且
    softmax 機率 ≥ CLIP_P_MIN；cosine 絕對下限僅作粗濾。margin 已廢除。
    debug 非 None 時 append 逐候選分數 dict（供 --debug-scores 使用）。
    """
    tmat, labels = _encode_slot_texts(slot)               # (L+1, 512)
    scores = tmat @ vec                                    # (L+1,)
    d_idx = len(labels)
    top = int(scores.argmax())
    s = float(scores[top])

    logits = CLIP_SOFTMAX_TAU * (scores - float(scores.max()))
    probs = np.exp(logits)
    probs /= probs.sum()

    if debug is not None:
        debug.append({
            "slot": slot,
            "candidates": [{"label": lab, "cosine": round(float(scores[i]), 4),
                             "prob": round(float(probs[i]), 4)}
                            for i, lab in enumerate(labels)],
            "distractor_cosine": round(float(scores[d_idx]), 4),
            "distractor_prob": round(float(probs[d_idx]), 4),
            "winner": "distractor" if top == d_idx else labels[top],
        })

    if top == d_idx:
        return None                                        # distractor 勝出 → 無標籤
    if s < CLIP_COSINE_FLOOR:
        return None                                         # 粗濾
    if float(probs[top]) < CLIP_P_MIN:
        return None                                         # 未顯著勝過 distractor
    return labels[top]


# ---------------------------------------------------------------------------
# F1：原圖路徑解析（縮圖僅供偵測，crop 升級至原圖）
# ---------------------------------------------------------------------------

_eagle_orig_cache: dict = {}   # lib → {item_id: 原圖絕對路徑}（image only）


def _eagle_originals(lib: str) -> dict:
    cached = _eagle_orig_cache.get(lib)
    if cached is not None:
        return cached
    out: dict = {}
    data_file = DATA_DIR / lib / "urls_data.json"
    if data_file.exists():
        try:
            items = json.loads(data_file.read_text(encoding="utf-8")).get("items", [])
        except (json.JSONDecodeError, OSError):
            items = []
        lib_path = LIBRARY_PATHS[lib]
        prefix = f"images/{lib}/"
        for it in items:
            iid = it.get("id")
            # 影片原檔非影像，PIL 無法開啟，維持縮圖 fallback
            if not iid or it.get("media_type") != "image":
                continue
            rel = it.get("file")
            if rel and rel.startswith(prefix):
                out[iid] = lib_path / "images" / rel[len(prefix):]
    _eagle_orig_cache[lib] = out
    return out


def _original_path(lib: str, iid: str):
    """回傳原圖絕對路徑（不可得 → None，呼叫端 fallback 縮圖）。"""
    if lib in LIBRARY_PATHS:
        return _eagle_originals(lib).get(iid)
    if lib in EXCIRE_PATHS:
        from excire import get_excire_library
        exlib = get_excire_library(lib)
        if exlib is None or not exlib.available:
            return None
        pid_s = iid[len("excire_"):] if iid.startswith("excire_") else iid
        try:
            pid = int(pid_s)
        except ValueError:
            return None
        for getter in (exlib.original_path, exlib.preview_path):
            try:
                p = getter(pid)
            except Exception:
                p = None
            if p is not None and Path(p).exists():
                return Path(p)
        return None
    return None


# ---------------------------------------------------------------------------
# F3：尺寸門檻 + crop 產生（外擴 5-10%）
# ---------------------------------------------------------------------------

def _scaled_bbox(bbox, sx: float, sy: float):
    x1, y1, x2, y2 = bbox
    return (x1 * sx, y1 * sy, x2 * sx, y2 * sy)


def _size_ok(bbox, img_w: int, img_h: int) -> bool:
    x1, y1, x2, y2 = bbox
    w, h = max(0.0, x2 - x1), max(0.0, y2 - y1)
    if min(w, h) < MIN_CROP_SHORT_SIDE:
        return False
    area_frac = (w * h) / max(1.0, float(img_w * img_h))
    if area_frac < MIN_BBOX_AREA_FRAC:
        return False
    return True


def _expand_crop(bbox, img_w: int, img_h: int, frac: float = CROP_EXPAND_FRAC):
    x1, y1, x2, y2 = bbox
    w, h = x2 - x1, y2 - y1
    ex, ey = w * frac, h * frac
    x1, y1 = max(0, int(x1 - ex)), max(0, int(y1 - ey))
    x2, y2 = min(img_w, int(x2 + ex)), min(img_h, int(y2 + ey))
    x2, y2 = max(x1 + 1, x2), max(y1 + 1, y2)
    return x1, y1, x2, y2


# ---------------------------------------------------------------------------
# 主流程（增量；斷點續跑）
# ---------------------------------------------------------------------------

def build_clothing_tags(lib: str, limit: int = None, flush_every: int = 100,
                        throttle: float = 0.0, progress_cb=None,
                        debug_scores: bool = False) -> dict:
    """建立 / 增量更新 lib 的服裝標籤索引（YOLOX person 偵測 + CLIP zero-shot）。

    Args:
        limit:       本次最多新處理 N 個 item（小樣本驗證用）；None = 全量
        flush_every: 每 N 個 item 落盤一次（斷點續跑粒度）
        throttle:    每落盤批次間 sleep 秒數
        debug_scores: 印出逐 person 逐槽位全候選分數 + distractor 分數（F4 校準用）

    Returns:
        {lib, items_new, items_done, items_total, persons_detected,
         persons_skipped_size, low_res_persons, failed, skipped, elapsed_s}
    """
    debug_scores = debug_scores or DEBUG_SCORES
    d = ai_index_dir(lib)
    detector = get_person_detector()

    all_items = list_items(lib)
    data = load_clothing_tags(lib)
    state = load_clothing_state(lib)

    # F5：演算法版本不符既有 state → 自動清空 done_items 全量重建
    prior_version = state.get("algo_version", data.get("algo_version"))
    version_mismatch = prior_version != CLOTHING_ALGO_VERSION
    rebuilt = False
    if version_mismatch and (data or state):
        print(f"[clothing-tags] algo_version 不符（{prior_version!r} != "
              f"{CLOTHING_ALGO_VERSION}），清空既有索引全量重建", flush=True)
        data = {}
        state = {}
        rebuilt = True

    items: dict = data.get("items", {})
    done_set = set(state.get("done_items", items.keys()))

    todo_all = [(iid, p) for iid, p in all_items if iid not in done_set]
    todo = todo_all[:limit] if limit is not None else todo_all
    if progress_cb:                          # 重活前先回報 total，UI 及早脫離「計算工作量…」
        progress_cb(0, len(todo))

    t0 = time.time()
    n_done, n_failed, n_persons = 0, 0, 0
    n_size_skipped, n_low_res = 0, 0

    def _state(final: bool = False) -> dict:
        return {
            "lib": lib, "model": CLOTHING_MODEL_NAME,
            "algo_version": CLOTHING_ALGO_VERSION,
            "status": "done" if final else "running",
            "done_items": sorted(done_set),
            "todo_total": len(todo), "todo_done": n_done + n_failed,
            "failed": n_failed,
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

    def _flush(final: bool = False):
        d.mkdir(parents=True, exist_ok=True)
        _atomic_write(clothing_tags_file(lib), {
            "lib": lib, "model": CLOTHING_MODEL_NAME,
            "algo_version": CLOTHING_ALGO_VERSION,
            "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "thresholds": {"cosine_floor": CLIP_COSINE_FLOOR,
                          "softmax_tau": CLIP_SOFTMAX_TAU, "p_min": CLIP_P_MIN,
                          "min_crop_short_side": MIN_CROP_SHORT_SIDE,
                          "min_bbox_area_frac": MIN_BBOX_AREA_FRAC},
            "labels": {slot: [zh for zh, _ in defs]
                      for slot, defs in CLOTHING_SLOTS.items()},
            "items": items,
        })
        _atomic_write(clothing_state_file(lib), _state(final))

    from .clip_engine import get_engine
    engine = get_engine()

    for i, (iid, thumb_path) in enumerate(todo):
        try:
            with Image.open(thumb_path) as raw:
                thumb_im = raw.convert("RGB")
            persons = detector.detect(thumb_im)
        except Exception:
            n_failed += 1
            done_set.add(iid)
            continue

        if not persons:
            items[iid] = {"tags": [], "persons": 0}
            n_done += 1
            done_set.add(iid)
            if (i + 1) % flush_every == 0:
                _flush()
                if progress_cb:
                    progress_cb(i + 1, len(todo))
                if throttle:
                    time.sleep(throttle)
            continue

        # F1：原圖 crop——bbox 依縮圖→原圖比例映射；原圖不可得 fallback 縮圖
        low_res = False
        crop_src = thumb_im
        sx = sy = 1.0
        orig_path = _original_path(lib, iid)
        if orig_path is not None:
            try:
                with Image.open(orig_path) as orig_raw:
                    orig_im = orig_raw.convert("RGB")
                sx = orig_im.width / max(1, thumb_im.width)
                sy = orig_im.height / max(1, thumb_im.height)
                crop_src = orig_im
            except Exception:
                low_res = True
                crop_src = thumb_im
        else:
            low_res = True

        cw, ch = crop_src.size
        crops = []
        for p_ in persons:
            bbox = _scaled_bbox(p_["bbox"], sx, sy)
            if not _size_ok(bbox, cw, ch):
                n_size_skipped += 1
                continue
            x1, y1, x2, y2 = _expand_crop(bbox, cw, ch)
            crops.append(crop_src.crop((x1, y1, x2, y2)))
        if low_res and crops:
            n_low_res += 1

        if not crops:
            items[iid] = {"tags": [], "persons": 0}
        else:
            vecs, failed = engine.encode_pil_images(crops)
            failed_set = set(failed)
            tag_count: dict = {}
            n_ok_persons = 0
            for j in range(len(crops)):
                if j in failed_set:
                    continue
                n_ok_persons += 1
                vec = vecs[n_ok_persons - 1]
                for slot in CLOTHING_SLOT_ORDER:
                    dbg = [] if debug_scores else None
                    label = _classify_slot(vec, slot, debug=dbg)
                    if debug_scores:
                        print(f"[debug-scores] item={iid} person={j} {dbg[0]}",
                              flush=True)
                    if label:
                        tag_count[label] = tag_count.get(label, 0) + 1
            tags = [zh for zh, _ in sorted(tag_count.items(), key=lambda kv: -kv[1])]
            items[iid] = {"tags": tags, "persons": n_ok_persons}
            n_persons += n_ok_persons

        n_done += 1
        done_set.add(iid)
        if (i + 1) % flush_every == 0:
            _flush()
            if progress_cb:
                progress_cb(i + 1, len(todo))
            if throttle:
                time.sleep(throttle)

    _flush(final=True)
    if progress_cb:
        progress_cb(len(todo), len(todo))
    return {"lib": lib, "items_new": n_done,
            "items_done": len(done_set),
            "items_total": len(all_items),
            "persons_detected": n_persons,
            "persons_skipped_size": n_size_skipped,
            "low_res_items": n_low_res,
            "failed": n_failed,
            "skipped": len(all_items) - len(todo),
            "algo_version_rebuilt": rebuilt,
            "elapsed_s": round(time.time() - t0, 1)}
