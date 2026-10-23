"""File streaming for the viewer HTTP server.

MIME 判定、靜態路徑解析（translate_path）、檔案本體/Range 串流，
以及 Excire 媒體路由（縮圖/預覽/原圖 fallback）。

所有 handle_* / serve_* 函式的第一參數 ``h`` 為 BaseHTTPRequestHandler 實例
（serve.py 的 _Handler），僅透過其公開介面（send_response/_json/_err/headers/wfile）操作。
"""
import re
from pathlib import Path

from config import DATA_DIR, FOLDER_PATHS, LIBRARY_PATHS, VIEWER_DIR
from excire import get_excire_library

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
# Static path translation
# ---------------------------------------------------------------------------

def translate_path(url_path: str):
    if url_path == "/app" or url_path.startswith("/app/"):
        rel = url_path[len("/app/"):] if url_path.startswith("/app/") else ""
        app_root = (VIEWER_DIR / "app").resolve()
        fs = (app_root / (rel or "index.html")).resolve()
        if not str(fs).startswith(str(app_root)):
            return None, None
        return fs, _guess_mime(fs)

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


# ---------------------------------------------------------------------------
# File body / Range streaming
# ---------------------------------------------------------------------------

def serve_file(h, fs: Path, mime: str, cache: int = 0):
    try:
        size = fs.stat().st_size
    except OSError:
        h._err(500, "Cannot stat file"); return
    range_hdr = h.headers.get("Range", "")
    if range_hdr and mime.startswith("video/"):
        _serve_range(h, fs, size, mime, range_hdr); return
    h.send_response(200)
    h.send_header("Content-Type", mime)
    h.send_header("Content-Length", str(size))
    h.send_header("Accept-Ranges", "bytes")
    if cache > 0:
        h.send_header("Cache-Control", f"public, max-age={cache}")
    h.end_headers()
    _send_file_body(h, fs, 0, size)


def _serve_range(h, fs: Path, total: int, mime: str, range_hdr: str):
    try:
        m = re.match(r"bytes=(\d*)-(\d*)", range_hdr)
        if not m:
            raise ValueError
        start  = int(m.group(1)) if m.group(1) else 0
        end    = int(m.group(2)) if m.group(2) else total - 1
        end    = min(end, total - 1)
        length = end - start + 1
    except (ValueError, AttributeError):
        h.send_response(416)
        h.send_header("Content-Range", f"bytes */{total}")
        h.send_header("Content-Length", "0")
        h.end_headers(); return
    h.send_response(206)
    h.send_header("Content-Type", mime)
    h.send_header("Content-Range", f"bytes {start}-{end}/{total}")
    h.send_header("Content-Length", str(length))
    h.send_header("Accept-Ranges", "bytes")
    h.end_headers()
    _send_file_body(h, fs, start, length)


def _send_file_body(h, fs: Path, offset: int, length: int):
    try:
        with open(fs, "rb") as fh:
            fh.seek(offset)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(65536, remaining))
                if not chunk:
                    break
                h.wfile.write(chunk)
                remaining -= len(chunk)
    except (BrokenPipeError, ConnectionResetError):
        pass


# ---------------------------------------------------------------------------
# Excire media routes
# ---------------------------------------------------------------------------

def handle_excire_media(h, up: str):
    """GET /excire-thumb|/excire-preview|/excire-file/{lib}/{photo_id}
    縮圖 → 預覽 → 原圖逐層 fallback；原圖/影片走 serve_file（支援 Range）。"""
    m = re.match(r"^/excire-(thumb|preview|file)/([^/]+)/(\d+)$", up)
    if not m:
        h._err(404, "Not found: " + up); return
    kind, lib_name, photo_id = m.group(1), m.group(2), int(m.group(3))
    lib = get_excire_library(lib_name)
    if lib is None:
        h._err(404, f"Excire 資源庫未設定：{lib_name}"); return
    if not lib.available:
        h._err(503, f"Excire 資源庫無法使用：{lib_name}"); return

    if kind == "thumb":
        chain = [lib.thumb_path(photo_id), lib.preview_path(photo_id),
                 lib.original_path(photo_id)]
    elif kind == "preview":
        chain = [lib.preview_path(photo_id), lib.thumb_path(photo_id),
                 lib.original_path(photo_id)]
    else:
        chain = [lib.original_path(photo_id)]

    fs = next((p for p in chain if p is not None and p.exists()), None)
    if fs is None:
        h._err(404, f"找不到照片檔案：{lib_name}/{photo_id}"); return
    # 縮圖/預覽為內容穩定的 JPG → 長效快取；原圖不快取
    cache = 86400 if kind in ("thumb", "preview") else 0
    serve_file(h, fs, _guess_mime(fs), cache=cache)
