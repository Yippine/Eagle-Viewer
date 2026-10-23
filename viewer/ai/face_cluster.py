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
import threading
from datetime import datetime, timezone

import numpy as np

from . import _VIEWER_DIR  # noqa: F401
from .face_setup import FACE_MODEL_NAME
from .face_indexer import ai_index_dir, load_face_index

DEFAULT_EPS         = 0.45   # cosine distance（1 - cosine sim）；研究報告建議 0.4–0.5
DEFAULT_MIN_SAMPLES = 2

# B4 超級簇拆分：DBSCAN 傳遞閉包在同校服/同場景大庫上會把不同人鏈成一簇
# （TSJH p0009 = 77,759 臉）。臉數 > SPLIT_THRESHOLD 的簇以更嚴 eps 做簇內
# 二次 DBSCAN，仍超標則逐步收緊 eps 再拆（至 SPLIT_EPS_MIN 為止）。
SPLIT_THRESHOLD = 5000
SPLIT_EPS_START = 0.35
SPLIT_EPS_MIN   = 0.25
SPLIT_EPS_STEP  = 0.05


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


def split_large_clusters(vecs: np.ndarray, labels: np.ndarray,
                         threshold: int = SPLIT_THRESHOLD,
                         eps_start: float = SPLIT_EPS_START,
                         eps_min: float = SPLIT_EPS_MIN,
                         eps_step: float = SPLIT_EPS_STEP,
                         min_samples: int = DEFAULT_MIN_SAMPLES):
    """超級簇拆分（B4）：臉數 > threshold 的簇做簇內更嚴 eps 二次 DBSCAN。

    仍超標的簇於下一輪以 eps - eps_step 續拆，直到無超標簇或 eps < eps_min。
    二次聚類的 sub-noise 臉轉為全域 noise（-1）；若某簇在嚴 eps 下完全拆不出
    core（極端情形），保持原簇不動（不把整簇打成 noise）。

    Returns:
        (labels, report)：labels 為拆分後標籤（原簇號保留給第一個子簇，
        新子簇接續在最大簇號之後）；report = [{cluster, size, eps,
        sub_clusters, sub_noise}, ...]
    """
    labels = labels.copy()
    report = []
    eps = eps_start
    while eps >= eps_min - 1e-9:
        sizes = np.bincount(labels[labels >= 0]) if (labels >= 0).any() else np.zeros(0, int)
        big = [c for c in range(len(sizes)) if sizes[c] > threshold]
        if not big:
            break
        next_label = int(labels.max()) + 1
        for c in big:
            idx = np.where(labels == c)[0]
            sub = dbscan_cosine(vecs[idx], eps=eps, min_samples=min_samples)
            n_sub = int(sub.max()) + 1 if sub.max() >= 0 else 0
            if n_sub == 0:                       # 全 sub-noise → 保持原簇（防呆）
                report.append({"cluster": int(c), "size": int(len(idx)),
                               "eps": round(eps, 3), "sub_clusters": 0,
                               "sub_noise": 0, "kept": True})
                continue
            for s in range(1, n_sub):            # 子簇 0 沿用原簇號 c
                labels[idx[sub == s]] = next_label
                next_label += 1
            labels[idx[sub == -1]] = -1
            report.append({"cluster": int(c), "size": int(len(idx)),
                           "eps": round(eps, 3), "sub_clusters": n_sub,
                           "sub_noise": int((sub == -1).sum())})
        eps -= eps_step
    return labels, report


def _compact_labels(labels: np.ndarray) -> np.ndarray:
    """拆分防呆後可能出現空簇號 → 壓實為連續 0..k-1（noise -1 不動）。"""
    uniq = np.unique(labels[labels >= 0])
    remap = {int(c): i for i, c in enumerate(uniq)}
    out = labels.copy()
    for c, i in remap.items():
        if c != i:
            out[labels == c] = i
    return out


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
                   name_match_thresh: float = 0.6,
                   split_threshold: int = SPLIT_THRESHOLD,
                   split_eps: float = SPLIT_EPS_START,
                   split_eps_min: float = SPLIT_EPS_MIN) -> dict:
    """聚類 lib 的人臉索引 → persons.json。重跑安全（embedding 不重算）。

    split_threshold > 0 時啟用超級簇拆分（B4）；設 0 / None 可停用。
    命名保留（centroid cosine ≥ name_match_thresh）於拆分後的最終簇上匹配，
    故拆分不影響保名機制（同名可能掛上多個子簇，屬預期語意）。

    Returns:
        {lib, n_faces, n_persons, noise, top_sizes, split[, elapsed 由 CLI 計]}
    """
    d = ai_index_dir(lib)
    vecs, meta = load_face_index(lib)
    if vecs is None or not len(meta):
        raise RuntimeError(f"庫 {lib} 尚無人臉索引；請先執行 face-index --lib \"{lib}\"")
    vecs = np.asarray(vecs, dtype=np.float32)

    persons_file = d / "persons.json"
    old_names = _load_old_names(persons_file)

    labels = dbscan_cosine(vecs, eps=eps, min_samples=min_samples)
    split_report = []
    if split_threshold:
        labels, split_report = split_large_clusters(
            vecs, labels, threshold=split_threshold,
            eps_start=split_eps, eps_min=split_eps_min,
            min_samples=min_samples)
        if split_report:
            labels = _compact_labels(labels)
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
        "split_threshold": split_threshold or 0,
        "split_report": split_report,
        "n_faces": int(len(meta)),
        "clustered_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "persons": persons,
        "noise_count": int((labels == -1).sum()),
    }
    tmp = d / "persons.json.tmp"
    tmp.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, persons_file)

    # 輕量 sidecar：/api/ai/status 輪詢只需人數統計，避免熱路徑整檔解析
    # persons.json（TSJH 級 400MB、秒級 parse，輪詢會堆積 handler 執行緒）
    summary = {"n_persons": len(persons), "noise_count": out["noise_count"],
               "n_faces": out["n_faces"], "clustered_at": out["clustered_at"]}
    tmp = d / "persons_summary.json.tmp"
    tmp.write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, d / "persons_summary.json")

    return {
        "lib": lib,
        "n_faces": len(meta),
        "n_persons": len(persons),
        "noise": out["noise_count"],
        "top_sizes": [p["count"] for p in persons[:5]],
        "split": split_report,
    }


def load_persons(lib: str) -> dict:
    """讀取 persons.json；不存在 → {}。"""
    f = ai_index_dir(lib) / "persons.json"
    if not f.exists():
        return {}
    return json.loads(f.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# 人物命名（B1）：persons.json 的 name 欄即人工命名儲存層
# ---------------------------------------------------------------------------

_persons_write_lock = threading.Lock()   # rename 讀改寫互斥（單一 server process）


def set_person_name(lib: str, person_id: str, name):
    """設定 / 清除某人物簇的顯示名（name=None 即清除）→ 原子寫回 persons.json。

    name 是使用者層的穩定命名：重聚類後 build_clusters 以「舊簇 centroid 與
    新簇 centroid cosine ≥ 0.6」把名字重新掛回（見模組 docstring）；person_id
    僅為當次聚類的底層把手，保持機器產生、不受命名影響。

    Returns:
        {lib, person_id, name, count}

    Raises:
        RuntimeError: 尚未聚類 / 找不到該 person_id。
    """
    d = ai_index_dir(lib)
    f = d / "persons.json"
    if not f.exists():
        raise RuntimeError(f"庫 {lib} 尚未聚類（無 persons.json）；請先執行人臉索引與聚類")
    with _persons_write_lock:
        data = json.loads(f.read_text(encoding="utf-8"))
        target = next((p for p in data.get("persons", [])
                       if p.get("person_id") == person_id), None)
        if target is None:
            raise RuntimeError(f"找不到人物：{person_id}")
        target["name"] = name
        tmp = d / "persons.json.tmp"
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, f)
    return {"lib": lib, "person_id": person_id, "name": name,
            "count": target.get("count", 0)}
