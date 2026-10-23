#!/usr/bin/env python3
"""
Eagle App Media Viewer – local HTTP server (threaded edition)
Serves viewer/ and Eagle library images plus a management API.
Usage: python serve.py [port]   (default port: 8765)

模組分工：
    serve.py        — _Handler 骨架 + routing dispatch + SSE + main()
    api_routes.py   — GET endpoint handlers + views 儲存 + folder-scan 任務
    api_mutations.py— POST/PATCH/DELETE endpoint handlers
    api_ai.py       — AI 語意/人臉搜尋 + 背景索引任務（/api/ai/*）
    media_serve.py  — 檔案串流（mime/Range/縮圖）+ Excire 媒體路由
    eagle_watch.py  — Eagle library 背景 watcher（SSE 事件來源）
"""

import json
import queue
import re
import socket
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, unquote

from config import (
    DATA_DIR, LIBRARY_PATHS, FOLDER_PATHS, EXCIRE_PATHS, SCHEMA_VERSION,
    VIEWER_DIR, _load_config,
)
from extract import _prune_stale_folder_items, _run_incremental, _run_one
from api_helpers import _sse_subscribe, _sse_unsubscribe
from eagle_watch import _eagle_watcher_started, _start_eagle_watcher
import media_serve
import api_routes as _r
import api_mutations as _m
import api_ai as _ai

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
        return media_serve.translate_path(url_path)

    def _serve_file(self, fs: Path, mime: str, cache: int = 0):
        media_serve.serve_file(self, fs, mime, cache=cache)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ── GET ──────────────────────────────────────────────────────────────────

    def do_GET(self):
        up = self._url_path()

        if up == "/":
            # P4-B6 新舊 UI 並存：預設 = 新版 /app/；?ui=classic 回舊版（逃生門）。
            # 明確帶 ?ui= 時以 cookie 記憶選擇；無參數時依 cookie，預設 new。
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            ui = parse_qs(qs).get("ui", [""])[0]
            explicit = ui in ("new", "classic")
            if not explicit:
                m = re.search(r"(?:^|;\s*)ev_ui=(\w+)", self.headers.get("Cookie", ""))
                ui = m.group(1) if m else "new"
            target = "/viewer/" if ui == "classic" else "/app/"
            try:
                self.send_response(302)
                self.send_header("Location", target)
                if explicit:
                    self.send_header(
                        "Set-Cookie",
                        f"ev_ui={ui}; Path=/; Max-Age=31536000; SameSite=Lax")
                self.send_header("Content-Length", "0")
                self.end_headers()
            except _CONN_ERRORS:
                pass
            return

        if up == "/api/browse":
            _r.handle_browse(self); return

        if up == "/api/browse-dir":
            _r.handle_browse_dir(self); return

        if up == "/api/config":
            _r.handle_config(self); return

        if up == "/api/libraries":
            _r.handle_libraries(self); return

        if up == "/api/folder-sources":
            _r.handle_folder_sources(self); return

        if up == "/api/excire/libraries" or up.startswith("/api/excire/"):
            _r.handle_excire_api(self, up); return

        if up.startswith("/api/ai/"):
            _ai.handle_ai_get(self, up); return

        if up.startswith(("/excire-thumb/", "/excire-preview/", "/excire-file/")):
            media_serve.handle_excire_media(self, up); return

        if up == "/api/views":
            _r.handle_views(self); return

        if up == "/api/user-data":
            _r.handle_user_data(self); return

        if up == "/api/events":
            self._handle_sse(); return

        if up == "/api/item":
            _r.handle_item(self); return

        if up == "/api/folders":
            _r.handle_folders(self); return

        if up == "/api/tags-sync/diff":
            _r.handle_tags_sync_diff(self); return

        if up == "/api/items-tags-sync/diff":
            _r.handle_items_tags_sync_diff(self); return

        if up == "/api/item/links":
            _r.handle_item_links(self); return

        if up.startswith("/api/import/status/"):
            _r.handle_import_status(self, up); return

        if up.startswith("/api/folder-extract/status/"):
            _r.handle_folder_extract_status(self, up); return

        if up == "/api/services/health":
            _r.handle_services_health(self); return

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

    # ── SSE ──────────────────────────────────────────────────────────────────

    def _handle_sse(self):
        """GET /api/events — Server-Sent Events 長連線（含 keepalive）"""
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

    # ── POST ─────────────────────────────────────────────────────────────────

    def do_POST(self):
        up = self._url_path()

        if up == "/api/config":
            _m.handle_post_config(self); return

        if up == "/api/folder-config":
            _m.handle_post_folder_config(self); return

        if up == "/api/extract":
            _m.handle_post_extract(self); return

        if up == "/api/folder-extract":
            _m.handle_post_folder_extract(self); return

        if up == "/api/track":
            _m.handle_post_track(self); return

        if up == "/api/delete-view":
            _m.handle_post_delete_view(self); return

        if up == "/api/clear-views":
            _m.handle_post_clear_views(self); return

        if up == "/api/user-data":
            _m.handle_post_user_data(self); return

        if up == "/api/tags-sync/apply":
            _m.handle_post_tags_sync_apply(self); return

        if up == "/api/items-tags-sync/apply":
            _m.handle_post_items_tags_sync_apply(self); return

        if up == "/api/item/archive":
            _m.handle_post_item_archive(self); return

        if up == "/api/item/restore":
            _m.handle_post_item_restore(self); return

        if up == "/api/items/restore-batch":
            _m.handle_post_items_restore_batch(self); return

        if up == "/api/items/archive-batch":
            _m.handle_post_items_archive_batch(self); return

        if up == "/api/items/folders-batch":
            _m.handle_post_items_folders_batch(self); return

        if up == "/api/items/delete-batch":
            _m.handle_post_items_delete_batch(self); return

        if up == "/api/item/link":
            _m.handle_post_item_link(self); return

        if up == "/api/import/upload":
            _m.handle_post_import_upload(self); return

        if up == "/api/import/url":
            _m.handle_post_import_url(self); return

        if up.startswith("/api/ai/"):
            _ai.handle_ai_post(self, up); return

        self._err(404, "Not found")

    # ── PATCH ────────────────────────────────────────────────────────────────

    def do_PATCH(self):
        up  = self._url_path()
        b = self._read_json(1_048_576)
        if b is None: return

        if up == "/api/item/move":
            _m.handle_patch_item_move(self, b); return

        if up == "/api/item/rename":
            _m.handle_patch_item_rename(self, b); return

        if up == "/api/item/tags":
            _m.handle_patch_item_tags(self, b); return

        if up == "/api/item/folders":
            _m.handle_patch_item_folders(self, b); return

        if up == "/api/item/star":
            _m.handle_patch_item_star(self, b); return

        if up == "/api/item/annotation":
            _m.handle_patch_item_annotation(self, b); return

        if up == "/api/item/url":
            _m.handle_patch_item_url(self, b); return

        self._err(404, "Not found")

    # ── DELETE ───────────────────────────────────────────────────────────────

    def do_DELETE(self):
        up = self._url_path()

        if up == "/api/item":
            _m.handle_delete_item(self); return

        if up == "/api/item/link":
            _m.handle_delete_item_link(self); return

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

    if FOLDER_PATHS:
        print("清理 folder sources 過期項目...")
        for folder_name in sorted(FOLDER_PATHS):
            pruned = _prune_stale_folder_items(folder_name)
            if pruned > 0:
                print(f"  [{folder_name}] 移除 {pruned} 個已刪除的檔案紀錄")
        print("Folder 清理完成。")

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
    if EXCIRE_PATHS:
        print(f"  Excire    :  {len(EXCIRE_PATHS)} 個資源庫（唯讀）: {', '.join(sorted(EXCIRE_PATHS))}")
    print(f"  Data dir  :  {DATA_DIR}")
    print("  Press Ctrl-C to stop.")
    print(bar)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")


if __name__ == "__main__":
    main()
