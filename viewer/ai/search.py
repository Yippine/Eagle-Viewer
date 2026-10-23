"""語意查詢：cosine 相似 top-k（numpy 暴力，10 萬級 <50ms）。

向量已 L2-normalized → cosine = 內積 = V @ q。
"""
import json

import numpy as np

from . import _VIEWER_DIR  # noqa: F401
from config import DATA_DIR, EXCIRE_PATHS, LIBRARY_PATHS
from .clip_engine import get_engine
from .indexer import ai_index_dir, load_index


def list_indexed_libs() -> list:
    """所有已建立 ai_index 的庫名。"""
    out = []
    for name in sorted(LIBRARY_PATHS) + sorted(EXCIRE_PATHS):
        if (ai_index_dir(name) / "clip_vectors.npy").exists():
            out.append(name)
    return out


def search(lib: str, query: str, topk: int = 10, query_vec=None) -> list:
    """單庫查詢 → [{id, score}, ...]（score 降冪）。

    query_vec 可傳入預先編碼的 (512,) 向量（跨庫查詢時免重複編碼）。
    """
    vecs, ids = load_index(lib)
    if vecs is None or not len(ids):
        raise RuntimeError(f"庫 {lib} 尚無語意索引；請先執行 index --lib \"{lib}\"")
    q = query_vec if query_vec is not None else get_engine().encode_text(query)
    scores = np.asarray(vecs) @ q.astype(np.float32)
    k = min(topk, len(ids))
    top = np.argpartition(-scores, k - 1)[:k]
    top = top[np.argsort(-scores[top])]
    return [{"id": ids[i], "score": float(scores[i])} for i in top]


def search_all(query: str, topk: int = 10) -> list:
    """跨庫查詢（所有已索引的庫）→ [{lib, id, score}, ...] 全域 top-k。"""
    libs = list_indexed_libs()
    if not libs:
        raise RuntimeError("尚無任何庫建立語意索引")
    q = get_engine().encode_text(query)
    merged = []
    for lib in libs:
        for hit in search(lib, query, topk=topk, query_vec=q):
            hit["lib"] = lib
            merged.append(hit)
    merged.sort(key=lambda h: -h["score"])
    return merged[:topk]


# ---------------------------------------------------------------------------
# 結果解讀輔助（id → 名稱 / 資料夾，人工驗證與 CLI 顯示用）
# ---------------------------------------------------------------------------

def resolve_items(lib: str, item_ids: list) -> dict:
    """→ {item_id: {name, folders, media_type}}；查不到的 id 不在結果中。"""
    wanted = set(item_ids)
    out = {}
    if lib in LIBRARY_PATHS:
        data_file = DATA_DIR / lib / "urls_data.json"
        if data_file.exists():
            for it in json.loads(data_file.read_text(encoding="utf-8")).get("items", []):
                if it.get("id") in wanted:
                    out[it["id"]] = {
                        "name": it.get("name", ""),
                        "folders": it.get("folders", []),
                        "media_type": it.get("media_type", ""),
                    }
    elif lib in EXCIRE_PATHS:
        from excire import get_excire_library
        exlib = get_excire_library(lib)
        if exlib is not None and exlib.available:
            fmap = exlib._folder_map()
            for iid in wanted:
                try:
                    pid = int(str(iid).replace("excire_", ""))
                except ValueError:
                    continue
                row = exlib._photo_row(pid)
                if row is None:
                    continue
                folder = fmap.get(row["collectionId"])
                out[iid] = {
                    "name": row["Filename"] or "",
                    "folders": [folder["rel"]] if folder else [],
                    "media_type": "image",
                }
    return out
