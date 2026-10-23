"""人臉索引器：批次偵測 + embedding → data/{lib}/ai_index/。

輸出（faces.npy 與 faces_meta.json 列序對齊）：
    faces.npy          float32 (M, 512) ArcFace embedding，L2-normalized
    faces_meta.json    [{id, bbox, kps, det_score}, ...]
    faces_state.json   {done_items: [...], ...} 已處理 item（含 0 臉者），斷點續跑依據

影像來源（人臉需要較大圖，與 CLIP 索引的縮圖策略不同）：
    Eagle  lib：image → 原圖（file 欄位；JPEG draft 加速解碼），缺原圖退回 thumb；
                video → Eagle 現成 {name}_thumbnail.png 首幀
    Excire lib：previews.exfoto 1280px 預覽優先，缺預覽退回 480px 縮圖

斷點續跑：faces_state.json 的 done_items 一律跳過；每 flush_every 個 item
落盤一次（tmp + os.replace 原子寫）。重聚類不在此處——見 face_cluster.py。
"""
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import _VIEWER_DIR  # noqa: F401
from config import DATA_DIR, EXCIRE_PATHS, LIBRARY_PATHS
from .face_setup import FACE_EMBED_DIM, FACE_MODEL_NAME
from .face_engine import get_face_engine
from .indexer import ai_index_dir


# ---------------------------------------------------------------------------
# item 列舉（id → 人臉用大圖絕對路徑）
# ---------------------------------------------------------------------------

def _iter_eagle_face_items(lib: str) -> list:
    """讀 data/{lib}/urls_data.json → [(item_id, image_abs_path), ...]（原圖優先）。"""
    lib_path = LIBRARY_PATHS[lib]
    data_file = DATA_DIR / lib / "urls_data.json"
    if not data_file.exists():
        raise RuntimeError(f"找不到 {data_file}；請先於 viewer 完成該庫的索引（urls_data.json）")
    items = json.loads(data_file.read_text(encoding="utf-8")).get("items", [])
    out = []
    prefix = f"images/{lib}/"
    for it in items:
        iid = it.get("id")
        if not iid:
            continue
        rel = None
        if it.get("media_type") == "image":
            rel = it.get("file") or it.get("thumb")     # 原圖擇優，缺則縮圖
        else:
            rel = it.get("thumb")                       # 影片吃 Eagle 現成首幀
        if not rel or not rel.startswith(prefix):
            continue
        out.append((iid, lib_path / "images" / rel[len(prefix):]))
    return out


def _iter_excire_face_items(lib: str) -> list:
    """Excire 庫：previews.exfoto 1280px 優先，退回 480px 縮圖。"""
    from excire import get_excire_library
    exlib = get_excire_library(lib)
    if exlib is None or not exlib.available:
        raise RuntimeError(f"Excire 庫不可用：{lib}")
    rows = exlib._q_local("SELECT Id FROM photo_info ORDER BY Id")
    out = []
    for r in rows:
        pid = r["Id"]
        p = exlib.preview_path(pid) or exlib.thumb_path(pid)
        if p is not None:
            out.append((f"excire_{pid}", p))
    return out


def list_face_items(lib: str) -> list:
    """→ [(item_id, image_abs_path), ...]；lib 可為 Eagle 或 Excire 庫名。"""
    if lib in LIBRARY_PATHS:
        return _iter_eagle_face_items(lib)
    if lib in EXCIRE_PATHS:
        return _iter_excire_face_items(lib)
    known = sorted(LIBRARY_PATHS) + sorted(EXCIRE_PATHS)
    raise RuntimeError(f"未知的庫：{lib}\n可用：{known}")


# ---------------------------------------------------------------------------
# 索引持久化
# ---------------------------------------------------------------------------

def load_face_index(lib: str):
    """→ (vectors float32 (M,512), meta list[dict])；無索引 → (None, [])。"""
    d = ai_index_dir(lib)
    vec_f, meta_f = d / "faces.npy", d / "faces_meta.json"
    if not vec_f.exists() or not meta_f.exists():
        return None, []
    vecs = np.load(vec_f, mmap_mode="r")
    meta = json.loads(meta_f.read_text(encoding="utf-8"))
    if vecs.shape[0] != len(meta):       # 寫入中斷 → 取交集長度保守處理
        n = min(vecs.shape[0], len(meta))
        vecs, meta = vecs[:n], meta[:n]
    return vecs, meta


def load_face_state(lib: str) -> dict:
    f = ai_index_dir(lib) / "faces_state.json"
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_face_index(d: Path, vecs: np.ndarray, meta: list, state: dict) -> None:
    """tmp + os.replace 原子寫。npy → meta → state 順序落盤。"""
    d.mkdir(parents=True, exist_ok=True)
    tmp_npy = d / "faces.tmp.npy"
    with open(tmp_npy, "wb") as f:
        np.save(f, vecs)
    os.replace(tmp_npy, d / "faces.npy")
    tmp = d / "faces_meta.json.tmp"
    tmp.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, d / "faces_meta.json")
    tmp = d / "faces_state.json.tmp"
    tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, d / "faces_state.json")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def build_face_index(lib: str, limit: int = None, flush_every: int = 64,
                     throttle: float = 0.0, max_faces: int = 16,
                     min_size: int = 20, progress_cb=None) -> dict:
    """建立 / 增量更新 lib 的人臉索引。

    Args:
        limit:       本次最多新處理 N 個 item（小樣本驗證用）；None = 全量
        flush_every: 每 N 個 item 落盤一次（斷點續跑粒度）
        throttle:    每落盤批次間 sleep 秒數
        max_faces:   每張圖最多取臉數（det_score 降冪）
        min_size:    bbox 短邊下限 px

    Returns:
        {lib, items_done, faces_new, faces_total, failed, skipped, total, elapsed_s}
    """
    d = ai_index_dir(lib)
    engine = get_face_engine()

    all_items = list_face_items(lib)
    old_vecs, meta = load_face_index(lib)
    state = load_face_state(lib)
    done_set = set(state.get("done_items", []))

    # 一致性防護：meta 只保留 done_items 內的臉（中斷於 meta/state 寫入間隙時去重）
    if meta and done_set:
        keep = [i for i, m in enumerate(meta) if m["id"] in done_set]
        if len(keep) != len(meta):
            meta = [meta[i] for i in keep]
            old_vecs = np.asarray(old_vecs)[keep] if old_vecs is not None else None
    elif meta and not done_set:          # 舊索引無 state → 以 meta 內 id 重建
        done_set = {m["id"] for m in meta}

    vec_list = [np.asarray(old_vecs)] if old_vecs is not None and len(meta) else []
    todo = [(iid, p) for iid, p in all_items if iid not in done_set]
    if limit is not None:
        todo = todo[:limit]

    t0 = time.time()
    n_done, n_failed, n_faces_new = 0, 0, 0
    pending_vecs, pending_meta = [], []

    def _flush(final: bool = False):
        nonlocal vec_list, meta
        if pending_vecs:
            vec_list.append(np.stack(pending_vecs))
            meta = meta + pending_meta
            pending_vecs.clear()
            pending_meta.clear()
        merged = (np.concatenate(vec_list, axis=0) if len(vec_list) > 1 else
                  vec_list[0] if vec_list else
                  np.zeros((0, FACE_EMBED_DIM), dtype=np.float32))
        vec_list = [merged] if len(merged) else []
        _save_face_index(d, merged.astype(np.float32), meta, {
            "lib": lib, "model": FACE_MODEL_NAME,
            "status": "done" if final else "running",
            "done_items": sorted(done_set),
            "faces": len(meta), "failed": n_failed,
            "todo_total": len(todo), "todo_done": n_done + n_failed,
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        })

    for i, (iid, path) in enumerate(todo):
        try:
            faces = engine.detect_and_embed(path, max_faces=max_faces, min_size=min_size)
        except Exception:
            n_failed += 1
            done_set.add(iid)            # 壞檔不重試（與 CLIP 索引失敗語意一致）
            continue
        for f in faces:
            pending_vecs.append(f["embedding"])
            pending_meta.append({
                "id": iid,
                "bbox": [round(v, 1) for v in f["bbox"]],
                "kps": f["kps"],
                "det_score": round(f["det_score"], 4),
            })
        n_faces_new += len(faces)
        n_done += 1
        done_set.add(iid)
        if (i + 1) % flush_every == 0:
            _flush()
            if progress_cb:
                progress_cb(n_done + n_failed, len(todo))
            if throttle:
                time.sleep(throttle)

    elapsed = time.time() - t0
    _flush(final=True)
    return {"lib": lib, "items_done": n_done, "faces_new": n_faces_new,
            "faces_total": len(meta), "failed": n_failed,
            "skipped": len(done_set) - n_done - n_failed,
            "total": len(all_items), "elapsed_s": round(elapsed, 1)}
