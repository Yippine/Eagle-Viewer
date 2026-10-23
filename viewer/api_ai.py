"""AI 搜尋 API（P6-I2a）：語意搜尋 / 人臉搜尋 / 背景索引任務。

端點（serve.py dispatch 掛接 /api/ai/*）：
    GET  /api/ai/status              各庫 clip/faces 索引狀態 + 模型/引擎就緒度
    GET  /api/ai/search              ?q=...[&lib=...][&topk=40] 語意搜尋（lib 省略＝跨庫）
    GET  /api/ai/similar             ?lib=...&item=...[&topk=40][&all=1] 以圖找圖
    GET  /api/ai/faces/persons       ?lib=... 人物聚類清單（person_id/name/性別/年齡/代表臉）
    GET  /api/ai/faces/search        ?lib=...&item=...[&face=N][&topk=40][&all=1] 以臉找臉
    GET  /api/ai/tags                ?lib=... 人數/場景/運動標籤（B5；scene_tags.json）
    GET  /api/ai/expressions         ?lib=... 表情標籤（B6；item_expressions.json）
    GET  /api/ai/clothing            ?lib=... 服裝標籤（粗類；clothing_tags.json）
    POST /api/ai/faces/persons/name  {lib, person_id, name|null} 人物命名/清除（B1）
    POST /api/ai/index               {lib: 庫名|"all", kind: clip|faces|both|
                                      video-faces|tags|expressions|clothing|advanced[, limit]}
                                     背景索引；video-faces = 影片多幀人臉（B3）；
                                     tags = B5 標籤；expressions = B6 臉部表情；
                                     clothing = 服裝粗類；advanced = tags+expressions+clothing
                                     （limit = 最多新處理 N item/臉）
    GET  /api/ai/index/progress      索引進度輪詢（SSE 備援）

設計：
    - 引擎懶載入：首次 /api/ai/search 觸發背景載入 text 塔（含預熱），載入中回 202；
      onnxruntime 未裝或模型檔未下載回 503（明確訊息，不在請求執行緒下載模型）。
    - 索引為單一背景 worker：重複 POST 回 409 already_running；進度經 SSE bus
      （type=ai-index-progress，訂閱 /api/events?lib=...）推播，
      GET /api/ai/index/progress 供輪詢備援。onnxruntime session 建立集中在
      _engine_init_lock 內（session.run 本身 thread-safe）。
    - 人臉搜尋/人物清單只讀既有向量檔（純 numpy），不需載入 ONNX 模型。
    - ai.* 模組（依賴 numpy）一律於 handler 內 lazy import：依賴缺失回 503，
      不影響 server 其餘功能啟動。
"""
import importlib.util
import json
import threading
from datetime import datetime, timezone
from urllib.parse import parse_qs, unquote

from config import DATA_DIR, EXCIRE_PATHS, LIBRARY_PATHS
from api_helpers import _sse_broadcast

# ---------------------------------------------------------------------------
# 共用小工具
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _params(h) -> dict:
    """query string → {key: value}（取每鍵第一值，對齊 api_routes 慣例）。"""
    qs = h.path.split("?", 1)[1] if "?" in h.path else ""
    return {k: unquote(v[0]).strip() for k, v in parse_qs(qs).items()}


def _int_param(p: dict, key: str, default: int, lo: int, hi: int):
    """→ (ok, value)；非整數 → (False, None)。"""
    raw = p.get(key, "")
    if raw in ("", None):
        return True, default
    try:
        return True, max(lo, min(int(raw), hi))
    except ValueError:
        return False, None


def _known_libs() -> list:
    return sorted(LIBRARY_PATHS) + sorted(EXCIRE_PATHS)


def _ort_available() -> bool:
    return importlib.util.find_spec("onnxruntime") is not None


# ---------------------------------------------------------------------------
# item 解析（id → name/folders/thumb），搜尋結果統一描述用
# ---------------------------------------------------------------------------

_items_cache: dict = {}       # lib → ((mtime_ns, size), {id: lite dict})
_items_cache_lock = threading.Lock()


def _eagle_items_map(lib: str) -> dict:
    """data/{lib}/urls_data.json → {id: {name, folders, media_type, thumb}}（mtime 快取）。"""
    f = DATA_DIR / lib / "urls_data.json"
    if not f.exists():
        return {}
    st = f.stat()
    key = (st.st_mtime_ns, st.st_size)
    with _items_cache_lock:
        cached = _items_cache.get(lib)
        if cached and cached[0] == key:
            return cached[1]
    m = {}
    try:
        items = json.loads(f.read_text(encoding="utf-8")).get("items", [])
    except Exception:
        return {}
    for it in items:
        iid = it.get("id")
        if not iid:
            continue
        rel = it.get("thumb") or it.get("file")
        m[iid] = {
            "name":       it.get("name", ""),
            "folders":    it.get("folders", []),
            "media_type": it.get("media_type", ""),
            "thumb":      ("/" + rel) if rel else None,
        }
    with _items_cache_lock:
        _items_cache[lib] = (key, m)
    return m


def _excire_resolver(lib: str):
    """→ callable(item_id) → lite dict | None（庫不可用時恆回 None）。"""
    try:
        from excire import get_excire_library
        exlib = get_excire_library(lib)
        if exlib is None or not exlib.available:
            return lambda iid: None
        fmap = exlib._folder_map()
    except Exception:
        return lambda iid: None

    def _resolve(iid):
        try:
            pid = int(str(iid).replace("excire_", ""))
        except ValueError:
            return None
        try:
            row = exlib._photo_row(pid)
        except Exception:
            return None
        if row is None:
            return None
        folder = fmap.get(row["collectionId"])
        return {
            "name":       row["Filename"] or "",
            "folders":    [folder["rel"]] if folder else [],
            "media_type": "image",
            "thumb":      f"/excire-thumb/{lib}/{pid}",
        }
    return _resolve


def _resolve_item(lib: str, iid: str, ex_cache: dict) -> dict:
    """→ {source, name?, folders?, media_type?, thumb?}。"""
    if lib in LIBRARY_PATHS:
        base = {"source": "eagle"}
        it = _eagle_items_map(lib).get(iid)
        if it:
            base.update(it)
        return base
    if lib in EXCIRE_PATHS:
        base = {"source": "excire"}
        if lib not in ex_cache:
            ex_cache[lib] = _excire_resolver(lib)
        info = ex_cache[lib](iid)
        if info:
            base.update(info)
        return base
    return {"source": "unknown"}


def _resolve_hits(hits: list) -> None:
    """就地為 hits（需含 lib/id）附上 source/name/folders/media_type/thumb。"""
    ex_cache: dict = {}
    for hit in hits:
        hit.update(_resolve_item(hit.get("lib", ""), hit.get("id", ""), ex_cache))


# ---------------------------------------------------------------------------
# CLIP 文字引擎懶載入（onnxruntime session 單例 + lock）
# ---------------------------------------------------------------------------

_load_lock = threading.Lock()          # _clip_text_state 讀寫
_engine_init_lock = threading.Lock()   # onnxruntime session 建立（run 本身 thread-safe）
_clip_text_state = {"status": "unloaded", "error": None}   # unloaded|loading|ready|error


def _load_clip_text():
    """背景執行緒：載入 tokenizer + text.onnx session 並預熱一次。"""
    try:
        with _engine_init_lock:
            from ai.clip_engine import get_engine
            eng = get_engine()
            _ = eng.tokenizer
            _ = eng.text
        eng.encode_text("預熱")        # 冷啟 ~2.4s 於此吃掉，ready 後查詢 <100ms
        with _load_lock:
            _clip_text_state.update(status="ready", error=None)
    except Exception as e:
        with _load_lock:
            _clip_text_state.update(status="error", error=str(e)[:300])


def _clip_text_readiness():
    """→ (ready, http_status, payload)。未 ready 時 payload 可直接回傳。"""
    if not _ort_available():
        return False, 503, {
            "ok": False, "status": "unavailable",
            "error": "onnxruntime 未安裝，AI 語意搜尋無法使用。"
                     "安裝：pip install --user onnxruntime",
        }
    try:
        from ai.model_setup import MODEL_DIR, MODEL_FILES, _verify
    except Exception as e:
        return False, 503, {"ok": False, "status": "unavailable",
                            "error": f"AI 模組載入失敗：{e}"}
    missing = [f for f, spec in MODEL_FILES.items()
               if not _verify(MODEL_DIR / f, spec, check_hash=False)]
    if missing:
        return False, 503, {
            "ok": False, "status": "model_missing", "missing": missing,
            "error": "CLIP 模型檔未就緒（缺 " + ", ".join(missing) +
                     "）；請先執行 python3 -m viewer.ai.cli setup",
        }
    with _load_lock:
        st = _clip_text_state["status"]
        if st == "ready":
            return True, 200, None
        if st == "error":
            return False, 503, {"ok": False, "status": "error",
                                "error": f"CLIP 引擎載入失敗：{_clip_text_state['error']}"}
        if st == "unloaded":
            _clip_text_state["status"] = "loading"
            threading.Thread(target=_load_clip_text, daemon=True).start()
    return False, 202, {"ok": False, "status": "loading",
                        "message": "CLIP 文字模型載入中（首次約需數秒），請稍後重試"}


# ---------------------------------------------------------------------------
# GET /api/ai/status
# ---------------------------------------------------------------------------

_state_cache: dict = {}        # (kind, lib) → (mtime_ns, dict)　輪詢每 3 秒但檔案不常變
_state_cache_lock = threading.Lock()


def _cached_json_state(path, cache_key: tuple, fields: tuple):
    """mtime 不變回快取；避免 tags/clothing 狀態被每 3 秒輪詢重複整檔 json.load。"""
    try:
        if not path.exists():
            return None
        mt = path.stat().st_mtime_ns
        with _state_cache_lock:
            cached = _state_cache.get(cache_key)
            if cached and cached[0] == mt:
                return cached[1]
        data = json.loads(path.read_text(encoding="utf-8"))
        result = {k: data.get(k) for k in fields}
        with _state_cache_lock:
            _state_cache[cache_key] = (mt, result)
        return result
    except Exception:
        return None


def _clothing_ai_status(lib: str) -> dict:
    f = DATA_DIR / lib / "ai_index" / "clothing_state.json"
    s = _cached_json_state(f, ("clothing", lib),
                           ("status", "todo_done", "todo_total", "algo_version", "updated_at"))
    if s is None:
        return {"built": False, "todo_done": 0, "todo_total": 0}
    return {"built": s.get("status") == "done", **s}


def _tags_ai_status(lib: str) -> dict:
    """B5 標籤（scene_tags.json）：無累進 sidecar，僅終態；scene_tags.json 可能較大，
    只用 os.path.exists + mtime 判斷有無/建立時間，禁止整檔 json.load（見 spec S3）。"""
    f = DATA_DIR / lib / "ai_index" / "scene_tags.json"
    try:
        if not f.exists():
            return {"built": False}
        mt = f.stat().st_mtime
        built_at = datetime.fromtimestamp(mt, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return {"built": True, "built_at": built_at}
    except Exception:
        return {"built": False}


def _lib_ai_status(lib: str) -> dict:
    d = DATA_DIR / lib / "ai_index"
    clip = {"indexed": 0}
    try:
        f = d / "clip_ids.json"
        if f.exists():
            clip["indexed"] = len(json.loads(f.read_text(encoding="utf-8")))
        mf = d / "meta.json"
        if mf.exists():
            m = json.loads(mf.read_text(encoding="utf-8"))
            clip["updated_at"] = m.get("updated_at")
    except Exception:
        pass
    faces = {"faces": 0, "items_done": 0}
    try:
        sf = d / "faces_state.json"
        if sf.exists():
            s = json.loads(sf.read_text(encoding="utf-8"))
            faces["faces"] = s.get("faces", 0)
            faces["items_done"] = len(s.get("done_items", []))
            faces["updated_at"] = s.get("updated_at")
    except Exception:
        pass
    persons = None
    try:
        sf = d / "persons_summary.json"       # 輕量 sidecar 優先（見 face_cluster）
        pf = d / "persons.json"
        if sf.exists():
            pd = json.loads(sf.read_text(encoding="utf-8"))
            persons = {"n_persons": pd.get("n_persons"),
                       "noise": pd.get("noise_count"),
                       "clustered_at": pd.get("clustered_at")}
        elif pf.exists():                     # 舊庫相容：重聚類後自動產 sidecar
            pd = json.loads(pf.read_text(encoding="utf-8"))
            persons = {"n_persons": len(pd.get("persons", [])),
                       "noise": pd.get("noise_count"),
                       "clustered_at": pd.get("clustered_at")}
    except Exception:
        pass
    expr = None
    try:
        ef = d / "face_expr_state.json"       # B6 輕量 sidecar（勿 parse 臉層級大檔）
        if ef.exists():
            s = json.loads(ef.read_text(encoding="utf-8"))
            expr = {"faces_done": s.get("faces_done"),
                    "faces_total": s.get("faces_total"),
                    "updated_at": s.get("updated_at")}
    except Exception:
        pass
    return {"clip": clip, "faces": faces, "persons": persons, "expr": expr,
            "clothing": _clothing_ai_status(lib), "tags": _tags_ai_status(lib)}


def _excire_total(lib: str):
    try:
        from excire import get_excire_library
        exlib = get_excire_library(lib)
        if exlib is not None and exlib.available:
            return exlib._q_local("SELECT COUNT(*) AS n FROM photo_info")[0]["n"]
    except Exception:
        pass
    return None


def _handle_status(h):
    libs = {}
    for lib in sorted(LIBRARY_PATHS):
        entry = {"source": "eagle", "total": len(_eagle_items_map(lib)) or None}
        entry.update(_lib_ai_status(lib))
        libs[lib] = entry
    for lib in sorted(EXCIRE_PATHS):
        entry = {"source": "excire", "total": _excire_total(lib)}
        entry.update(_lib_ai_status(lib))
        libs[lib] = entry

    clip_files = face_files = fer_files = None
    try:
        from ai.model_setup import MODEL_DIR, MODEL_FILES, _verify
        clip_files = all(_verify(MODEL_DIR / f, s, check_hash=False)
                         for f, s in MODEL_FILES.items())
        from ai.face_setup import FACE_MODEL_DIR, FACE_MODEL_FILES
        face_files = all(_verify(FACE_MODEL_DIR / f, s, check_hash=False)
                         for f, s in FACE_MODEL_FILES.items())
        from ai.fer_setup import FER_MODEL_DIR, FER_MODEL_FILES
        fer_files = all(_verify(FER_MODEL_DIR / f, s, check_hash=False)
                        for f, s in FER_MODEL_FILES.items())
    except Exception:
        pass
    with _load_lock:
        engine_state = dict(_clip_text_state)
    h._json(200, {
        "ok": True,
        "onnxruntime": _ort_available(),
        "clip_model_ready": clip_files,
        "face_model_ready": face_files,
        "fer_model_ready": fer_files,
        "clip_engine": engine_state,
        "index_job": _job_snapshot(),
        "libs": libs,
    })


# ---------------------------------------------------------------------------
# GET /api/ai/search
# ---------------------------------------------------------------------------

def _handle_search(h):
    p = _params(h)
    q = p.get("q") or p.get("query") or ""
    if not q:
        h._err(400, "缺少 ?q= 查詢字串"); return
    lib = p.get("lib", "")
    ok, topk = _int_param(p, "topk", 40, 1, 200)
    if not ok:
        h._err(400, "topk 需為整數"); return
    if lib and lib not in LIBRARY_PATHS and lib not in EXCIRE_PATHS:
        h._err(404, f"未知的庫：{lib}（可用：{_known_libs()}）"); return

    ready, code, payload = _clip_text_readiness()
    if not ready:
        h._json(code, payload); return

    try:
        from ai import search as _s
    except Exception as e:
        h._json(503, {"ok": False, "error": f"AI 模組載入失敗（numpy？）：{e}"}); return
    try:
        if lib:
            hits = [{**hit, "lib": lib} for hit in _s.search(lib, q, topk=topk)]
        else:
            hits = _s.search_all(q, topk=topk)
    except RuntimeError as e:            # 尚無索引等狀態錯誤
        h._json(400, {"ok": False, "error": str(e)}); return
    _resolve_hits(hits)
    h._json(200, {"ok": True, "query": q, "lib": lib or None,
                  "topk": topk, "count": len(hits), "hits": hits})


# ---------------------------------------------------------------------------
# GET /api/ai/similar（image-to-image）→ api_ai_similar.py（500 行紀律）
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# GET /api/ai/faces/persons
# ---------------------------------------------------------------------------

def _handle_faces_persons(h):
    p = _params(h)
    lib = p.get("lib", "")
    if not lib:
        h._err(400, "缺少 ?lib= 參數"); return
    if lib not in LIBRARY_PATHS and lib not in EXCIRE_PATHS:
        h._err(404, f"未知的庫：{lib}（可用：{_known_libs()}）"); return
    try:
        from ai.face_cluster import load_persons
        from ai.face_indexer import load_face_index
    except Exception as e:
        h._json(503, {"ok": False, "error": f"AI 模組載入失敗（numpy？）：{e}"}); return

    data = load_persons(lib)
    if not data:
        h._json(200, {"ok": True, "lib": lib, "clustered": False, "persons": [],
                      "message": "尚未聚類；請 POST /api/ai/index {kind: faces} "
                                 "或執行 face-cluster"}); return
    _, meta = load_face_index(lib)
    try:                                  # B2：性別/年齡屬性（Excire 庫；快取自動重建）
        from ai.face_attrs import get_person_attrs
        attrs = get_person_attrs(lib, data)
    except Exception:
        attrs = {}
    ex_cache: dict = {}
    persons = []
    for pr in data.get("persons", []):
        rep = pr.get("rep_face")
        rep_info = None
        if rep is not None and 0 <= rep < len(meta):
            m = meta[rep]
            rep_info = {"face_idx": rep, "item": m["id"], "bbox": m["bbox"],
                        "det_score": m["det_score"],
                        **_resolve_item(lib, m["id"], ex_cache)}
            if m.get("frame_ts") is not None:      # B3：影片抽幀臉（bbox 屬該幀）
                rep_info["frame_ts"] = m["frame_ts"]
        a = attrs.get(pr.get("person_id")) or {}
        persons.append({
            "person_id": pr.get("person_id"),
            "name":      pr.get("name"),
            "count":     pr.get("count", 0),
            "items":     pr.get("items", []),
            "gender":    a.get("gender"),
            "age":       a.get("age"),
            "rep_face":  rep_info,
        })
    h._json(200, {"ok": True, "lib": lib, "clustered": True,
                  "attrs_available": bool(attrs),
                  "eps": data.get("eps"), "n_faces": data.get("n_faces"),
                  "noise_count": data.get("noise_count"),
                  "clustered_at": data.get("clustered_at"),
                  "count": len(persons), "persons": persons})


# ---------------------------------------------------------------------------
# POST /api/ai/faces/persons/name（B1 人物命名；寫本專案自有 persons.json）
# ---------------------------------------------------------------------------

def _handle_post_person_name(h):
    b = h._read_json()
    if b is None:
        return
    lib = b.get("lib") if isinstance(b.get("lib"), str) else ""
    person_id = b.get("person_id") if isinstance(b.get("person_id"), str) else ""
    if not lib or not person_id:
        h._err(400, "缺少 lib 或 person_id"); return
    if lib not in LIBRARY_PATHS and lib not in EXCIRE_PATHS:
        h._err(404, f"未知的庫：{lib}（可用：{_known_libs()}）"); return
    name = b.get("name")
    if name is not None and not isinstance(name, str):
        h._err(400, "name 需為字串或 null"); return
    name = (name or "").strip() or None      # 空字串 / 純空白 = 清除命名
    if name and len(name) > 80:
        h._err(400, "name 長度上限 80 字"); return
    try:
        from ai.face_cluster import set_person_name
    except Exception as e:
        h._json(503, {"ok": False, "error": f"AI 模組載入失敗（numpy？）：{e}"}); return
    try:
        res = set_person_name(lib, person_id, name)
    except RuntimeError as e:
        h._json(400, {"ok": False, "error": str(e)}); return
    h._json(200, {"ok": True, **res})


# ---------------------------------------------------------------------------
# GET /api/ai/tags（B5：人數/場景/運動標籤；讀 scene_tags.json）
# ---------------------------------------------------------------------------

def _handle_tags(h):
    p = _params(h)
    lib = p.get("lib", "")
    if not lib:
        h._err(400, "缺少 ?lib= 參數"); return
    if lib not in LIBRARY_PATHS and lib not in EXCIRE_PATHS:
        h._err(404, f"未知的庫：{lib}（可用：{_known_libs()}）"); return
    try:
        from ai.scene_tags import load_scene_tags
    except Exception as e:
        h._json(503, {"ok": False, "error": f"AI 模組載入失敗（numpy？）：{e}"}); return
    data = load_scene_tags(lib)
    if not data:
        h._json(200, {"ok": True, "lib": lib, "built": False, "items": {},
                      "message": "尚未建立標籤索引；請 POST /api/ai/index "
                                 "{kind: tags} 或執行 scene-tags CLI"}); return
    h._json(200, {"ok": True, "lib": lib, "built": True,
                  "built_at": data.get("built_at"), "clip": data.get("clip"),
                  "labels": data.get("labels", {}),
                  "items": data.get("items", {})})


# ---------------------------------------------------------------------------
# GET /api/ai/expressions（B6：臉部表情；讀項目層聚合 item_expressions.json）
# ---------------------------------------------------------------------------

def _handle_expressions(h):
    p = _params(h)
    lib = p.get("lib", "")
    if not lib:
        h._err(400, "缺少 ?lib= 參數"); return
    if lib not in LIBRARY_PATHS and lib not in EXCIRE_PATHS:
        h._err(404, f"未知的庫：{lib}（可用：{_known_libs()}）"); return
    try:
        from ai.face_expr import load_item_expressions
    except Exception as e:
        h._json(503, {"ok": False, "error": f"AI 模組載入失敗（numpy？）：{e}"}); return
    data = load_item_expressions(lib)
    if not data:
        h._json(200, {"ok": True, "lib": lib, "built": False, "items": {},
                      "message": "尚未建立表情索引；請 POST /api/ai/index "
                                 "{kind: expressions} 或執行 face-expr CLI"}); return
    h._json(200, {"ok": True, "lib": lib, "built": True,
                  "built_at": data.get("built_at"), "model": data.get("model"),
                  "labels": data.get("labels", []),
                  "items": data.get("items", {})})


# ---------------------------------------------------------------------------
# GET /api/ai/clothing（服裝粗類；讀 clothing_tags.json）
# ---------------------------------------------------------------------------

def _handle_clothing(h):
    p = _params(h)
    lib = p.get("lib", "")
    if not lib:
        h._err(400, "缺少 ?lib= 參數"); return
    if lib not in LIBRARY_PATHS and lib not in EXCIRE_PATHS:
        h._err(404, f"未知的庫：{lib}（可用：{_known_libs()}）"); return
    try:
        from ai.clothing_tags import load_clothing_tags
    except Exception as e:
        h._json(503, {"ok": False, "error": f"AI 模組載入失敗（numpy？）：{e}"}); return
    data = load_clothing_tags(lib)
    if not data:
        h._json(200, {"ok": True, "lib": lib, "built": False, "items": {},
                      "message": "尚未建立服裝標籤索引；請 POST /api/ai/index "
                                 "{kind: clothing} 或執行 clothing-tags CLI"}); return
    h._json(200, {"ok": True, "lib": lib, "built": True,
                  "built_at": data.get("built_at"), "model": data.get("model"),
                  "labels": data.get("labels", {}),
                  "items": data.get("items", {})})


# ---------------------------------------------------------------------------
# GET /api/ai/faces/search
# ---------------------------------------------------------------------------

def _handle_faces_search(h):
    p = _params(h)
    lib, item = p.get("lib", ""), p.get("item", "")
    if not lib or not item:
        h._err(400, "缺少 ?lib= 或 ?item= 參數"); return
    if lib not in LIBRARY_PATHS and lib not in EXCIRE_PATHS:
        h._err(404, f"未知的庫：{lib}（可用：{_known_libs()}）"); return
    ok, topk = _int_param(p, "topk", 40, 1, 200)
    if not ok:
        h._err(400, "topk 需為整數"); return
    face_raw = p.get("face", "")
    face_idx = None
    if face_raw != "":
        try:
            face_idx = int(face_raw)
        except ValueError:
            h._err(400, "face 需為整數"); return
    all_libs = p.get("all", "") in ("1", "true", "yes")

    try:
        from ai.face_search import search_by_item
    except Exception as e:
        h._json(503, {"ok": False, "error": f"AI 模組載入失敗（numpy？）：{e}"}); return
    try:
        res = search_by_item(lib, item, face_idx=face_idx, topk=topk, all_libs=all_libs)
    except RuntimeError as e:            # 無索引 / 無該臉等狀態錯誤
        h._json(400, {"ok": False, "error": str(e)}); return
    _resolve_hits(res["hits"])
    h._json(200, {"ok": True, **res})


# ---------------------------------------------------------------------------
# 背景索引任務（單一 worker；SSE type=ai-index-progress + 輪詢備援）
# ---------------------------------------------------------------------------

_index_lock = threading.Lock()
_index_job: dict = {"status": "idle"}    # idle|running|done|error


def _job_snapshot() -> dict:
    with _index_lock:
        return json.loads(json.dumps(_index_job, ensure_ascii=False))


def _progress(lib: str, kind: str, done: int, total: int):
    with _index_lock:
        _index_job["current"] = {"lib": lib, "kind": kind,
                                 "done": done, "total": total}
    _sse_broadcast(lib, {"type": "ai-index-progress", "lib": lib, "kind": kind,
                         "phase": "running", "done": done, "total": total})


def _index_worker(libs: list, kinds: list, limit: int = None):
    for lib in libs:
        for kind in kinds:
            with _index_lock:
                _index_job["current"] = {"lib": lib, "kind": kind,
                                         "done": 0, "total": None}
            _sse_broadcast(lib, {"type": "ai-index-progress", "lib": lib,
                                 "kind": kind, "phase": "start"})
            try:
                cb = lambda d, t, _l=lib, _k=kind: _progress(_l, _k, d, t)
                if kind == "clip":
                    from ai.indexer import build_index
                    with _engine_init_lock:      # session 建立集中上鎖
                        from ai.clip_engine import get_engine
                        _ = get_engine().visual
                    res = build_index(lib, limit=limit, progress_cb=cb)
                elif kind == "expressions":      # B6：臉部表情（FER+）
                    with _engine_init_lock:      # session 建立集中上鎖
                        from ai.face_expr import get_fer_engine
                        _ = get_fer_engine().sess
                    from ai.face_expr import build_face_expressions
                    res = build_face_expressions(lib, limit=limit, progress_cb=cb)
                elif kind == "tags":             # B5：人數/場景/運動標籤
                    from ai.scene_tags import build_scene_tags
                    with _engine_init_lock:      # CLIP text 塔（zero-shot 用）
                        from ai.clip_engine import get_engine
                        try:
                            _ = get_engine().text
                        except Exception:
                            pass                 # 無 CLIP → 模組內優雅降級
                    res = build_scene_tags(lib, progress_cb=cb)
                elif kind == "clothing":         # 服裝粗類（YOLOX person + CLIP zero-shot）
                    with _engine_init_lock:      # YOLOX + CLIP visual/text 塔皆需就緒
                        from ai.person_detect import get_person_detector
                        _ = get_person_detector().sess
                        from ai.clip_engine import get_engine
                        _ = get_engine().visual
                        _ = get_engine().text
                    from ai.clothing_tags import build_clothing_tags
                    res = build_clothing_tags(lib, limit=limit, progress_cb=cb)
                else:                            # faces / video-faces
                    with _engine_init_lock:
                        from ai.face_engine import get_face_engine
                        eng = get_face_engine()
                        _ = eng.det, eng.rec
                    if kind == "video-faces":    # B3：影片多幀抽幀
                        from ai.face_indexer import build_video_face_index
                        res = build_video_face_index(lib, limit=limit, progress_cb=cb)
                    else:
                        from ai.face_indexer import build_face_index
                        res = build_face_index(lib, limit=limit, progress_cb=cb)
                    try:                         # 索引後自動重聚類（重跑不重算 embedding）
                        from ai.face_cluster import build_clusters
                        res["cluster"] = build_clusters(lib)
                    except Exception as ce:
                        res["cluster_error"] = str(ce)[:200]
                with _index_lock:
                    _index_job["results"].append({"lib": lib, "kind": kind, **res})
                _sse_broadcast(lib, {"type": "ai-index-progress", "lib": lib,
                                     "kind": kind, "phase": "done", "result": res})
            except Exception as e:
                err = f"{lib}/{kind}: {str(e)[:300]}"
                with _index_lock:
                    _index_job["errors"].append(err)
                _sse_broadcast(lib, {"type": "ai-index-progress", "lib": lib,
                                     "kind": kind, "phase": "error",
                                     "error": str(e)[:300]})
    with _index_lock:
        _index_job["status"] = ("error" if _index_job["errors"]
                                and not _index_job["results"] else "done")
        _index_job["current"] = None
        _index_job["finished_at"] = _now()


def _handle_post_index(h):
    b = h._read_json()
    if b is None:
        return
    lib = b.get("lib") if isinstance(b.get("lib"), str) else ""
    lib = (lib or "all").strip()
    kind = (b.get("kind") or "both").strip().lower() if isinstance(b.get("kind"), (str, type(None))) else ""
    if kind not in ("clip", "faces", "both", "video-faces", "tags", "expressions",
                    "clothing", "advanced"):
        h._err(400, "kind 需為 clip | faces | both | video-faces | tags | "
                    "expressions | clothing | advanced"); return
    limit = b.get("limit")
    if limit is not None and (not isinstance(limit, int) or limit < 1):
        h._err(400, "limit 需為正整數"); return
    if lib == "all":
        libs = _known_libs()
        if not libs:
            h._err(400, "尚未設定任何資源庫"); return
    elif lib in LIBRARY_PATHS or lib in EXCIRE_PATHS:
        libs = [lib]
    else:
        h._err(404, f"未知的庫：{lib}（可用：{_known_libs()}）"); return
    if not _ort_available():
        h._json(503, {"ok": False, "error": "onnxruntime 未安裝，無法建立索引。"
                                            "安裝：pip install --user onnxruntime"}); return
    kinds = (["clip", "faces"] if kind == "both" else
             ["tags", "expressions", "clothing"] if kind == "advanced" else [kind])

    with _index_lock:
        if _index_job.get("status") == "running":
            snap = json.loads(json.dumps(_index_job, ensure_ascii=False))
            h._json(409, {"ok": False, "error": "already_running", "job": snap}); return
        _index_job.clear()
        _index_job.update({
            "status": "running", "libs": libs, "kinds": kinds,
            "current": None, "results": [], "errors": [],
            "started_at": _now(), "finished_at": None,
        })
    threading.Thread(target=_index_worker, args=(libs, kinds, limit), daemon=True).start()
    h._json(202, {"ok": True, "started": True, "libs": libs, "kinds": kinds,
                  "progress": "/api/ai/index/progress",
                  "sse": "type=ai-index-progress（/api/events?lib=…）"})


def _handle_index_progress(h):
    h._json(200, {"ok": True, "job": _job_snapshot()})


# ---------------------------------------------------------------------------
# dispatch（serve.py 掛接點）
# ---------------------------------------------------------------------------

def handle_ai_get(h, up: str):
    if up == "/api/ai/status":
        _handle_status(h); return
    if up == "/api/ai/search":
        _handle_search(h); return
    if up == "/api/ai/similar":
        from api_ai_similar import handle_similar
        handle_similar(h); return
    if up == "/api/ai/faces/persons":
        _handle_faces_persons(h); return
    if up == "/api/ai/faces/search":
        _handle_faces_search(h); return
    if up == "/api/ai/tags":
        _handle_tags(h); return
    if up == "/api/ai/expressions":
        _handle_expressions(h); return
    if up == "/api/ai/clothing":
        _handle_clothing(h); return
    if up == "/api/ai/index/progress":
        _handle_index_progress(h); return
    h._err(404, "Not found: " + up)


def handle_ai_post(h, up: str):
    if up == "/api/ai/index":
        _handle_post_index(h); return
    if up == "/api/ai/faces/persons/name":
        _handle_post_person_name(h); return
    h._err(404, "Not found: " + up)
