"""人臉索引器：批次偵測 + embedding → data/{lib}/ai_index/。

輸出（faces.npy 與 faces_meta.json 列序對齊）：
    faces.npy          float32 (M, 512) ArcFace embedding，L2-normalized
    faces_meta.json    [{id, bbox, kps, det_score[, frame_ts]}, ...]
                       frame_ts（秒）僅影片多幀索引（B3）產生的臉才有
    faces_state.json   {done_items: [...], video_mf_items: [...], ...}
                       done_items = 已處理 item（含 0 臉者，斷點續跑依據）；
                       video_mf_items = 已完成「多幀」索引的影片（B3 增量依據）

影像來源（人臉需要較大圖，與 CLIP 索引的縮圖策略不同）：
    Eagle  lib：image → 原圖（file 欄位；JPEG draft 加速解碼），缺原圖退回 thumb；
                video → 預設 Eagle 現成 {name}_thumbnail.png 首幀；
                        build_video_face_index（B3）以 ffmpeg 均勻抽幀補多幀
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


def _iter_eagle_video_items(lib: str) -> list:
    """Eagle 庫影片清單 → [(item_id, video_abs_path), ...]（B3 多幀索引來源）。"""
    lib_path = LIBRARY_PATHS[lib]
    data_file = DATA_DIR / lib / "urls_data.json"
    if not data_file.exists():
        raise RuntimeError(f"找不到 {data_file}；請先於 viewer 完成該庫的索引（urls_data.json）")
    items = json.loads(data_file.read_text(encoding="utf-8")).get("items", [])
    out = []
    prefix = f"images/{lib}/"
    for it in items:
        iid = it.get("id")
        rel = it.get("file")
        if not iid or it.get("media_type") != "video":
            continue
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

_vec_cache: dict = {}   # str(vec_f) → (mtime_ns, size, vecs)；重建後 mtime 變更即失效


def _load_npy_cached(vec_f: Path):
    # 非 mmap：np.load 讀完即關檔，Windows 上 os.replace 不會 [WinError 5]；
    # 快取避免熱路徑（status 輪詢/每次查詢）全量重讀。race 最壞情況為重複載入一次，無害。
    st = vec_f.stat()
    hit = _vec_cache.get(str(vec_f))
    if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
        return hit[2]
    vecs = np.load(vec_f)
    vecs.flags.writeable = False        # 共享快取，禁止呼叫端原地改寫
    _vec_cache[str(vec_f)] = (st.st_mtime_ns, st.st_size, vecs)
    return vecs


def load_face_index(lib: str):
    """→ (vectors float32 (M,512), meta list[dict])；無索引 → (None, [])。"""
    d = ai_index_dir(lib)
    vec_f, meta_f = d / "faces.npy", d / "faces_meta.json"
    if not vec_f.exists() or not meta_f.exists():
        return None, []
    vecs = _load_npy_cached(vec_f)
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
    if progress_cb:                          # 重活前先回報 total，UI 及早脫離「計算工作量…」
        progress_cb(0, len(todo))

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
            "video_mf_items": state.get("video_mf_items", []),   # B3 多幀紀錄保留
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


# ---------------------------------------------------------------------------
# B3：影片多幀人臉索引（ffmpeg 均勻抽幀；增量——只補未多幀化的影片）
# ---------------------------------------------------------------------------

VIDEO_DEDUP_COS = 0.90   # 同片內新臉與既留臉 cosine ≥ 此值 → 冗餘幀捨棄


def build_video_face_index(lib: str, limit: int = None, flush_every: int = 8,
                           throttle: float = 0.0, max_faces: int = 16,
                           min_size: int = 20, interval: float = None,
                           max_frames: int = None, progress_cb=None) -> dict:
    """對 Eagle 庫影片做多幀人臉索引（增量：跳過 video_mf_items 已含的影片）。

    每支影片：ffmpeg 均勻抽 N 幀（~1 幀/interval 秒、上限 max_frames；
    輸入端 seek 不全片解碼）→ 逐幀偵測 + embedding → faces_meta 以
    frame_ts（秒）標記來源幀。該影片既有的「首幀縮圖」臉列先移除再重建
    （避免縮圖臉與抽幀臉重複計入）。同片內 cosine ≥ VIDEO_DEDUP_COS 的
    冗餘臉只留先出現者。完成後呼叫端應重新聚類（faces.npy 列序已變）。

    Returns:
        {lib, videos_done, faces_new, faces_removed, faces_total, failed,
         skipped, total_videos, elapsed_s}
    """
    from .video_frames import (DEFAULT_FRAME_INTERVAL, DEFAULT_MAX_FRAMES,
                               ffmpeg_available, iter_video_frames)
    if lib not in LIBRARY_PATHS:
        # Excire 庫無影片（實查 photo_info 副檔名 0 筆 VIDEO_EXTS）
        return {"lib": lib, "videos_done": 0, "faces_new": 0, "faces_removed": 0,
                "failed": 0, "skipped": 0, "total_videos": 0, "elapsed_s": 0.0,
                "message": "非 Eagle 庫，無影片可抽幀"}
    if not ffmpeg_available():
        raise RuntimeError("找不到 ffmpeg / ffprobe；影片多幀索引需要系統 ffmpeg")
    interval = interval or DEFAULT_FRAME_INTERVAL
    max_frames = max_frames or DEFAULT_MAX_FRAMES

    d = ai_index_dir(lib)
    engine = get_face_engine()

    videos = _iter_eagle_video_items(lib)
    old_vecs, meta = load_face_index(lib)
    state = load_face_state(lib)
    done_set = set(state.get("done_items", []))
    mf_done = set(state.get("video_mf_items", []))

    todo = [(iid, p) for iid, p in videos if iid not in mf_done]
    if limit is not None:
        todo = todo[:limit]
    todo_ids = {iid for iid, _ in todo}

    # 本批影片既有臉列（首幀縮圖產物）先移除，重建為多幀
    n_removed = 0
    if meta and todo_ids:
        keep = [i for i, m in enumerate(meta) if m["id"] not in todo_ids]
        n_removed = len(meta) - len(keep)
        if n_removed:
            meta = [meta[i] for i in keep]
            old_vecs = np.asarray(old_vecs)[keep] if old_vecs is not None else None

    vec_list = [np.asarray(old_vecs)] if old_vecs is not None and len(meta) else []
    if progress_cb:                          # 重活前先回報 total，UI 及早脫離「計算工作量…」
        progress_cb(0, len(todo))
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
            "video_mf_items": sorted(mf_done),
            "faces": len(meta), "failed": n_failed,
            "todo_total": len(todo), "todo_done": n_done + n_failed,
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        })

    for i, (iid, path) in enumerate(todo):
        kept_embs, new_rows = [], []
        try:
            for ts, im in iter_video_frames(path, interval=interval,
                                            max_frames=max_frames):
                faces = engine.detect(im, max_faces=max_faces)
                faces = [f for f in faces
                         if min(f["bbox"][2] - f["bbox"][0],
                                f["bbox"][3] - f["bbox"][1]) >= min_size]
                if not faces:
                    continue
                embs = engine.embed(im, [f["kps"] for f in faces])
                for f, e in zip(faces, embs):
                    if kept_embs and float(np.max(np.stack(kept_embs) @ e)) >= VIDEO_DEDUP_COS:
                        continue                        # 同片冗餘幀去重
                    kept_embs.append(e)
                    new_rows.append((ts, f, e))
        except Exception:
            n_failed += 1
            mf_done.add(iid)                            # 壞檔不重試（與既有語意一致）
            done_set.add(iid)
            continue
        for ts, f, e in new_rows:
            pending_vecs.append(e)
            pending_meta.append({
                "id": iid,
                "bbox": [round(v, 1) for v in f["bbox"]],
                "kps": np.asarray(f["kps"]).round(2).tolist(),
                "det_score": round(float(f["det_score"]), 4),
                "frame_ts": ts,
            })
        n_faces_new += len(new_rows)
        n_done += 1
        mf_done.add(iid)
        done_set.add(iid)
        if (i + 1) % flush_every == 0:
            _flush()
            if progress_cb:
                progress_cb(n_done + n_failed, len(todo))
            if throttle:
                time.sleep(throttle)

    elapsed = time.time() - t0
    _flush(final=True)
    return {"lib": lib, "videos_done": n_done, "faces_new": n_faces_new,
            "faces_removed": n_removed, "faces_total": len(meta),
            "failed": n_failed, "skipped": len(videos) - len(todo),
            "total_videos": len(videos), "elapsed_s": round(elapsed, 1)}
