"""人物聚類：faces.npy 上跑 DBSCAN（cosine distance，純 numpy）→ persons.json。

重跑聚類不重算 embedding：只讀 faces.npy / faces_meta.json 重新分簇。
既有 persons.json 內的人工命名（name != null）在重聚類後以「舊簇 centroid
與新簇 centroid 的 cosine ≥ 0.6」重新掛回。

persons.json 結構：
    {
      "model": ..., "eps": ..., "min_samples": ..., "n_faces": M,
      "clustered_at": ...,
      "persons": [{"person_id": "p0000", "name": null|str,
                   "face_indices": [...],        # faces.npy 列索引
                   "rep_face": idx,              # 代表臉（最接近 centroid）
                   "count": N, "items": [item_id...],
                   "centroid": [512 floats]}],   # 重聚類時命名對齊用
      "noise_count": X                            # 未成簇（單張臉）數
    }
"""
import json
import os
from datetime import datetime, timezone

import numpy as np

from . import _VIEWER_DIR  # noqa: F401
from .face_setup import FACE_MODEL_NAME
from .face_indexer import ai_index_dir, load_face_index

DEFAULT_EPS         = 0.45   # cosine distance（1 - cosine sim）；研究報告建議 0.4–0.5
DEFAULT_MIN_SAMPLES = 2


def _neighbor_lists(vecs: np.ndarray, eps: float, chunk: int = 1024) -> list:
    """分塊算 cosine 鄰居表（避免 O(n²) 距離矩陣一次成形吃爆記憶體）。

    vecs 已 L2-normalized → cosine distance = 1 - vecs @ vecs.T。
    """
    n = len(vecs)
    sim_thresh = 1.0 - eps
    nbrs = []
    for s in range(0, n, chunk):
        sims = vecs[s:s + chunk] @ vecs.T          # (chunk, n)
        for row in sims:
            nbrs.append(np.where(row >= sim_thresh)[0])
    return nbrs


def dbscan_cosine(vecs: np.ndarray, eps: float = DEFAULT_EPS,
                  min_samples: int = DEFAULT_MIN_SAMPLES) -> np.ndarray:
    """純 numpy DBSCAN。→ labels (n,) int，-1 = noise。"""
    n = len(vecs)
    labels = np.full(n, -1, dtype=np.int64)
    if n == 0:
        return labels
    nbrs = _neighbor_lists(vecs, eps)
    core = np.array([len(a) >= min_samples for a in nbrs])   # 鄰居含自身
    visited = np.zeros(n, dtype=bool)
    cid = 0
    for i in range(n):
        if visited[i] or not core[i]:
            continue
        visited[i] = True
        labels[i] = cid
        queue = [i]
        while queue:
            j = queue.pop()
            for k in nbrs[j]:
                if labels[k] == -1:
                    labels[k] = cid          # border point 掛入
                if core[k] and not visited[k]:
                    visited[k] = True
                    queue.append(int(k))
        cid += 1
    return labels


def _load_old_names(persons_file) -> list:
    """→ [(name, centroid ndarray), ...]（僅取有人工命名者）。"""
    if not persons_file.exists():
        return []
    try:
        data = json.loads(persons_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    out = []
    for p in data.get("persons", []):
        if p.get("name") and p.get("centroid"):
            out.append((p["name"], np.asarray(p["centroid"], dtype=np.float32)))
    return out


def build_clusters(lib: str, eps: float = DEFAULT_EPS,
                   min_samples: int = DEFAULT_MIN_SAMPLES,
                   name_match_thresh: float = 0.6) -> dict:
    """聚類 lib 的人臉索引 → persons.json。重跑安全（embedding 不重算）。

    Returns:
        {lib, n_faces, n_persons, noise, top_sizes, elapsed 由 CLI 計}
    """
    d = ai_index_dir(lib)
    vecs, meta = load_face_index(lib)
    if vecs is None or not len(meta):
        raise RuntimeError(f"庫 {lib} 尚無人臉索引；請先執行 face-index --lib \"{lib}\"")
    vecs = np.asarray(vecs, dtype=np.float32)

    persons_file = d / "persons.json"
    old_names = _load_old_names(persons_file)

    labels = dbscan_cosine(vecs, eps=eps, min_samples=min_samples)
    n_clusters = int(labels.max()) + 1 if labels.max() >= 0 else 0

    persons = []
    for c in range(n_clusters):
        idx = np.where(labels == c)[0]
        centroid = vecs[idx].mean(axis=0)
        centroid /= max(np.linalg.norm(centroid), 1e-12)
        rep = int(idx[np.argmax(vecs[idx] @ centroid)])          # 最接近 centroid 的臉
        name = None
        best = name_match_thresh
        for old_name, old_c in old_names:                        # 命名映射（重聚類保留）
            s = float(centroid @ old_c)
            if s >= best:
                best, name = s, old_name
        persons.append({
            "person_id": f"p{c:04d}",
            "name": name,
            "face_indices": idx.tolist(),
            "rep_face": rep,
            "count": int(len(idx)),
            "items": sorted({meta[i]["id"] for i in idx}),
            "centroid": [round(float(v), 6) for v in centroid],
        })
    persons.sort(key=lambda p: -p["count"])

    out = {
        "model": FACE_MODEL_NAME,
        "eps": eps,
        "min_samples": min_samples,
        "n_faces": int(len(meta)),
        "clustered_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "persons": persons,
        "noise_count": int((labels == -1).sum()),
    }
    tmp = d / "persons.json.tmp"
    tmp.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, persons_file)

    return {
        "lib": lib,
        "n_faces": len(meta),
        "n_persons": len(persons),
        "noise": out["noise_count"],
        "top_sizes": [p["count"] for p in persons[:5]],
    }


def load_persons(lib: str) -> dict:
    """讀取 persons.json；不存在 → {}。"""
    f = ai_index_dir(lib) / "persons.json"
    if not f.exists():
        return {}
    return json.loads(f.read_text(encoding="utf-8"))
