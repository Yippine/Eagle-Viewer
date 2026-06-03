#!/usr/bin/env python3
"""
Eagle App Media Viewer – local HTTP server (threaded edition)
Serves viewer/ and Eagle library images plus a management API.
Usage: python serve.py [port]   (default port: 8765)
"""

import json
import queue
import re
import shutil
import socket
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, unquote

from config import (
    DATA_DIR, LIBRARY_PATHS, FOLDER_PATHS, MAX_HISTORY, SCHEMA_VERSION,
    VIEWER_DIR, _lib_locks, _load_config, _add_library_path, _add_folder_path,
)
from extract import (
    _find_local_files, _index_library, _list_libraries,
    _run_incremental, _run_one,
    _index_folder, _list_folder_sources,
)
from api_helpers import (
    _add_link, _build_folder_map, _get_folder_tree, _get_item_meta,
    _load_links, _patch_item_cache, _remove_item_cache, _remove_link,
    _sse_broadcast, _sse_subscribe, _sse_unsubscribe,
    _write_item_meta, _write_via_eagle_api, _write_via_eagle_api_v2,
)
from api_sync import (
    _apply_folder_tags_sync, _apply_items_tags_sync,
    _compute_folder_tags_diff, _compute_items_tags_diff,
)
from api_import import (
    _create_eagle_item_from_file, _gen_eagle_id, _load_user_data,
    _merge_user_data, _parse_multipart, _save_user_data,
    get_import_status, start_import_url,
)

# ---------------------------------------------------------------------------
# MIME map
# ---------------------------------------------------------------------------

_MIME = {
    ".html": "text/html; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif":  "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".mp4":  "video/mp4",
    ".webm": "video/webm",
    ".mov":  "video/quicktime",
    ".m4v":  "video/mp4",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
    ".url":  "application/octet-stream",
}


def _guess_mime(path: Path) -> str:
    if re.search(r"_thumbnail$", path.name):
        return "image/png"
    return _MIME.get(path.suffix.lower(), "application/octet-stream")


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
# Eagle watcher（新素材偵測 / 刪除偵測）
# ---------------------------------------------------------------------------

_eagle_last_ids        = {}   # lib -> frozenset of all .info folder IDs
_eagle_trashed_ids     = {}   # lib -> set of IDs known to be isDeleted=True in Eagle
_eagle_watcher_started = set()
_eagle_snap_cache      = {}   # lib -> { item_id -> snap_dict }（供永久刪除時回查）

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


def _scan_lib_item_ids(lib: str):
    """Fast directory scan — return frozenset of item IDs. None if lib invalid."""
    lib_path = LIBRARY_PATHS.get(lib)
    if not lib_path:
        return None
    images_dir = Path(lib_path) / "images"
    if not images_dir.is_dir():
        return None
    return frozenset(
        p.name[:-5] for p in images_dir.iterdir()
        if p.is_dir() and p.name.endswith(".info")
    )


def _check_isdeleted(lib: str, item_ids):
    """Read metadata.json of all item_ids and return set of those with isDeleted==True.

    Note: mtime-based filtering was removed — WSL2 DrvFS caches NTFS mtime values,
    causing Python stat() to return stale timestamps after Eagle App writes metadata.json.
    Full scan is reliable and fast enough (< 300ms for 500-item libraries at 10s interval).
    """
    lib_path = LIBRARY_PATHS.get(lib)
    if not lib_path:
        return set()
    images_dir = Path(lib_path) / "images"
    result = set()
    for item_id in item_ids:
        meta_path = images_dir / f"{item_id}.info" / "metadata.json"
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            if meta.get("isDeleted"):
                result.add(item_id)
        except Exception:
            pass
    return result


_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"}

def _read_item_snaps(lib: str, item_ids) -> dict:
    """從 Eagle metadata.json 即時讀取項目快照（不依賴 viewer index）。
    回傳 { id: { name, ext, kind, folders: [folderName, ...] } }
    使用 _get_folder_tree（已知可用）建立 flat map，避免重複讀取 library metadata.json。
    """
    import time as _t
    def _slog(msg): print(f"[{_t.strftime('%H:%M:%S')}] {msg}", flush=True)

    lib_path = LIBRARY_PATHS.get(lib)
    _slog(f"[snap] lib={lib!r} lib_path={lib_path}")
    if not lib_path:
        return {}
    images_dir = Path(lib_path) / "images"

    # 用 _get_folder_tree 建立 folderId → folderName 的 flat map
    folder_name_map: dict = {}
    def _flatten(nodes):
        for n in nodes:
            fid = n.get("id", "")
            if fid:
                folder_name_map[fid] = n.get("name", fid)
            _flatten(n.get("children", []))
    try:
        tree = _get_folder_tree(lib)
        _flatten(tree)
        _slog(f"[snap] folder_name_map entries={len(folder_name_map)} sample={list(folder_name_map.items())[:3]}")
    except Exception as e:
        _slog(f"[snap] _get_folder_tree 失敗: {e}")

    cache = _eagle_snap_cache.setdefault(lib, {})
    snaps = {}
    for item_id in item_ids:
        meta_path = images_dir / f"{item_id}.info" / "metadata.json"
        try:
            m = json.loads(meta_path.read_text("utf-8"))
            ext  = m.get("ext", "") or ""
            kind = "video" if f".{ext.lower()}" in _VIDEO_EXTS else "other"
            raw_folders = m.get("folders") or []
            folder_names = [folder_name_map[fid] for fid in raw_folders if fid in folder_name_map]
            _slog(f"[snap] {item_id}: name={m.get('name')} ext={ext} raw_folders={raw_folders} resolved={folder_names}")
            snap = {
                "name":    m.get("name", "") or "",
                "ext":     ext,
                "kind":    kind,
                "folders": folder_names,
            }
            snaps[item_id] = snap
            cache[item_id] = snap          # ← 成功讀取時更新快取
        except Exception as e:
            # 讀取失敗（檔案已消失）→ 1) 記憶體快取 2) urls_data.json（持久化索引）
            if item_id in cache:
                _slog(f"[snap] {item_id} 讀取失敗，從記憶體快取補底")
                snaps[item_id] = cache[item_id]
            else:
                # fallback：讀 urls_data.json（重啟後仍可用）
                try:
                    data_path = DATA_DIR / lib / "urls_data.json"
                    d = json.loads(data_path.read_text("utf-8"))
                    idx = {i["id"]: i for i in d.get("items", [])}
                    if item_id in idx:
                        it  = idx[item_id]
                        ext = it.get("ext", "") or ""
                        raw = it.get("folders") or []
                        fnames = [folder_name_map[fid] for fid in raw if fid in folder_name_map]
                        snap = {
                            "name":    it.get("name", "") or "",
                            "ext":     ext,
                            "kind":    it.get("kind", "other"),
                            "folders": fnames,
                        }
                        _slog(f"[snap] {item_id} 從 urls_data.json 補底 folders={fnames}")
                        snaps[item_id] = snap
                        cache[item_id] = snap   # 也存入記憶體快取
                    else:
                        _slog(f"[snap] {item_id} 讀取失敗且無索引記錄: {e}")
                except Exception as e2:
                    _slog(f"[snap] {item_id} 讀取失敗且 urls_data.json 補底失敗: {e2}")
    return snaps


def _start_eagle_watcher(lib: str, interval: int = 10):
    """Background watcher: detect item additions, permanent deletes, Eagle-trash events."""
    if lib in _eagle_watcher_started:
        return
    _eagle_watcher_started.add(lib)

    def _check():
        import traceback as _tb
        import time as _time
        def _wlog(msg):
            ts = _time.strftime('%H:%M:%S')
            print(f"[{ts}] {msg}", flush=True)
        try:
            current_ids = _scan_lib_item_ids(lib)
            if current_ids is None:
                _wlog(f"[watcher:{lib}] _scan_lib_item_ids 回傳 None（lib path 無效？）")
                return  # lib path invalid, stop silently

            prev_ids      = _eagle_last_ids.get(lib)
            known_trashed = _eagle_trashed_ids.setdefault(lib, set())

            if prev_ids is None:
                # ── 首次掃描：建立基準線（全量讀取 isDeleted 狀態）
                initial_trashed = _check_isdeleted(lib, current_ids)
                _eagle_last_ids[lib]    = current_ids
                _eagle_trashed_ids[lib] = initial_trashed
                _wlog(f"[watcher:{lib}] 基準線建立：{len(current_ids)} 個 items，{len(initial_trashed)} 個已垃圾桶")
            else:
                added   = current_ids - prev_ids   # 新增的 .info 資料夾
                removed = prev_ids    - current_ids # 消失的 .info 資料夾（永久刪除）

                # 全量讀取 isDeleted 狀態（移除 mtime filter：WSL2 DrvFS mtime 不可靠）
                current_trashed = _check_isdeleted(lib, current_ids)
                newly_trashed = (current_trashed - known_trashed) - removed
                known_trashed -= removed          # 已永久刪除的不再追蹤
                known_trashed |= newly_trashed    # 累積已知垃圾桶狀態

                _eagle_last_ids[lib] = current_ids

                if added or removed or newly_trashed:
                    _wlog(f"[watcher:{lib}] 異動 added={len(added)} removed={len(removed)} newly_trashed={len(newly_trashed)}")

                if added:
                    _sse_broadcast(lib, {
                        "type": "item_added_external",
                        "count": len(current_ids), "diff": len(added),
                        "ids": list(added), "lib": lib
                    })
                if removed:
                    _sse_broadcast(lib, {
                        "type":  "item_removed_external",
                        "ids":   list(removed),
                        "snaps": _read_item_snaps(lib, removed),
                        "lib":   lib,
                    })
                if newly_trashed:
                    _sse_broadcast(lib, {
                        "type":  "item_trashed_external",
                        "ids":   list(newly_trashed),
                        "snaps": _read_item_snaps(lib, newly_trashed),
                        "lib":   lib,
                    })
        except Exception:
            _wlog(f"[watcher:{lib}] 例外：\n{_tb.format_exc()}")
        finally:
            t = threading.Timer(interval, _check)
            t.daemon = True
            t.start()

    t = threading.Timer(1, _check)  # 首次 1s 後建立基準線
    t.daemon = True
    t.start()


# ---------------------------------------------------------------------------
# CORS / connection error constants
# ---------------------------------------------------------------------------

_CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

_CONN_ERRORS = (ConnectionAbortedError, BrokenPipeError,
                ConnectionResetError, OSError)


# ---------------------------------------------------------------------------
# Threaded HTTP server
# ---------------------------------------------------------------------------

class _Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, _CONN_ERRORS):
            return
        super().handle_error(request, client_address)


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _cors(self):
        for k, v in _CORS.items():
            self.send_header(k, v)

    def _json(self, status: int, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
        except _CONN_ERRORS:
            pass

    def _err(self, status: int, msg: str):
        self._json(status, {"error": msg})

    def _redirect(self, location: str, code: int = 302):
        try:
            self.send_response(code)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except _CONN_ERRORS:
            pass

    def _url_path(self) -> str:
        raw = self.path.split("?", 1)[0].split("#", 1)[0]
        return unquote(raw)

    def _query_lib(self) -> str:
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        return unquote(parse_qs(qs).get("lib", [""])[0]).strip()

    def _read_json(self, max_size: int = 8192):
        """Read and parse JSON body. Calls _err and returns None on failure."""
        cl = int(self.headers.get("Content-Length", 0))
        if cl > max_size:
            self._err(413, "Payload too large"); return None
        try:
            return json.loads(self.rfile.read(cl).decode("utf-8"))
        except Exception:
            self._err(400, "Invalid JSON"); return None

    def translate_path(self, url_path: str):
        if url_path == "/viewer" or url_path.startswith("/viewer/"):
            rel = url_path[len("/viewer/"):] if url_path.startswith("/viewer/") else ""
            fs  = (VIEWER_DIR / (rel or "index.html")).resolve()
            if not str(fs).startswith(str(VIEWER_DIR.resolve())):
                return None, None
            return fs, _guess_mime(fs)

        if url_path.startswith("/images/"):
            rest  = url_path[len("/images/"):]
            parts = rest.split("/", 1)
            if len(parts) < 2 or not parts[0] or not parts[1]:
                return None, None
            lib_path = LIBRARY_PATHS.get(parts[0])
            if lib_path is None:
                return None, None
            images_root = (lib_path / "images").resolve()
            fs = (images_root / parts[1]).resolve()
            if not str(fs).startswith(str(images_root)):
                return None, None
            return fs, _guess_mime(fs)

        if url_path.startswith("/folder-images/"):
            rest  = url_path[len("/folder-images/"):]
            parts = rest.split("/", 1)
            if len(parts) < 2 or not parts[0] or not parts[1]:
                return None, None
            folder_root = FOLDER_PATHS.get(parts[0])
            if folder_root is None:
                return None, None
            folder_resolved = folder_root.resolve()
            fs = (folder_resolved / parts[1]).resolve()
            if not str(fs).startswith(str(folder_resolved)):
                return None, None
            return fs, _guess_mime(fs)

        if url_path.startswith("/data/"):
            fs = (DATA_DIR / url_path[len("/data/"):]).resolve()
            if not str(fs).startswith(str(DATA_DIR.resolve())):
                return None, None
            return fs, _guess_mime(fs)

        return None, None

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ── GET ──────────────────────────────────────────────────────────────────

    def do_GET(self):
        up = self._url_path()

        if up == "/":
            self._redirect("/viewer/"); return

        if up == "/api/browse":
            try:
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk(); root.withdraw()
                root.wm_attributes("-topmost", True)
                chosen = filedialog.askdirectory(title="選擇資源庫資料夾")
                root.destroy()
            except Exception as e:
                self._json(500, {"ok": False, "error": str(e)}); return
            self._json(200, {"ok": True, "path": chosen} if chosen else {"ok": False, "path": ""})
            return

        if up == "/api/config":
            self._json(200, {"configured": bool(LIBRARY_PATHS),
                              "libraries": [str(p) for p in LIBRARY_PATHS.values()]}); return

        if up == "/api/libraries":
            eagle = _list_libraries()
            folders = _list_folder_sources()
            if isinstance(eagle, list):
                combined = eagle + [{"source": "folder", **f} for f in folders]
            else:
                combined = eagle  # {configured: False}
            self._json(200, combined); return

        if up == "/api/folder-sources":
            self._json(200, _list_folder_sources()); return

        if up == "/api/views":
            lib = self._query_lib()
            if not lib: self._err(400, "Missing ?lib= parameter"); return
            with _lib_locks[lib]:
                self._json(200, _load_views(lib)); return

        if up == "/api/user-data":
            self._json(200, _load_user_data()); return

        if up == "/api/events":
            lib = self._query_lib()
            if not lib: self._err(400, "Missing ?lib= parameter"); return
            if lib not in _eagle_watcher_started:
                _start_eagle_watcher(lib)
            q = _sse_subscribe(lib)
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self._cors(); self.end_headers()
                while True:
                    try:
                        msg = q.get(timeout=30)
                        self.wfile.write(f"data: {msg}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n"); self.wfile.flush()
            except _CONN_ERRORS:
                pass
            finally:
                _sse_unsubscribe(lib, q)
            return

        if up == "/api/item":
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            p = parse_qs(qs)
            item_id = unquote(p.get("id",  [""])[0]).strip()
            lib     = unquote(p.get("lib", [""])[0]).strip()
            if not item_id or not lib: self._err(400, "Missing ?id= or ?lib="); return
            meta = _get_item_meta(lib, item_id)
            if meta is None: self._err(404, "Item not found"); return
            local: dict = {}
            if LIBRARY_PATHS.get(lib):
                info_dir = LIBRARY_PATHS[lib] / "images" / f"{item_id}.info"
                local = _find_local_files(info_dir, lib)
            self._json(200, {"ok": True, "item": {**meta, **local}}); return

        if up == "/api/folders":
            lib = self._query_lib()
            if not lib: self._err(400, "Missing ?lib= parameter"); return
            self._json(200, {"ok": True, "folders": _get_folder_tree(lib)}); return

        if up == "/api/tags-sync/diff":
            lib = self._query_lib()
            if not lib: self._err(400, "Missing ?lib= parameter"); return
            ch = _compute_folder_tags_diff(lib)
            self._json(200, {"ok": True, "changes": ch, "total": len(ch)}); return

        if up == "/api/items-tags-sync/diff":
            lib = self._query_lib()
            if not lib: self._err(400, "Missing ?lib= parameter"); return
            ch = _compute_items_tags_diff(lib)
            self._json(200, {"ok": True, "changes": ch, "total": len(ch)}); return

        if up == "/api/item/links":
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            p = parse_qs(qs)
            item_id = unquote(p.get("id",  [""])[0]).strip()
            lib     = unquote(p.get("lib", [""])[0]).strip()
            if not item_id or not lib: self._err(400, "Missing ?id= or ?lib="); return
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
            self._json(200, {"ok": True, "links": result}); return

        if up.startswith("/api/import/status/"):
            task_id = up[len("/api/import/status/"):]
            st = get_import_status(task_id)
            if st is None: self._err(404, "Task not found"); return
            self._json(200, {"ok": True, "task_id": task_id, **st}); return

        if up.startswith("/api/folder-extract/status/"):
            task_id = up[len("/api/folder-extract/status/"):]
            st = _get_folder_scan_status(task_id)
            if st is None: self._err(404, "Task not found"); return
            self._json(200, {"ok": True, "task_id": task_id, **st}); return

        if up == "/api/services/health":
            self._handle_services_health(); return

        fs, mime = self.translate_path(up)
        if fs is None:
            self._err(404, "Not found: " + up); return
        if not fs.exists():
            self._err(404, "File not found: " + up); return
        if fs.is_dir():
            idx = fs / "index.html"
            if idx.exists():
                fs, mime = idx, "text/html; charset=utf-8"
            else:
                self._err(403, "Directory listing not allowed"); return
        self._serve_file(fs, mime)

    def _handle_services_health(self):
        """GET /api/services/health — 回傳各下載服務連線狀態"""
        try:
            import requests as _req
        except ImportError:
            self._json(200, {"ok": False, "error": "requests not installed"}); return

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
        self._json(200, {"ok": True, "services": results})

    def _serve_file(self, fs: Path, mime: str):
        try:
            size = fs.stat().st_size
        except OSError:
            self._err(500, "Cannot stat file"); return
        range_hdr = self.headers.get("Range", "")
        if range_hdr and mime.startswith("video/"):
            self._serve_range(fs, size, mime, range_hdr); return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(size))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self._send_file_body(fs, 0, size)

    def _serve_range(self, fs: Path, total: int, mime: str, range_hdr: str):
        try:
            m = re.match(r"bytes=(\d*)-(\d*)", range_hdr)
            if not m:
                raise ValueError
            start  = int(m.group(1)) if m.group(1) else 0
            end    = int(m.group(2)) if m.group(2) else total - 1
            end    = min(end, total - 1)
            length = end - start + 1
        except (ValueError, AttributeError):
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{total}")
            self.send_header("Content-Length", "0")
            self.end_headers(); return
        self.send_response(206)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self._send_file_body(fs, start, length)

    def _send_file_body(self, fs: Path, offset: int, length: int):
        try:
            with open(fs, "rb") as fh:
                fh.seek(offset)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ── POST ─────────────────────────────────────────────────────────────────

    def do_POST(self):
        up = self._url_path()

        if up == "/api/config":
            b = self._read_json()
            if b is None: return
            p = str(b.get("library_path", "")).strip()
            if not p: self._err(400, "Missing field: library_path"); return
            r = _add_library_path(p)
            if not r["ok"]: self._err(400, r["error"]); return
            self._json(200, r); return

        if up == "/api/folder-config":
            b = self._read_json()
            if b is None: return
            p = str(b.get("folder_path", "")).strip()
            if not p: self._err(400, "Missing field: folder_path"); return
            r = _add_folder_path(p)
            if not r["ok"]: self._err(400, r["error"]); return
            self._json(200, r); return

        if up == "/api/extract":
            b = self._read_json()
            if b is None: return
            lib = str(b.get("lib", "")).strip()
            if not lib: self._err(400, "Missing field: lib"); return
            r = _index_library(lib)
            self._json(200 if r["ok"] else 500, r); return

        if up == "/api/folder-extract":
            b = self._read_json()
            if b is None: return
            folder = str(b.get("folder", "")).strip()
            if not folder: self._err(400, "Missing field: folder"); return
            task_id = _start_folder_scan(folder)
            self._json(200, {"ok": True, "task_id": task_id}); return

        if up == "/api/track":
            b = self._read_json()
            if b is None: return
            item_id  = str(b.get("id",       "")).strip()
            name     = str(b.get("name",     "")).strip()
            domain   = str(b.get("domain",   "")).strip()
            duration = int(b.get("duration", 0))
            lib      = str(b.get("lib",      "")).strip()
            if not item_id: self._err(400, "Missing field: id"); return
            if not lib:     self._err(400, "Missing field: lib"); return
            self._json(200, {"ok": True, "record": _track_view(lib, item_id, name, domain, duration)}); return

        if up == "/api/delete-view":
            b = self._read_json()
            if b is None: return
            item_id = str(b.get("id",  "")).strip()
            t       = str(b.get("t",   "")).strip()
            lib     = str(b.get("lib", "")).strip()
            if not item_id or not t: self._err(400, "Missing field: id or t"); return
            if not lib:              self._err(400, "Missing field: lib"); return
            self._json(200, {"ok": True, "record": _delete_history_entry(lib, item_id, t)}); return

        if up == "/api/clear-views":
            b = self._read_json()
            if b is None: return
            lib = str(b.get("lib", "")).strip()
            if not lib: self._err(400, "Missing field: lib"); return
            _clear_all_views(lib)
            self._json(200, {"ok": True}); return

        if up == "/api/user-data":
            b = self._read_json(1_048_576)
            if b is None: return
            merged = _merge_user_data(_load_user_data(), b.get("clientData", {}))
            _save_user_data(merged)
            self._json(200, {"merged": merged}); return

        if up == "/api/tags-sync/apply":
            b = self._read_json()
            if b is None: return
            lib = str(b.get("lib", "")).strip()
            if not lib: self._err(400, "Missing field: lib"); return
            applied = _apply_folder_tags_sync(lib)
            _sse_broadcast(lib, {"type": "tags_synced", "lib": lib})
            self._json(200, {"ok": True, "applied": applied}); return

        if up == "/api/items-tags-sync/apply":
            b = self._read_json()
            if b is None: return
            lib = str(b.get("lib", "")).strip()
            if not lib: self._err(400, "Missing field: lib"); return
            applied = _apply_items_tags_sync(lib)
            _sse_broadcast(lib, {"type": "tags_synced", "lib": lib})
            self._json(200, {"ok": True, "applied": applied}); return

        if up == "/api/item/archive":
            b = self._read_json()
            if b is None: return
            item_id = str(b.get("id",  "")).strip()
            lib     = str(b.get("lib", "")).strip()
            if not item_id or not lib: self._err(400, "Missing field: id or lib"); return
            meta = _get_item_meta(lib, item_id)
            if meta is None: self._err(404, "Item not found"); return
            # 嘗試 Eagle 原生 moveToTrash；失敗則 soft-archive（加 archived tag）
            eagle_ok = _write_via_eagle_api("item/moveToTrash", {"itemIds": [item_id]})
            tags = meta.get("tags", [])
            if "archived" not in tags:
                tags = tags + ["archived"]
                meta["tags"] = tags
                _write_item_meta(lib, item_id, meta)
                _patch_item_cache(lib, item_id, {"tags": tags})
                _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
            self._json(200, {"ok": True, "eagle_trash": eagle_ok}); return

        if up == "/api/item/restore":
            b = self._read_json()
            if b is None: return
            item_id = str(b.get("id",  "")).strip()
            lib     = str(b.get("lib", "")).strip()
            if not item_id or not lib: self._err(400, "Missing field: id or lib"); return
            meta = _get_item_meta(lib, item_id)
            if meta is None: self._err(404, "Item not found"); return
            # Eagle V2 API（4.0 Build 21+）：isDeleted=false 從垃圾桶還原
            eagle_ok = _write_via_eagle_api_v2("item/update", {"id": item_id, "isDeleted": False})
            tags = [t for t in meta.get("tags", []) if t != "archived"]
            meta["tags"] = tags
            _write_item_meta(lib, item_id, meta)
            _patch_item_cache(lib, item_id, {"tags": tags})
            _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
            self._json(200, {"ok": True, "eagle_restore": eagle_ok}); return

        if up == "/api/items/restore-batch":
            b = self._read_json()
            if b is None: return
            ids = [str(x).strip() for x in b.get("ids", [])]
            lib = str(b.get("lib", "")).strip()
            if not ids or not lib: self._err(400, "Missing field: ids or lib"); return
            restored = []
            for item_id in ids:
                meta = _get_item_meta(lib, item_id)
                if meta is None: continue
                tags = [t for t in meta.get("tags", []) if t != "archived"]
                meta["tags"] = tags
                _write_item_meta(lib, item_id, meta)
                _patch_item_cache(lib, item_id, {"tags": tags})
                # Eagle V2 API（4.0 Build 21+）：isDeleted=false 從垃圾桶還原
                _write_via_eagle_api_v2("item/update", {"id": item_id, "isDeleted": False})
                restored.append(item_id)
            if restored:
                _sse_broadcast(lib, {"type": "items_restored", "ids": restored, "lib": lib})
            self._json(200, {"ok": True, "restored": restored}); return

        if up == "/api/items/archive-batch":
            b = self._read_json()
            if b is None: return
            ids = [str(x).strip() for x in b.get("ids", [])]
            lib = str(b.get("lib", "")).strip()
            if not ids or not lib: self._err(400, "Missing field: ids or lib"); return
            archived = []
            for item_id in ids:
                meta = _get_item_meta(lib, item_id)
                if meta is None: continue
                tags = meta.get("tags", [])
                if "archived" not in tags:
                    tags = tags + ["archived"]
                    meta["tags"] = tags
                    _write_item_meta(lib, item_id, meta)
                    _patch_item_cache(lib, item_id, {"tags": tags})
                    _write_via_eagle_api("item/moveToTrash", {"itemIds": [item_id]})
                archived.append(item_id)
            if archived:
                _sse_broadcast(lib, {"type": "items_archived", "ids": archived, "lib": lib})
            self._json(200, {"ok": True, "archived": archived}); return

        if up == "/api/items/folders-batch":
            b = self._read_json()
            if b is None: return
            ids        = [str(x).strip() for x in b.get("ids", [])]
            lib        = str(b.get("lib", "")).strip()
            folder_ids = [str(x).strip() for x in b.get("folder_ids", [])]
            if not ids or not lib: self._err(400, "Missing field: ids or lib"); return
            updated = []
            for item_id in ids:
                meta = _get_item_meta(lib, item_id)
                if meta is None: continue
                meta["folders"] = folder_ids
                _write_item_meta(lib, item_id, meta)
                _patch_item_cache(lib, item_id, {"folders": folder_ids})
                updated.append(item_id)
            self._json(200, {"ok": True, "updated": updated}); return

        if up == "/api/items/delete-batch":
            b = self._read_json()
            if b is None: return
            ids = [str(x).strip() for x in b.get("ids", [])]
            lib = str(b.get("lib", "")).strip()
            if not ids or not lib: self._err(400, "Missing field: ids or lib"); return
            lib_path = LIBRARY_PATHS.get(lib)
            deleted = []
            for item_id in ids:
                if lib_path:
                    info_dir = lib_path / "images" / f"{item_id}.info"
                    if info_dir.exists():
                        with _lib_locks[lib]:
                            shutil.rmtree(info_dir, ignore_errors=True)
                _remove_item_cache(lib, item_id)
                deleted.append(item_id)
                _sse_broadcast(lib, {"type": "item_deleted", "id": item_id, "lib": lib})
            self._json(200, {"ok": True, "deleted": deleted}); return

        if up == "/api/item/link":
            b = self._read_json()
            if b is None: return
            item_id   = str(b.get("id",        "")).strip()
            lib       = str(b.get("lib",       "")).strip()
            target_id = str(b.get("target_id", "")).strip()
            if not item_id or not lib or not target_id:
                self._err(400, "Missing field: id, lib, or target_id"); return
            _add_link(lib, item_id, target_id)
            self._json(200, {"ok": True}); return

        if up == "/api/import/upload":
            ct = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in ct:
                self._err(400, "Expected multipart/form-data"); return
            cl_raw = self.headers.get("Content-Length", "0")
            try:
                cl = int(cl_raw)
            except ValueError:
                cl = 0
            if cl > 2 * 1024 * 1024 * 1024:
                self._err(413, "File too large (max 2 GB)"); return
            raw   = self.rfile.read(cl)
            parts = _parse_multipart(raw, ct)
            if not parts:
                self._err(400, "multipart 解析失敗，請確認上傳格式"); return
            file_bytes, file_name = parts.get("file", (b"", None))
            lib  = parts.get("lib",  (b"",))[0].decode("utf-8", errors="replace").strip()
            name = parts.get("name", (b"",))[0].decode("utf-8", errors="replace").strip()
            if not file_bytes or not file_name or not lib:
                self._err(400, "Missing required fields: file, lib"); return
            r = _create_eagle_item_from_file(lib, "", file_name, file_bytes, custom_name=name)
            if not r["ok"]:
                self._err(500, r.get("error", "Upload failed")); return
            _sse_broadcast(lib, {"type": "item_created", "id": r["id"], "lib": lib})
            self._json(200, {"ok": True, "id": r["id"], "name": r["name"]}); return

        if up == "/api/import/url":
            b = self._read_json()
            if b is None: return
            url  = str(b.get("url",  "")).strip()
            lib  = str(b.get("lib",  "")).strip()
            name = str(b.get("name", "")).strip()
            if not url or not lib:
                self._err(400, "Missing field: url or lib"); return
            task_id = start_import_url(url, lib, name=name)
            self._json(200, {"ok": True, "task_id": task_id}); return

        self._err(404, "Not found")

    # ── PATCH ────────────────────────────────────────────────────────────────

    def do_PATCH(self):
        up  = self._url_path()
        b = self._read_json(1_048_576)
        if b is None: return

        if up == "/api/item/move":
            item_id   = str(b.get("id",        "")).strip()
            lib       = str(b.get("lib",       "")).strip()
            folder_id = str(b.get("folder_id", "")).strip()
            if not item_id or not lib or not folder_id:
                self._err(400, "Missing field: id, lib, or folder_id"); return
            meta = _get_item_meta(lib, item_id)
            if meta is None: self._err(404, "Item not found"); return
            new_tags = _build_folder_map(lib).get(folder_id, [])
            meta["folders"] = [folder_id]; meta["tags"] = new_tags
            _write_via_eagle_api("item/move", {"itemId": item_id, "folderId": folder_id})
            _write_item_meta(lib, item_id, meta)
            _patch_item_cache(lib, item_id, {"tags": new_tags})
            _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
            self._json(200, {"ok": True, "new_tags": new_tags}); return

        if up == "/api/item/rename":
            item_id = str(b.get("id",   "")).strip()
            lib     = str(b.get("lib",  "")).strip()
            name    = str(b.get("name", "")).strip()
            if not item_id or not lib or not name:
                self._err(400, "Missing field: id, lib, or name"); return
            meta = _get_item_meta(lib, item_id)
            if meta is None: self._err(404, "Item not found"); return
            meta["name"] = name
            _write_item_meta(lib, item_id, meta)
            _patch_item_cache(lib, item_id, {"name": name})
            _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
            self._json(200, {"ok": True}); return

        if up == "/api/item/tags":
            item_id = str(b.get("id",  "")).strip()
            lib     = str(b.get("lib", "")).strip()
            tags    = b.get("tags", [])
            if not item_id or not lib: self._err(400, "Missing field: id or lib"); return
            if not isinstance(tags, list): self._err(400, "tags must be an array"); return
            meta = _get_item_meta(lib, item_id)
            if meta is None: self._err(404, "Item not found"); return
            meta["tags"] = tags
            _write_item_meta(lib, item_id, meta)
            _patch_item_cache(lib, item_id, {"tags": tags})
            _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
            self._json(200, {"ok": True}); return

        if up == "/api/item/folders":
            item_id    = str(b.get("id",  "")).strip()
            lib        = str(b.get("lib", "")).strip()
            folder_ids = b.get("folder_ids", [])
            if not item_id or not lib: self._err(400, "Missing field: id or lib"); return
            if not isinstance(folder_ids, list) or not folder_ids:
                self._err(400, "folder_ids must be a non-empty array"); return
            meta = _get_item_meta(lib, item_id)
            if meta is None: self._err(404, "Item not found"); return
            folder_map = _build_folder_map(lib)
            seen: set = set()
            union_tags: list = []
            for fid in folder_ids:
                for t in folder_map.get(fid, []):
                    if t not in seen:
                        seen.add(t)
                        union_tags.append(t)
            hidden = [t for t in meta.get("tags", []) if t == "archived"]
            new_tags = [*hidden, *[t for t in union_tags if t not in hidden]]
            meta["folders"] = folder_ids
            meta["tags"]    = new_tags
            _write_item_meta(lib, item_id, meta)
            _patch_item_cache(lib, item_id, {"folders": folder_ids, "tags": new_tags})
            _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
            self._json(200, {"ok": True, "new_tags": new_tags}); return

        if up == "/api/item/star":
            item_id = str(b.get("id",  "")).strip()
            lib     = str(b.get("lib", "")).strip()
            star    = b.get("star", 0)
            if not item_id or not lib: self._err(400, "Missing field: id or lib"); return
            if not isinstance(star, int) or star < 0 or star > 5:
                self._err(400, "star must be integer 0-5"); return
            meta = _get_item_meta(lib, item_id)
            if meta is None: self._err(404, "Item not found"); return
            meta["star"] = star
            _write_item_meta(lib, item_id, meta)
            _patch_item_cache(lib, item_id, {"star": star})
            _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
            self._json(200, {"ok": True}); return

        if up == "/api/item/annotation":
            item_id    = str(b.get("id",         "")).strip()
            lib        = str(b.get("lib",        "")).strip()
            annotation = str(b.get("annotation", ""))
            if not item_id or not lib: self._err(400, "Missing field: id or lib"); return
            meta = _get_item_meta(lib, item_id)
            if meta is None: self._err(404, "Item not found"); return
            meta["annotation"] = annotation
            _write_item_meta(lib, item_id, meta)
            _patch_item_cache(lib, item_id, {"annotation": annotation})
            _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
            self._json(200, {"ok": True}); return

        if up == "/api/item/url":
            item_id = str(b.get("id",  "")).strip()
            lib     = str(b.get("lib", "")).strip()
            url     = str(b.get("url", "")).strip()
            if not item_id or not lib: self._err(400, "Missing field: id or lib"); return
            meta = _get_item_meta(lib, item_id)
            if meta is None: self._err(404, "Item not found"); return
            meta["url"] = url
            _write_item_meta(lib, item_id, meta)
            _patch_item_cache(lib, item_id, {"url": url})
            _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
            self._json(200, {"ok": True}); return

        self._err(404, "Not found")

    # ── DELETE ───────────────────────────────────────────────────────────────

    def do_DELETE(self):
        up = self._url_path()

        if up == "/api/item":
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            p  = parse_qs(qs)
            item_id = unquote(p.get("id",  [""])[0]).strip()
            lib     = unquote(p.get("lib", [""])[0]).strip()
            if not item_id or not lib: self._err(400, "Missing ?id= or ?lib="); return
            lib_path = LIBRARY_PATHS.get(lib)
            if lib_path is None: self._err(404, "Library not found"); return
            info_dir = lib_path / "images" / f"{item_id}.info"
            if not info_dir.exists(): self._err(404, "Item not found"); return
            with _lib_locks[lib]:
                shutil.rmtree(info_dir, ignore_errors=True)
            _remove_item_cache(lib, item_id)
            _sse_broadcast(lib, {"type": "item_deleted", "id": item_id, "lib": lib})
            self._json(200, {"ok": True}); return

        if up == "/api/item/link":
            b = self._read_json()
            if b is None: return
            item_id   = str(b.get("id",        "")).strip()
            lib       = str(b.get("lib",       "")).strip()
            target_id = str(b.get("target_id", "")).strip()
            if not item_id or not lib or not target_id:
                self._err(400, "Missing field: id, lib, or target_id"); return
            _remove_link(lib, item_id, target_id)
            self._json(200, {"ok": True}); return

        self._err(404, "Not found")


# ---------------------------------------------------------------------------
# Local IP discovery
# ---------------------------------------------------------------------------

def _local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(1)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    _load_config()

    if LIBRARY_PATHS:
        print("自動索引中（mtime 增量模式）...")
        for lib_name in sorted(LIBRARY_PATHS):
            has_data     = (DATA_DIR / lib_name / "urls_data.json").exists()
            manifest_p   = DATA_DIR / lib_name / ".index_manifest.json"
            has_manifest = manifest_p.exists()
            if has_manifest:
                try:
                    mv = json.loads(manifest_p.read_text(encoding="utf-8")).get("schema_version", 1)
                    if mv != SCHEMA_VERSION:
                        print(f"  [{lib_name}] schema v{mv}→v{SCHEMA_VERSION}，強制全量重建")
                        manifest_p.unlink(missing_ok=True)
                        has_manifest = False
                except Exception:
                    pass
            if has_data and has_manifest:
                _run_incremental(lib_name)
            else:
                _run_one(lib_name)
        print("索引完成。")

    port = 8765
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Warning: invalid port '{sys.argv[1]}', using {port}")

    ip = _local_ip()
    from socketserver import TCPServer
    TCPServer.allow_reuse_address = True
    server = _Server(("0.0.0.0", port), _Handler)

    bar = "=" * 54
    print(bar)
    print("  Eagle App Media Viewer  [threaded / multi-library]")
    print(bar)
    print(f"  Localhost :  http://localhost:{port}/")
    print(f"  Network   :  http://{ip}:{port}/")
    print(f"  Viewer dir:  {VIEWER_DIR}")
    lib_info = f"{len(LIBRARY_PATHS)} 個資源庫" if LIBRARY_PATHS else "(尚未設定 — 開啟瀏覽器新增)"
    print(f"  Libraries :  {lib_info}")
    print(f"  Data dir  :  {DATA_DIR}")
    print("  Press Ctrl-C to stop.")
    print(bar)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")


if __name__ == "__main__":
    main()
