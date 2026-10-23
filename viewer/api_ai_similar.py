"""GET /api/ai/similar — image-to-image 相似搜尋（P4-B6）。

item 的 CLIP 向量已在 clip_vectors.npy 索引內 → 直接取列做 cosine（內積），
免重新編碼、免 onnxruntime 文字塔；未索引項回 400 明確訊息。
純 numpy 讀取，dispatch 由 api_ai.handle_ai_get 掛接。
"""
from config import EXCIRE_PATHS, LIBRARY_PATHS


def handle_similar(h):
    from api_ai import _int_param, _known_libs, _params, _resolve_hits

    p = _params(h)
    lib, item = p.get("lib", ""), p.get("item", "")
    if not lib or not item:
        h._err(400, "缺少 ?lib= 或 ?item= 參數"); return
    if lib not in LIBRARY_PATHS and lib not in EXCIRE_PATHS:
        h._err(404, f"未知的庫：{lib}（可用：{_known_libs()}）"); return
    ok, topk = _int_param(p, "topk", 40, 1, 200)
    if not ok:
        h._err(400, "topk 需為整數"); return
    all_libs = p.get("all", "") in ("1", "true", "yes")

    try:
        import numpy as np
        from ai import search as _s
        from ai.indexer import load_index
    except Exception as e:
        h._json(503, {"ok": False, "error": f"AI 模組載入失敗（numpy？）：{e}"}); return

    vecs, ids = load_index(lib)
    if vecs is None or not len(ids):
        h._json(400, {"ok": False, "error":
                      f"庫 {lib} 尚無語意索引；請先建立索引（POST /api/ai/index）"}); return
    try:
        qi = ids.index(item)
    except ValueError:
        h._json(400, {"ok": False, "error":
                      f"項目 {item} 尚未建立語意索引（新項目請先重建索引再找相似圖）"}); return
    q = np.asarray(vecs[qi], dtype=np.float32)

    try:
        if all_libs:
            hits = []
            for lb in _s.list_indexed_libs():
                for hit in _s.search(lb, "", topk=topk + 1, query_vec=q):
                    hit["lib"] = lb
                    hits.append(hit)
            hits.sort(key=lambda x: -x["score"])
        else:
            hits = [{**hit, "lib": lib}
                    for hit in _s.search(lib, "", topk=topk + 1, query_vec=q)]
    except RuntimeError as e:
        h._json(400, {"ok": False, "error": str(e)}); return

    hits = [x for x in hits if not (x["lib"] == lib and x["id"] == item)][:topk]
    _resolve_hits(hits)
    h._json(200, {"ok": True, "lib": lib, "item": item, "topk": topk,
                  "count": len(hits), "hits": hits})
