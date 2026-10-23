"""以臉找臉：ArcFace embedding cosine top-k（numpy 暴力，10 萬臉級 <100ms）。

同人參考閾值：cosine ≥ 0.4（buffalo_l／ArcFace 常用經驗值；跨光照/年齡再放寬）。
"""
import numpy as np

from . import _VIEWER_DIR  # noqa: F401
from config import EXCIRE_PATHS, LIBRARY_PATHS
from .face_indexer import ai_index_dir, load_face_index

SAME_PERSON_THRESH = 0.4    # 參考值：>= 0.4 高機率同人


def list_face_indexed_libs() -> list:
    """所有已建立人臉索引的庫名。"""
    out = []
    for name in sorted(LIBRARY_PATHS) + sorted(EXCIRE_PATHS):
        if (ai_index_dir(name) / "faces.npy").exists():
            out.append(name)
    return out


def item_faces(lib: str, item_id: str) -> list:
    """某 item 的所有已索引臉 → [{face_idx, bbox, det_score}, ...]（det_score 降冪）。"""
    _, meta = load_face_index(lib)
    out = [{"face_idx": i, "bbox": m["bbox"], "det_score": m["det_score"]}
           for i, m in enumerate(meta) if m["id"] == item_id]
    out.sort(key=lambda f: -f["det_score"])
    return out


def face_embedding(lib: str, face_idx: int) -> np.ndarray:
    """faces.npy 第 face_idx 列 → (512,) float32。"""
    vecs, meta = load_face_index(lib)
    if vecs is None or not (0 <= face_idx < len(meta)):
        raise RuntimeError(f"庫 {lib} 無 face_idx={face_idx} 的人臉")
    return np.asarray(vecs[face_idx], dtype=np.float32)


def search_face(lib: str, query_vec: np.ndarray, topk: int = 10,
                exclude_face_idx: int = None, exclude_item: str = None) -> list:
    """單庫以臉找臉 → [{face_idx, id, score, det_score, bbox}, ...]（score 降冪）。

    Args:
        query_vec:        (512,) L2-normalized ArcFace embedding
        exclude_face_idx: 排除查詢臉本身
        exclude_item:     排除查詢臉所屬 item 的所有臉（同圖多偵測框去噪）
    """
    vecs, meta = load_face_index(lib)
    if vecs is None or not len(meta):
        raise RuntimeError(f"庫 {lib} 尚無人臉索引；請先執行 face-index --lib \"{lib}\"")
    scores = np.asarray(vecs) @ query_vec.astype(np.float32)
    if exclude_face_idx is not None and 0 <= exclude_face_idx < len(scores):
        scores[exclude_face_idx] = -2.0
    if exclude_item is not None:
        for i, m in enumerate(meta):
            if m["id"] == exclude_item:
                scores[i] = -2.0
    k = min(topk, len(meta))
    top = np.argpartition(-scores, k - 1)[:k]
    top = top[np.argsort(-scores[top])]
    return [{"face_idx": int(i), "id": meta[i]["id"], "score": float(scores[i]),
             "det_score": meta[i]["det_score"], "bbox": meta[i]["bbox"]}
            for i in top if scores[i] > -2.0]


def search_face_all(query_vec: np.ndarray, topk: int = 10,
                    exclude: tuple = None) -> list:
    """跨庫以臉找臉 → [{lib, face_idx, id, score, ...}, ...] 全域 top-k。

    Args:
        exclude: (lib, face_idx) 查詢臉本身（僅於該庫排除）。
    """
    libs = list_face_indexed_libs()
    if not libs:
        raise RuntimeError("尚無任何庫建立人臉索引")
    merged = []
    for lib in libs:
        ex_idx = exclude[1] if exclude and exclude[0] == lib else None
        for hit in search_face(lib, query_vec, topk=topk, exclude_face_idx=ex_idx):
            hit["lib"] = lib
            merged.append(hit)
    merged.sort(key=lambda h: -h["score"])
    return merged[:topk]


def search_by_item(lib: str, item_id: str, face_idx: int = None,
                   topk: int = 10, all_libs: bool = False) -> dict:
    """以 item 的某張臉為查詢（未指定 face_idx → 取該 item det_score 最高的臉）。

    Returns:
        {query: {face_idx, bbox, det_score, n_faces_in_item}, hits: [...]}
    """
    faces = item_faces(lib, item_id)
    if not faces:
        raise RuntimeError(f"item {item_id} 在庫 {lib} 的人臉索引中沒有臉"
                           f"（未偵測到或尚未索引）")
    if face_idx is None:
        q = faces[0]
    else:
        match = [f for f in faces if f["face_idx"] == face_idx]
        if not match:
            raise RuntimeError(f"item {item_id} 無 face_idx={face_idx}；"
                               f"可用：{[f['face_idx'] for f in faces]}")
        q = match[0]
    qvec = face_embedding(lib, q["face_idx"])
    if all_libs:
        hits = search_face_all(qvec, topk=topk, exclude=(lib, q["face_idx"]))
    else:
        hits = [{**h, "lib": lib} for h in
                search_face(lib, qvec, topk=topk, exclude_face_idx=q["face_idx"])]
    return {"query": {**q, "n_faces_in_item": len(faces), "lib": lib, "id": item_id},
            "hits": hits}
