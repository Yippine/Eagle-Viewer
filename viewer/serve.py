#!/usr/bin/env python3
"""
Eagle App Media Viewer – local HTTP server  (threaded edition)
Serves viewer/ and Eagle library images plus a simple views-tracking API.
Supports multiple Eagle libraries via per-request lib parameter.

Usage:
    python serve.py [port]   (default port: 8080)

Routes:
    GET  /                      → 302 → /viewer/
    GET  /viewer/*              → VIEWER_DIR  (script's parent directory)
    GET  /images/{lib}/*        → EAGLE_ROOT/{lib}/images/*
    GET  /data/{lib}/*          → DATA_DIR/{lib}/*
    GET  /api/libraries         → list all Eagle libraries with extracted status
    GET  /api/views?lib={lib}   → return data/{lib}/views.json content (or {})
    POST /api/extract           → extract a library; body: {lib}
    POST /api/track             → record a view event; body: {id, name, domain, lib}
    POST /api/delete-view       → delete one history entry; body: {id, t, lib}
    POST /api/clear-views       → wipe views for a library; body: {lib}
"""

import json
import os
import re
import socket
import sys
import threading
from collections import defaultdict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, unquote

# ---------------------------------------------------------------------------
# Directory layout
# ---------------------------------------------------------------------------
SCRIPT_DIR  = Path(__file__).resolve().parent              # → viewer/
VIEWER_DIR  = SCRIPT_DIR
PROJECT_DIR = VIEWER_DIR.parent                            # → Eagle-Viewer/
DATA_DIR    = PROJECT_DIR / "data"
CONFIG_FILE   = DATA_DIR / "config.json"
LIBRARY_PATHS: dict = {}   # lib folder name → full Path; populated by _load_config()

MAX_HISTORY = 2000   # max history entries kept per item

# ---------------------------------------------------------------------------
# URL Classification  (inlined from scripts/extract_urls.py)
# ---------------------------------------------------------------------------

VIDEO_PATTERNS = [
    # YouTube
    r"youtube\.com/watch",
    r"youtu\.be/",
    r"youtube\.com/shorts/",
    # Bilibili
    r"bilibili\.com/video/",
    r"b23\.tv/",
    # Twitter/X 影片
    r"twitter\.com/.+/status/.+",
    r"x\.com/.+/status/.+",
    # TikTok
    r"tiktok\.com/",
    r"vm\.tiktok\.com/",
    # Instagram Reels
    r"instagram\.com/reel/",
    r"instagram\.com/tv/",
    # Vimeo
    r"vimeo\.com/\d+",
    # Reddit 影片
    r"v\.redd\.it/",
    # 色情平台
    r"pornhub\.com/view_video",
    r"xvideos\.com/video",
    r"xhamster\.com/videos/",
    r"nhentai\.net/g/",
    r"rule34video\.com/videos/",
    r"kemono\.party/.+/post/",
    r"iwara\.tv/video/",
    r"dlsite\.com/",
    # 通用副檔名
    r"\.(mp4|webm|m3u8|flv|avi|mov)(\?|$)",
]

POST_PATTERNS = [
    # Twitter/X 貼文
    r"twitter\.com/.+/status/\d+$",
    r"x\.com/.+/status/\d+$",
    # Instagram 貼文
    r"instagram\.com/p/",
    # Reddit
    r"reddit\.com/r/.+/comments/",
    # Pixiv
    r"pixiv\.net/artworks/",
    r"pixiv\.net/en/artworks/",
    # Danbooru / Gelbooru 類
    r"danbooru\.donmai\.us/posts/",
    r"gelbooru\.com/index\.php.*id=",
    r"rule34\.xxx/index\.php.*id=",
    r"rule34\.paheal\.net/post/",
    r"safebooru\.org/index\.php.*id=",
    r"yande\.re/post/show/",
    r"konachan\.com/post/show/",
    r"e-hentai\.org/g/",
    r"e-hentai\.org/s/",
    r"exhentai\.org/",
    r"nhentai\.net/g/",
    # Kemono / Coomer 貼文
    r"kemono\.(party|su)/.+/post/",
    r"coomer\.(party|su)/",
    # Tumblr
    r"tumblr\.com/post/",
    # DeviantArt
    r"deviantart\.com/.+/art/",
    # ArtStation
    r"artstation\.com/artwork/",
    # Fanbox
    r"fanbox\.cc/.+/posts/",
    r"\.fanbox\.cc/posts/",
]

MEDIA_EXTS = {
    ".jpg": "image", ".jpeg": "image", ".png": "image",
    ".gif": "image", ".webp": "image", ".avif": "image", ".bmp": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video",
    ".avi": "video", ".mkv": "video", ".m4v": "video",
}


def _find_local_files(info_dir: Path, lib_name: str) -> dict:
    """在 .info 資料夾中尋找縮圖與媒體檔。"""
    from urllib.parse import urlparse as _urlparse  # already imported at module level
    thumb = None
    media_file = None
    media_type = ""
    try:
        for f in info_dir.iterdir():
            if not f.is_file():
                continue
            if f.name.endswith("_thumbnail.png"):
                thumb = f"images/{lib_name}/{info_dir.name}/{f.name}"
            elif f.name != "metadata.json" and f.suffix.lower() in MEDIA_EXTS:
                media_file = f"images/{lib_name}/{info_dir.name}/{f.name}"
                media_type = MEDIA_EXTS[f.suffix.lower()]
    except Exception:
        pass
    return {"thumb": thumb, "file": media_file, "media_type": media_type}


def _classify_url(url: str) -> str:
    """回傳 'video' | 'post' | 'other'"""
    if not url:
        return "other"
    u = url.lower()
    for pat in VIDEO_PATTERNS:
        if re.search(pat, u):
            return "video"
    for pat in POST_PATTERNS:
        if re.search(pat, u):
            return "post"
    return "other"


def _get_domain(url: str) -> str:
    from urllib.parse import urlparse as _urlparse
    try:
        host = _urlparse(url).netloc.lower()
        host = re.sub(r"^www\.", "", host)
        return host or "unknown"
    except Exception:
        return "unknown"


def _run_one(lib_name: str) -> bool:
    """匯出單一資源庫。成功回傳 True，失敗回傳 False。"""
    from collections import defaultdict as _defaultdict
    import sys as _sys

    lib_path = LIBRARY_PATHS.get(lib_name)
    if lib_path is None:
        print(f"[錯誤] 資源庫未設定：{lib_name}", file=_sys.stderr)
        return False

    library_dir = lib_path / "images"
    output_dir  = DATA_DIR / lib_name

    if not library_dir.exists():
        print(f"[錯誤] 找不到資源庫目錄：{library_dir}", file=_sys.stderr)
        return False

    items = []
    info_dirs = [d for d in library_dir.iterdir() if d.is_dir() and d.suffix == ".info"]
    print(f"找到 {len(info_dirs)} 個項目，開始解析...")

    for info_dir in sorted(info_dirs):
        meta_path = info_dir / "metadata.json"
        if not meta_path.exists():
            continue
        try:
            with open(meta_path, encoding="utf-8") as f:
                meta = json.load(f)
        except Exception as e:
            print(f"  [跳過] {info_dir.name}: {e}")
            continue

        url   = meta.get("url", "").strip()
        local = _find_local_files(info_dir, lib_name)

        if not url and not local["file"] and not local["thumb"]:
            continue

        if url:
            domain = _get_domain(url)
            kind   = _classify_url(url)
        else:
            domain = "local"
            kind   = "video" if local["media_type"] == "video" else "other"

        w = meta.get("width")
        h = meta.get("height")
        items.append({
            "id":         meta.get("id", ""),
            "name":       meta.get("name", ""),
            "url":        url,
            "domain":     domain,
            "kind":       kind,
            "tags":       meta.get("tags", []),
            "thumb":      local["thumb"],
            "file":       local["file"],
            "media_type": local["media_type"],
            "width":      w if isinstance(w, int) and w > 0 else None,
            "height":     h if isinstance(h, int) and h > 0 else None,
        })

    # Deduplicate by Eagle item ID (guard against library having duplicate metadata IDs)
    seen_ids: set = set()
    deduped = []
    for item in items:
        if item["id"] and item["id"] not in seen_ids:
            seen_ids.add(item["id"])
            deduped.append(item)
    if len(deduped) < len(items):
        print(f"  [警告] 移除 {len(items) - len(deduped)} 筆重複 ID 項目")
    items = deduped

    total_local = sum(1 for i in items if i["domain"] == "local")
    print(f"有效項目：{len(items)} 筆（含 {total_local} 筆無 URL 本地項目）")

    grouped: dict = _defaultdict(list)
    for item in items:
        grouped[item["domain"]].append(item)
    sorted_domains = sorted(grouped.items(), key=lambda x: -len(x[1]))

    total_video = sum(1 for i in items if i["kind"] == "video")
    total_post  = sum(1 for i in items if i["kind"] == "post")
    total_other = sum(1 for i in items if i["kind"] == "other")

    output_dir.mkdir(parents=True, exist_ok=True)

    json_data = {
        "library": lib_name,
        "stats": {
            "total":   len(items),
            "video":   total_video,
            "post":    total_post,
            "other":   total_other,
            "domains": len(sorted_domains),
        },
        "items": [
            {
                "id":         i["id"],
                "name":       i["name"],
                "url":        i["url"],
                "domain":     i["domain"],
                "kind":       i["kind"],
                "tags":       i["tags"],
                "thumb":      i["thumb"],
                "file":       i["file"],
                "media_type": i["media_type"],
                "width":      i["width"],
                "height":     i["height"],
            }
            for i in items
        ],
    }
    json_file = output_dir / "urls_data.json"
    tmp = json_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(json_data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(json_file)
    print(f"  JSON：{json_file}（網域數 {len(sorted_domains)}，影片 {total_video}，貼文 {total_post}，其他 {total_other}）")
    _images = lib_path / "images"
    _manifest_items = {}
    with os.scandir(_images) as _it:
        for _e in _it:
            if _e.is_dir() and _e.name.endswith(".info"):
                try:
                    _manifest_items[_e.name] = _e.stat().st_mtime
                except OSError:
                    pass
    _save_manifest(lib_name, _manifest_items, _images.stat().st_mtime)
    return True

# ---------------------------------------------------------------------------
# Manifest helpers  (mtime-based incremental index)
# ---------------------------------------------------------------------------

def _load_manifest(lib_name: str) -> dict:
    p = DATA_DIR / lib_name / ".index_manifest.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_manifest(lib_name: str, items_mtime: dict, dir_mtime: float = 0.0) -> None:
    p = DATA_DIR / lib_name / ".index_manifest.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(
        json.dumps({
            "indexed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "dir_mtime":  dir_mtime,
            "items":      items_mtime,
        }, ensure_ascii=False),
        encoding="utf-8",
    )
    tmp.replace(p)


def _run_incremental(lib_name: str) -> bool:
    """mtime 增量索引：兩層檢查，僅重建有異動的項目。"""
    lib_path = LIBRARY_PATHS.get(lib_name)
    if lib_path is None:
        return False

    library_dir = lib_path / "images"
    output_dir  = DATA_DIR / lib_name
    json_file   = output_dir / "urls_data.json"

    if not library_dir.exists():
        return False

    # 載入 manifest
    manifest = _load_manifest(lib_name)
    prev: dict = manifest.get("items", {})

    # Level 1：images/ 目錄 mtime 快速檢查（1 stat call）
    dir_mtime = library_dir.stat().st_mtime
    if dir_mtime == manifest.get("dir_mtime") and len(prev) > 0:
        print(f"  [{lib_name}] 無異動，跳過（{len(prev)} 項目）")
        return True

    # Level 2：os.scandir 取 .info dir mtime（Windows FindFirstFile 快取，免額外 syscall）
    current: dict = {}
    with os.scandir(library_dir) as it:
        for entry in it:
            if entry.is_dir() and entry.name.endswith(".info"):
                try:
                    current[entry.name] = entry.stat().st_mtime
                except OSError:
                    pass

    # 3. Diff
    current_set = set(current)
    prev_set    = set(prev)
    added    = current_set - prev_set
    deleted  = prev_set - current_set
    modified = {k for k in current_set & prev_set if current[k] != prev.get(k, 0)}
    changed  = added | modified | deleted

    if not changed:
        _save_manifest(lib_name, current, dir_mtime)   # 補寫 dir_mtime，下次 Level 1 才能命中
        print(f"  [{lib_name}] 無異動，跳過（{len(current)} 項目）")
        return True

    print(f"  [{lib_name}] 異動：+{len(added)} 新增 / ~{len(modified)} 修改 / -{len(deleted)} 刪除，重建中...")

    # 4. 載入現有 items，過濾掉 deleted + modified
    existing: list = []
    if json_file.exists():
        try:
            existing = json.loads(json_file.read_text(encoding="utf-8")).get("items", [])
        except Exception:
            existing = []

    remove_ids = {Path(k).stem for k in (deleted | modified)}
    surviving  = [item for item in existing if item.get("id") not in remove_ids]

    # 5. 重新解析 added + modified
    new_items: list = []
    for dir_name in sorted(added | modified):
        info_dir  = library_dir / dir_name
        meta_path = info_dir / "metadata.json"
        if not meta_path.exists():
            continue
        try:
            with open(meta_path, encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            continue

        url   = meta.get("url", "").strip()
        local = _find_local_files(info_dir, lib_name)
        if not url and not local["file"] and not local["thumb"]:
            continue

        if url:
            domain = _get_domain(url)
            kind   = _classify_url(url)
        else:
            domain = "local"
            kind   = "video" if local["media_type"] == "video" else "other"

        w = meta.get("width")
        h = meta.get("height")
        new_items.append({
            "id":         meta.get("id", ""),
            "name":       meta.get("name", ""),
            "url":        url,
            "domain":     domain,
            "kind":       kind,
            "tags":       meta.get("tags", []),
            "thumb":      local["thumb"],
            "file":       local["file"],
            "media_type": local["media_type"],
            "width":      w if isinstance(w, int) and w > 0 else None,
            "height":     h if isinstance(h, int) and h > 0 else None,
        })

    # 6. 合併 + 重算統計
    all_items = surviving + new_items
    domains   = len({item["domain"] for item in all_items})
    total_video = sum(1 for i in all_items if i["kind"] == "video")
    total_post  = sum(1 for i in all_items if i["kind"] == "post")
    total_other = sum(1 for i in all_items if i["kind"] == "other")

    output_dir.mkdir(parents=True, exist_ok=True)
    tmp = json_file.with_suffix(".tmp")
    tmp.write_text(json.dumps({
        "library": lib_name,
        "stats": {
            "total":   len(all_items),
            "video":   total_video,
            "post":    total_post,
            "other":   total_other,
            "domains": domains,
        },
        "items": all_items,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(json_file)

    # 7. 更新 manifest
    _save_manifest(lib_name, current, dir_mtime)
    print(f"  [{lib_name}] 完成（共 {len(all_items)} 項，video {total_video} post {total_post} other {total_other}）")
    return True

# ---------------------------------------------------------------------------
# Config loader / saver  (reads data/config.json, builds LIBRARY_PATHS)
# ---------------------------------------------------------------------------

def _load_config() -> None:
    global LIBRARY_PATHS
    LIBRARY_PATHS = {}
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            for lp in cfg.get("libraries", []):
                lp = lp.strip()
                if lp:
                    p = Path(lp)
                    if p.exists():
                        LIBRARY_PATHS[p.name] = p
        except Exception:
            pass


def _add_library_path(lib_path_str: str) -> dict:
    """新增資源庫路徑至 config.json，更新 LIBRARY_PATHS。"""
    global LIBRARY_PATHS
    p = Path(lib_path_str.strip())
    if not p.exists():
        return {"ok": False, "error": f"找不到路徑：{lib_path_str}"}
    if not p.is_dir():
        return {"ok": False, "error": "請選擇一個資料夾"}
    libs_list = []
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            libs_list = cfg.get("libraries", [])
        except Exception:
            pass
    lib_path_norm = str(p)
    if lib_path_norm not in libs_list:
        libs_list.append(lib_path_norm)
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"libraries": libs_list}, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CONFIG_FILE)
    LIBRARY_PATHS[p.name] = p
    return {"ok": True, "name": p.name}

# ---------------------------------------------------------------------------
# Per-library thread-safety locks  (R1: 不同 library 並發寫入互不阻塞)
# ---------------------------------------------------------------------------
_lib_locks: dict = defaultdict(threading.Lock)

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
    """Return MIME type. Eagle _thumbnail files (no ext) are PNG."""
    name = path.name
    if re.search(r"_thumbnail$", name):
        return "image/png"
    return _MIME.get(path.suffix.lower(), "application/octet-stream")

# ---------------------------------------------------------------------------
# views.json helpers  (R2: _save_views 自動 mkdir)
# ---------------------------------------------------------------------------

def _load_views(lib_name: str) -> dict:
    p = DATA_DIR / lib_name / "views.json"
    if not p.exists():
        return {}
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return {}


def _save_views(data: dict, lib_name: str) -> None:
    lib_dir = DATA_DIR / lib_name
    lib_dir.mkdir(parents=True, exist_ok=True)   # R2: auto-create dir
    tmp = lib_dir / "views.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    tmp.replace(lib_dir / "views.json")


def _track_view(lib_name: str, item_id: str, name: str, domain: str, duration: int = 0) -> dict:
    """Record a view event. duration = seconds actually watched (0 = unknown)."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with _lib_locks[lib_name]:                   # R1: per-library lock
        data = _load_views(lib_name)
        entry = {"t": now}
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
            if domain:
                rec["domain"] = domain
            hist = rec.get("history", [])
            hist.append(entry)
            rec["history"] = hist[-MAX_HISTORY:]
        else:
            data[item_id] = {
                "name":             name or "",
                "domain":           domain or "",
                "views":            1,
                "first_viewed":     now,
                "last_viewed":      now,
                "total_watch_time": duration if duration > 0 else 0,
                "history":          [entry],
            }
        _save_views(data, lib_name)
        return data[item_id]


def _delete_history_entry(lib_name: str, item_id: str, t: str) -> dict:
    """Remove one history entry by timestamp. Recalculates views & total_watch_time."""
    with _lib_locks[lib_name]:
        data = _load_views(lib_name)
        if item_id not in data:
            return {}
        rec  = data[item_id]
        hist = rec.get("history", [])
        new_hist = [e for e in hist if e.get("t") != t]
        if len(new_hist) == len(hist):
            return rec          # nothing removed
        rec["history"]          = new_hist
        rec["views"]            = len(new_hist)
        rec["total_watch_time"] = sum(e.get("d", 0) for e in new_hist)
        if not new_hist:
            del data[item_id]
            _save_views(data, lib_name)
            return {}
        _save_views(data, lib_name)
        return rec


def _clear_all_views(lib_name: str) -> None:
    """Wipe the entire views.json for a specific library."""
    with _lib_locks[lib_name]:
        _save_views({}, lib_name)

# ---------------------------------------------------------------------------
# Library listing & extraction
# ---------------------------------------------------------------------------

def _list_libraries():
    """
    從 LIBRARY_PATHS 回傳已設定的資源庫清單 [{name, label, extracted}]。
    若尚未設定任何資源庫，回傳 {"configured": False}。
    """
    if not LIBRARY_PATHS:
        return {"configured": False}
    libs = []
    for name in sorted(LIBRARY_PATHS):
        label     = name[:-len(".library")] if name.endswith(".library") else name
        extracted = (DATA_DIR / name / "urls_data.json").exists()
        libs.append({"name": name, "label": label, "extracted": extracted})
    return libs


# 用於序列化多個索引請求（同一時間只跑一個索引，避免 I/O 競爭）
_extract_lock = threading.Lock()

def _index_library(lib_name: str) -> dict:
    """
    直接呼叫內聯的 _run_one() 建立索引。
    回傳 {"ok": True} 或 {"ok": False, "error": "..."}
    """
    if lib_name not in LIBRARY_PATHS:
        return {"ok": False, "error": f"資源庫未設定：{lib_name}"}
    with _extract_lock:
        try:
            success = _run_one(lib_name)
            if success:
                return {"ok": True}
            else:
                return {"ok": False, "error": f"_run_one returned False for '{lib_name}'"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

# ---------------------------------------------------------------------------
# User data (preset sync)
# ---------------------------------------------------------------------------
_USER_DATA_PATH = DATA_DIR / "user_data.json"
_EMPTY_USER_DATA = {"version": 0, "filterPresets": [], "transformSnapshots": {}}

def _load_user_data() -> dict:
    try:
        if _USER_DATA_PATH.exists():
            with open(_USER_DATA_PATH, encoding="utf-8") as f:
                data = json.load(f)
                # 舊 schema 遷移：presets → filterPresets, videoPresets → transformSnapshots
                if "presets" in data and "filterPresets" not in data:
                    data["filterPresets"] = [
                        {k: v for k, v in p.items() if k != "tx"}
                        for p in data.pop("presets", [])
                    ]
                if "videoPresets" in data and "transformSnapshots" not in data:
                    snaps = {}
                    for vid_id, vd in data.pop("videoPresets", {}).items():
                        snaps[vid_id] = {"tx": vd.get("tx", {}), "savedAt": vd.get("modifiedAt", 0)}
                    data["transformSnapshots"] = snaps
                return data
    except Exception:
        pass
    return dict(_EMPTY_USER_DATA)

def _save_user_data(obj: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    tmp = _USER_DATA_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    tmp.replace(_USER_DATA_PATH)

def _merge_user_data(server: dict, client: dict) -> dict:
    import time
    # Filter Presets（命名濾鏡庫）
    s_fp = {p["id"]: p for p in server.get("filterPresets", []) if "id" in p}
    for cp in client.get("filterPresets", []):
        cid = cp.get("id")
        if not cid:
            continue
        if cid not in s_fp or cp.get("modifiedAt", 0) > s_fp[cid].get("modifiedAt", 0):
            s_fp[cid] = cp
    # Transform Snapshots（每影片幾何快照）
    s_ts = dict(server.get("transformSnapshots", {}))
    for vid_id, snap in client.get("transformSnapshots", {}).items():
        if vid_id not in s_ts or snap.get("savedAt", 0) > s_ts[vid_id].get("savedAt", 0):
            s_ts[vid_id] = snap
    return {
        "version": int(time.time() * 1000),
        "filterPresets": list(s_fp.values()),
        "transformSnapshots": s_ts,
    }

# ---------------------------------------------------------------------------
# CORS headers
# ---------------------------------------------------------------------------
_CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

# ---------------------------------------------------------------------------
# Threaded HTTP Server
# ---------------------------------------------------------------------------

_CONN_ERRORS = (ConnectionAbortedError, BrokenPipeError,
                ConnectionResetError, OSError)


class _Server(ThreadingMixIn, HTTPServer):
    """Multithreaded HTTPServer – each request gets its own thread."""
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
        """從 query string 取出 lib 參數（已 unquote）"""
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = parse_qs(qs)
        return unquote(params.get("lib", [""])[0]).strip()

    def translate_path(self, url_path: str):
        # /viewer/* → VIEWER_DIR
        if url_path == "/viewer" or url_path.startswith("/viewer/"):
            rel = url_path[len("/viewer/"):] if url_path.startswith("/viewer/") else ""
            rel = rel or "index.html"
            fs  = (VIEWER_DIR / rel).resolve()
            if not str(fs).startswith(str(VIEWER_DIR.resolve())):
                return None, None
            return fs, _guess_mime(fs)

        # /images/{lib}/{rel} → LIBRARY_PATHS[lib]/images/{rel}
        if url_path.startswith("/images/"):
            rest  = url_path[len("/images/"):]         # "{lib}/{rel}"
            parts = rest.split("/", 1)
            if len(parts) < 2 or not parts[0] or not parts[1]:
                return None, None
            lib_name = parts[0]                        # already unquoted by _url_path()
            rel      = parts[1]
            lib_path = LIBRARY_PATHS.get(lib_name)
            if lib_path is None:
                return None, None
            images_root = (lib_path / "images").resolve()
            fs = (images_root / rel).resolve()
            if not str(fs).startswith(str(images_root)):
                return None, None
            return fs, _guess_mime(fs)

        # /data/{lib}/{rel} → DATA_DIR/{lib}/{rel}
        if url_path.startswith("/data/"):
            rel = url_path[len("/data/"):]
            fs  = (DATA_DIR / rel).resolve()
            if not str(fs).startswith(str(DATA_DIR.resolve())):
                return None, None
            return fs, _guess_mime(fs)

        return None, None

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        url_path = self._url_path()

        if url_path == "/":
            self._redirect("/viewer/")
            return

        # GET /api/browse  → 開啟原生目錄選擇器，回傳選取路徑
        if url_path == "/api/browse":
            try:
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                root.wm_attributes("-topmost", True)
                chosen = filedialog.askdirectory(title="選擇資源庫資料夾")
                root.destroy()
            except Exception as e:
                self._json(500, {"ok": False, "error": str(e)})
                return
            if chosen:
                self._json(200, {"ok": True, "path": chosen})
            else:
                self._json(200, {"ok": False, "path": ""})
            return

        # GET /api/config
        if url_path == "/api/config":
            self._json(200, {
                "configured": bool(LIBRARY_PATHS),
                "libraries":  [str(p) for p in LIBRARY_PATHS.values()],
            })
            return

        # GET /api/libraries
        if url_path == "/api/libraries":
            self._json(200, _list_libraries())
            return

        # GET /api/views?lib={lib}
        if url_path == "/api/views":
            lib_name = self._query_lib()
            if not lib_name:
                self._err(400, "Missing ?lib= parameter")
                return
            with _lib_locks[lib_name]:
                data = _load_views(lib_name)
            self._json(200, data)
            return

        # GET /api/user-data → 回傳濾鏡 preset 資料（含 version）
        if url_path == "/api/user-data":
            self._json(200, _load_user_data())
            return

        fs, mime = self.translate_path(url_path)
        if fs is None:
            self._err(404, "Not found: " + url_path)
            return
        if not fs.exists():
            self._err(404, "File not found: " + url_path)
            return
        if fs.is_dir():
            idx = fs / "index.html"
            if idx.exists():
                fs   = idx
                mime = "text/html; charset=utf-8"
            else:
                self._err(403, "Directory listing not allowed")
                return

        self._serve_file(fs, mime)

    def _serve_file(self, fs: Path, mime: str):
        try:
            size = fs.stat().st_size
        except OSError:
            self._err(500, "Cannot stat file")
            return

        range_hdr = self.headers.get("Range", "")
        if range_hdr and mime.startswith("video/"):
            self._serve_range(fs, size, mime, range_hdr)
            return

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
                raise ValueError("bad range header")
            s_str, e_str = m.group(1), m.group(2)
            start = int(s_str) if s_str else 0
            end   = int(e_str) if e_str else total - 1
            end   = min(end, total - 1)
            length = end - start + 1
        except (ValueError, AttributeError):
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{total}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

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

    def do_POST(self):
        url_path = self._url_path()

        # POST /api/config  body: {library_path}
        if url_path == "/api/config":
            cl = int(self.headers.get("Content-Length", 0))
            if cl > 8192:
                self._err(413, "Payload too large"); return
            try:
                body = json.loads(self.rfile.read(cl).decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._err(400, "Invalid JSON"); return
            p = str(body.get("library_path", "")).strip()
            if not p:
                self._err(400, "Missing field: library_path"); return
            result = _add_library_path(p)
            if not result["ok"]:
                self._err(400, result["error"]); return
            self._json(200, result)
            return

        # POST /api/extract  body: {lib}
        if url_path == "/api/extract":
            cl = int(self.headers.get("Content-Length", 0))
            if cl > 8192:
                self._err(413, "Payload too large"); return
            try:
                body = json.loads(self.rfile.read(cl).decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._err(400, "Invalid JSON"); return
            lib_name = str(body.get("lib", "")).strip()
            if not lib_name:
                self._err(400, "Missing field: lib"); return
            result = _index_library(lib_name)
            self._json(200 if result["ok"] else 500, result)
            return

        # POST /api/track  body: {id, name, domain, duration, lib}
        if url_path == "/api/track":
            cl = int(self.headers.get("Content-Length", 0))
            if cl > 8192:
                self._err(413, "Payload too large")
                return
            try:
                raw  = self.rfile.read(cl)
                body = json.loads(raw.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._err(400, "Invalid JSON")
                return

            item_id  = str(body.get("id",       "")).strip()
            name     = str(body.get("name",     "")).strip()
            domain   = str(body.get("domain",   "")).strip()
            duration = int(body.get("duration", 0))
            lib_name = str(body.get("lib",      "")).strip()
            if not item_id:
                self._err(400, "Missing field: id")
                return
            if not lib_name:
                self._err(400, "Missing field: lib")
                return
            rec = _track_view(lib_name, item_id, name, domain, duration)
            self._json(200, {"ok": True, "record": rec})
            return

        # POST /api/delete-view  body: {id, t, lib}
        if url_path == "/api/delete-view":
            cl = int(self.headers.get("Content-Length", 0))
            if cl > 8192:
                self._err(413, "Payload too large"); return
            try:
                body = json.loads(self.rfile.read(cl).decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._err(400, "Invalid JSON"); return
            item_id  = str(body.get("id",  "")).strip()
            t        = str(body.get("t",   "")).strip()
            lib_name = str(body.get("lib", "")).strip()
            if not item_id or not t:
                self._err(400, "Missing field: id or t"); return
            if not lib_name:
                self._err(400, "Missing field: lib"); return
            rec = _delete_history_entry(lib_name, item_id, t)
            self._json(200, {"ok": True, "record": rec})
            return

        # POST /api/clear-views  body: {lib}
        if url_path == "/api/clear-views":
            cl = int(self.headers.get("Content-Length", 0))
            lib_name = ""
            if cl > 0 and cl <= 8192:
                try:
                    body = json.loads(self.rfile.read(cl).decode("utf-8"))
                    lib_name = str(body.get("lib", "")).strip()
                except Exception:
                    pass
            if not lib_name:
                self._err(400, "Missing field: lib")
                return
            _clear_all_views(lib_name)
            self._json(200, {"ok": True})
            return

        # POST /api/user-data  body: {clientData, clientVersion}
        if url_path == "/api/user-data":
            cl = int(self.headers.get("Content-Length", 0))
            if cl > 1_048_576:
                self._err(413, "Payload too large"); return
            try:
                body = json.loads(self.rfile.read(cl).decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._err(400, "Invalid JSON"); return
            client_data = body.get("clientData", {})
            merged = _merge_user_data(_load_user_data(), client_data)
            _save_user_data(merged)
            self._json(200, {"merged": merged})
            return

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
            has_manifest = (DATA_DIR / lib_name / ".index_manifest.json").exists()
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
