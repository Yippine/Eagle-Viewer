"""GET API endpoint handlers + views 歷史儲存 + 資料夾掃描任務登記表.

所有 handle_* 函式的第一參數 ``h`` 為 BaseHTTPRequestHandler 實例
（serve.py 的 _Handler），透過其薄介面（_json/_err/_query_lib/path/headers）操作。
路由 dispatch 表保留在 serve.py。
"""
import json
import re
import threading
from datetime import datetime, timezone
from urllib.parse import parse_qs, unquote

from config import DATA_DIR, LIBRARY_PATHS, MAX_HISTORY, _lib_locks
from excire import get_excire_library, list_excire_libraries
from extract import (
    _find_local_files, _index_folder, _list_folder_sources, _list_libraries,
)
from api_helpers import _get_folder_tree, _get_item_meta, _load_links
from api_sync import _compute_folder_tags_diff, _compute_items_tags_diff
from api_import import _load_user_data, get_import_status

# ---------------------------------------------------------------------------
# Views helpers (view history per library)
# ---------------------------------------------------------------------------

def _load_views(lib_name: str) -> dict:
    p = DATA_DIR / lib_name / "views.json"
    if not p.exists():
        return {}
    try:
        with open(p, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def _save_views(data: dict, lib_name: str) -> None:
    lib_dir = DATA_DIR / lib_name
    lib_dir.mkdir(parents=True, exist_ok=True)
    tmp = lib_dir / "views.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    tmp.replace(lib_dir / "views.json")


def _track_view(lib_name: str, item_id: str, name: str, domain: str, duration: int = 0) -> dict:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with _lib_locks[lib_name]:
        data = _load_views(lib_name)
        entry: dict = {"t": now}
        if duration > 0:
            entry["d"] = duration
        if item_id in data:
            rec = data[item_id]
            rec["views"] = rec.get("views", 0) + 1
            rec["last_viewed"] = now
            if duration > 0:
                rec["total_watch_time"] = rec.get("total_watch_time", 0) + duration
            if name:
                rec["name"] = name
            history = rec.setdefault("history", [])
            history.insert(0, entry)
            if len(history) > MAX_HISTORY:
                rec["history"] = history[:MAX_HISTORY]
        else:
            data[item_id] = {
                "views": 1, "last_viewed": now, "name": name,
                "domain": domain, "history": [entry],
            }
            if duration > 0:
                data[item_id]["total_watch_time"] = duration
        _save_views(data, lib_name)
        return data[item_id]


def _delete_history_entry(lib_name: str, item_id: str, t: str) -> dict:
    with _lib_locks[lib_name]:
        data = _load_views(lib_name)
        rec = data.get(item_id)
        if not rec:
            return {}
        rec["history"] = [e for e in rec.get("history", []) if e.get("t") != t]
        rec["views"]   = len(rec["history"])
        if rec["history"]:
            rec["last_viewed"] = rec["history"][0]["t"]
        else:
            rec.pop("last_viewed", None)
        _save_views(data, lib_name)
        return rec


def _clear_all_views(lib_name: str) -> None:
    with _lib_locks[lib_name]:
        _save_views({}, lib_name)


# ---------------------------------------------------------------------------
# Async folder scan tasks
# ---------------------------------------------------------------------------
_folder_scan_tasks: dict = {}   # task_id -> {status, progress, total, error}
_folder_scan_lock = threading.Lock()


def _start_folder_scan(folder_name: str) -> str:
    """Launch folder scan in background thread. Returns task_id."""
    import uuid
    task_id = uuid.uuid4().hex[:12]
    with _folder_scan_lock:
        _folder_scan_tasks[task_id] = {"status": "running", "folder": folder_name, "progress": 0, "total": 0}

    def _run():
        try:
            _index_folder(folder_name)
            with _folder_scan_lock:
                _folder_scan_tasks[task_id]["status"] = "done"
        except Exception as e:
            with _folder_scan_lock:
                _folder_scan_tasks[task_id].update({"status": "error", "error": str(e)[:200]})

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return task_id


def _get_folder_scan_status(task_id: str) -> dict | None:
    with _folder_scan_lock:
        return dict(_folder_scan_tasks.get(task_id, {})) or None


# ---------------------------------------------------------------------------
# GET handlers
# ---------------------------------------------------------------------------

def handle_browse(h):
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk(); root.withdraw()
        root.wm_attributes("-topmost", True)
        chosen = filedialog.askdirectory(title="選擇資源庫資料夾")
        root.destroy()
    except Exception as e:
        h._json(500, {"ok": False, "error": str(e)}); return
    h._json(200, {"ok": True, "path": chosen} if chosen else {"ok": False, "path": ""})


def handle_config(h):
    h._json(200, {"configured": bool(LIBRARY_PATHS),
                  "libraries": [str(p) for p in LIBRARY_PATHS.values()]})


def handle_libraries(h):
    eagle = _list_libraries()
    folders = _list_folder_sources()
    if isinstance(eagle, list):
        combined = eagle + [{"source": "folder", **f} for f in folders]
    else:
        combined = eagle  # {configured: False}
    h._json(200, combined)


def handle_folder_sources(h):
    h._json(200, _list_folder_sources())


def handle_views(h):
    lib = h._query_lib()
    if not lib: h._err(400, "Missing ?lib= parameter"); return
    with _lib_locks[lib]:
        h._json(200, _load_views(lib)); return


def handle_user_data(h):
    h._json(200, _load_user_data())


def handle_item(h):
    qs = h.path.split("?", 1)[1] if "?" in h.path else ""
    p = parse_qs(qs)
    item_id = unquote(p.get("id",  [""])[0]).strip()
    lib     = unquote(p.get("lib", [""])[0]).strip()
    if not item_id or not lib: h._err(400, "Missing ?id= or ?lib="); return
    meta = _get_item_meta(lib, item_id)
    if meta is None: h._err(404, "Item not found"); return
    local: dict = {}
    if LIBRARY_PATHS.get(lib):
        info_dir = LIBRARY_PATHS[lib] / "images" / f"{item_id}.info"
        local = _find_local_files(info_dir, lib)
    h._json(200, {"ok": True, "item": {**meta, **local}})


def handle_folders(h):
    lib = h._query_lib()
    if not lib: h._err(400, "Missing ?lib= parameter"); return
    h._json(200, {"ok": True, "folders": _get_folder_tree(lib)})


def handle_tags_sync_diff(h):
    lib = h._query_lib()
    if not lib: h._err(400, "Missing ?lib= parameter"); return
    ch = _compute_folder_tags_diff(lib)
    h._json(200, {"ok": True, "changes": ch, "total": len(ch)})


def handle_items_tags_sync_diff(h):
    lib = h._query_lib()
    if not lib: h._err(400, "Missing ?lib= parameter"); return
    ch = _compute_items_tags_diff(lib)
    h._json(200, {"ok": True, "changes": ch, "total": len(ch)})


def handle_item_links(h):
    qs = h.path.split("?", 1)[1] if "?" in h.path else ""
    p = parse_qs(qs)
    item_id = unquote(p.get("id",  [""])[0]).strip()
    lib     = unquote(p.get("lib", [""])[0]).strip()
    if not item_id or not lib: h._err(400, "Missing ?id= or ?lib="); return
    linked = _load_links(lib).get(item_id, [])
    result = []
    for lid in linked:
        m = _get_item_meta(lib, lid)
        if not m: continue
        loc: dict = {}
        if LIBRARY_PATHS.get(lib):
            loc = _find_local_files(LIBRARY_PATHS[lib] / "images" / f"{lid}.info", lib)
        result.append({"id": lid, "name": m.get("name", ""),
                        "thumb": loc.get("thumb"), "url": m.get("url", "")})
    h._json(200, {"ok": True, "links": result})


def handle_import_status(h, up: str):
    task_id = up[len("/api/import/status/"):]
    st = get_import_status(task_id)
    if st is None: h._err(404, "Task not found"); return
    h._json(200, {"ok": True, "task_id": task_id, **st})


def handle_folder_extract_status(h, up: str):
    task_id = up[len("/api/folder-extract/status/"):]
    st = _get_folder_scan_status(task_id)
    if st is None: h._err(404, "Task not found"); return
    h._json(200, {"ok": True, "task_id": task_id, **st})


def handle_services_health(h):
    """GET /api/services/health — 回傳各下載服務連線狀態"""
    try:
        import requests as _req
    except ImportError:
        h._json(200, {"ok": False, "error": "requests not installed"}); return

    from api_import import _COBALT_API, _EVIL_OCTAL_API, _XHS_API
    checks = {
        "cobalt":    ("GET",  f"{_COBALT_API}/"),
        "evil0ctal": ("GET",  f"{_EVIL_OCTAL_API}/docs"),
        "xhs":       ("GET",  f"{_XHS_API}/docs"),
    }
    results = {}
    for svc, (method, url) in checks.items():
        try:
            r = _req.request(method, url, timeout=2)
            results[svc] = {"ok": True, "status": r.status_code}
        except Exception as e:
            results[svc] = {"ok": False, "error": str(e)[:120]}
    h._json(200, {"ok": True, "services": results})


# ---------------------------------------------------------------------------
# Excire read-only integration
# ---------------------------------------------------------------------------

def handle_excire_api(h, up: str):
    """GET /api/excire/... — Excire 唯讀 API（庫清單/照片/資料夾/相簿/標籤/人臉）"""
    if up == "/api/excire/libraries":
        h._json(200, list_excire_libraries()); return

    m = re.match(r"^/api/excire/([^/]+)/(photos|folders|collections|keywords)$", up)
    if m:
        lib_name, action = m.group(1), m.group(2)
        lib = get_excire_library(lib_name)
        if lib is None:
            h._err(404, f"Excire 資源庫未設定：{lib_name}"); return
        if action != "photos" and not lib.available:
            h._err(503, f"Excire 資源庫無法使用（DB 不存在）：{lib_name}"); return
        if action == "photos":
            qs = h.path.split("?", 1)[1] if "?" in h.path else ""
            p = parse_qs(qs)
            _get = lambda k, d=None: unquote(p[k][0]).strip() if p.get(k) else d
            try:
                result = lib.list_photos(
                    offset=int(_get("offset", "0") or 0),
                    limit=int(_get("limit", "100") or 100),
                    folder=int(_get("folder")) if _get("folder") else None,
                    keyword=_get("keyword") or None,
                    collection=int(_get("collection")) if _get("collection") else None,
                    sort=_get("sort", "date") or "date",
                    order=_get("order", _get("dir", "desc")) or "desc",
                )
            except ValueError:
                h._err(400, "Invalid query parameter"); return
            h._json(200, {"ok": True, "library": lib_name, **result}); return
        if action == "folders":
            h._json(200, {"ok": True, "folders": lib.folder_tree()}); return
        if action == "collections":
            h._json(200, {"ok": True, "collections": lib.collections()}); return
        if action == "keywords":
            h._json(200, {"ok": True, "keywords": lib.keywords(),
                          "ai_available": lib.ai_available}); return

    m = re.match(r"^/api/excire/([^/]+)/faces/(\d+)$", up)
    if m:
        lib = get_excire_library(m.group(1))
        if lib is None:
            h._err(404, f"Excire 資源庫未設定：{m.group(1)}"); return
        photo_id = int(m.group(2))
        h._json(200, {"ok": True, "photo_id": photo_id,
                      "faces": lib.faces(photo_id),
                      "ai_available": lib.ai_available}); return

    h._err(404, "Not found: " + up)
