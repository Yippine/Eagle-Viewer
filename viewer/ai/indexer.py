"""語意索引器：批次 encode 縮圖 → data/{lib}/ai_index/。

輸出（列序對齊）：
    clip_vectors.npy   float32 (N, 512)，L2-normalized
    clip_ids.json      [item_id, ...] 與 npy 列序對齊
    meta.json          {model, dim, count, ...}
    index_state.json   進度快照（斷點續跑 / 狀態查詢用）

斷點續跑 = 增量的特例：已在 clip_ids.json 的 id 一律跳過，
每 flush_every 張落盤一次（tmp + os.replace 原子寫），中斷後重跑即接續。

item 來源：
    Eagle  lib：LIBRARY_PATHS + data/{lib}/urls_data.json 的 thumb 欄位
                （thumb 缺失時退回 file 欄位，僅限 image；影片吃 Eagle 現成
                  {name}_thumbnail.png 首幀，抽多幀留待後續批次）
    Excire lib：EXCIRE_PATHS + excire.py thumb_path()（480px 現成縮圖直取）
"""
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import _VIEWER_DIR  # noqa: F401
from config import DATA_DIR, EXCIRE_PATHS, LIBRARY_PATHS
from .model_setup import EMBED_DIM, MODEL_NAME
from .clip_engine import get_engine


def ai_index_dir(lib: str) -> Path:
    return DATA_DIR / lib / "ai_index"


# ---------------------------------------------------------------------------
# item 列舉（id → 縮圖絕對路徑）
# ---------------------------------------------------------------------------

def _iter_eagle_items(lib: str) -> list:
    """讀 data/{lib}/urls_data.json → [(item_id, thumb_abs_path), ...]。"""
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
        # thumb 優先（影片亦有 Eagle 現成首幀縮圖）；缺 thumb 時退回原圖（僅 image）
        rel = it.get("thumb")
        if not rel and it.get("media_type") == "image":
            rel = it.get("file")
        if not rel or not rel.startswith(prefix):
            continue
        out.append((iid, lib_path / "images" / rel[len(prefix):]))
    return out


def _iter_excire_items(lib: str) -> list:
    """Excire 庫：photo_info 全量 id + thumbnails.exfoto 480px 縮圖。"""
    from excire import get_excire_library
    exlib = get_excire_library(lib)
    if exlib is None or not exlib.available:
        raise RuntimeError(f"Excire 庫不可用：{lib}")
    rows = exlib._q_local("SELECT Id FROM photo_info ORDER BY Id")
    out = []
    for r in rows:
        pid = r["Id"]
        tp = exlib.thumb_path(pid)
        if tp is not None:
            out.append((f"excire_{pid}", tp))
    return out


def list_items(lib: str) -> list:
    """→ [(item_id, thumb_abs_path), ...]；lib 可為 Eagle 或 Excire 庫名。"""
    if lib in LIBRARY_PATHS:
        return _iter_eagle_items(lib)
    if lib in EXCIRE_PATHS:
        return _iter_excire_items(lib)
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


def load_index(lib: str):
    """→ (vectors float32 (N,512), ids list[str])；無索引 → (None, [])。"""
    d = ai_index_dir(lib)
    vec_f, ids_f = d / "clip_vectors.npy", d / "clip_ids.json"
    if not vec_f.exists() or not ids_f.exists():
        return None, []
    vecs = _load_npy_cached(vec_f)
    ids = json.loads(ids_f.read_text(encoding="utf-8"))
    if vecs.shape[0] != len(ids):        # 不同步（寫入中斷）→ 取交集長度保守處理
        n = min(vecs.shape[0], len(ids))
        vecs, ids = vecs[:n], ids[:n]
    return vecs, ids


def _save_index(d: Path, vecs: np.ndarray, ids: list) -> None:
    """tmp + os.replace 原子寫。先寫 npy 再寫 ids：中斷時 vecs ≥ ids，
    load_index 取交集長度仍一致。"""
    d.mkdir(parents=True, exist_ok=True)
    tmp_npy = d / "clip_vectors.tmp.npy"
    with open(tmp_npy, "wb") as f:      # 傳 file object，np.save 不會擅自加副檔名
        np.save(f, vecs)
    os.replace(tmp_npy, d / "clip_vectors.npy")
    tmp = d / "clip_ids.json.tmp"
    tmp.write_text(json.dumps(ids, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, d / "clip_ids.json")


def _save_state(d: Path, state: dict) -> None:
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "index_state.json.tmp"
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, d / "index_state.json")


def _save_meta(d: Path, count: int, extra: dict = None) -> None:
    meta = {
        "model": MODEL_NAME,
        "dim": EMBED_DIM,
        "count": count,
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if extra:
        meta.update(extra)
    tmp = d / "meta.json.tmp"
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, d / "meta.json")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def build_index(lib: str, limit: int = None, batch_size: int = 16,
                flush_every: int = 256, throttle: float = 0.0,
                progress_cb=None) -> dict:
    """建立 / 增量更新 lib 的語意索引。

    Args:
        limit:       本次最多新索引 N 張（小樣本驗證用）；None = 全量
        flush_every: 每 N 張落盤一次（斷點續跑粒度）
        throttle:    每批次間 sleep 秒數（避免搶佔 server CPU）
        progress_cb: callable(done, total) 進度回呼

    Returns:
        {lib, indexed, skipped, failed, total, elapsed_s}
    """
    d = ai_index_dir(lib)
    engine = get_engine()

    all_items = list_items(lib)
    old_vecs, ids = load_index(lib)
    vec_list = [np.array(old_vecs)] if old_vecs is not None and len(ids) else []
    done_set = set(ids)

    todo = [(iid, p) for iid, p in all_items if iid not in done_set]
    if limit is not None:
        todo = todo[:limit]

    t0 = time.time()
    n_new, n_failed = 0, 0
    pending_vecs, pending_ids = [], []

    def _flush(final: bool = False):
        nonlocal vec_list, ids
        if pending_vecs:
            vec_list.append(np.concatenate(pending_vecs, axis=0))
            ids = ids + pending_ids
            pending_vecs.clear()
            pending_ids.clear()
        if vec_list:
            merged = np.concatenate(vec_list, axis=0) if len(vec_list) > 1 \
                else vec_list[0]
            vec_list = [merged]
            _save_index(d, merged.astype(np.float32), ids)
        _save_state(d, {
            "lib": lib, "status": "done" if final else "running",
            "indexed": len(ids), "todo_total": len(todo), "todo_done": n_new + n_failed,
            "failed": n_failed, "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        })

    for start in range(0, len(todo), flush_every):
        chunk = todo[start:start + flush_every]
        paths = [p for _, p in chunk]
        vecs, failed = engine.encode_images(paths, batch_size=batch_size)
        failed_set = set(failed)
        ok_ids = [iid for j, (iid, _) in enumerate(chunk) if j not in failed_set]
        if len(ok_ids):
            pending_vecs.append(vecs)
            pending_ids.extend(ok_ids)
        n_new += len(ok_ids)
        n_failed += len(failed)
        _flush()
        if progress_cb:
            progress_cb(n_new + n_failed, len(todo))
        if throttle:
            time.sleep(throttle)

    elapsed = time.time() - t0
    _flush(final=True)
    _save_meta(d, len(ids), {
        "lib": lib, "source": "eagle" if lib in LIBRARY_PATHS else "excire",
        "last_run": {"new": n_new, "failed": n_failed, "elapsed_s": round(elapsed, 1),
                     "limit": limit},
    })
    return {"lib": lib, "indexed": n_new, "skipped": len(done_set),
            "failed": n_failed, "total": len(all_items), "elapsed_s": round(elapsed, 1)}
