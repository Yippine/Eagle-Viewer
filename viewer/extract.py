"""URL classification, metadata extraction, and manifest management."""
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from config import (
    DATA_DIR, LIBRARY_PATHS, FOLDER_PATHS, SCHEMA_VERSION,
    _extract_lock, _lib_locks,
)

# ---------------------------------------------------------------------------
# URL Classification
# ---------------------------------------------------------------------------

VIDEO_PATTERNS = [
    r"youtube\.com/watch",
    r"youtu\.be/",
    r"youtube\.com/shorts/",
    r"bilibili\.com/video/",
    r"b23\.tv/",
    r"twitter\.com/.+/status/.+",
    r"x\.com/.+/status/.+",
    r"tiktok\.com/",
    r"vm\.tiktok\.com/",
    r"instagram\.com/reel/",
    r"instagram\.com/tv/",
    r"vimeo\.com/\d+",
    r"v\.redd\.it/",
    r"pornhub\.com/view_video",
    r"xvideos\.com/video",
    r"xhamster\.com/videos/",
    r"nhentai\.net/g/",
    r"rule34video\.com/videos/",
    r"kemono\.party/.+/post/",
    r"iwara\.tv/video/",
    r"dlsite\.com/",
    r"\.(mp4|webm|m3u8|flv|avi|mov)(\?|$)",
]

POST_PATTERNS = [
    r"twitter\.com/.+/status/\d+$",
    r"x\.com/.+/status/\d+$",
    r"instagram\.com/p/",
    r"reddit\.com/r/.+/comments/",
    r"pixiv\.net/artworks/",
    r"pixiv\.net/en/artworks/",
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
    r"kemono\.(party|su)/.+/post/",
    r"coomer\.(party|su)/",
    r"tumblr\.com/post/",
    r"deviantart\.com/.+/art/",
    r"artstation\.com/artwork/",
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
    """Find thumbnail and media file inside an .info directory."""
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
    """Return 'video' | 'post' | 'other'."""
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


# ---------------------------------------------------------------------------
# Full extraction (run_one)
# ---------------------------------------------------------------------------

def _run_one(lib_name: str) -> bool:
    """Full extraction for a library. Returns True on success."""
    lib_path = LIBRARY_PATHS.get(lib_name)
    if lib_path is None:
        print(f"[錯誤] 資源庫未設定：{lib_name}", file=sys.stderr)
        return False

    library_dir = lib_path / "images"
    output_dir  = DATA_DIR / lib_name

    if not library_dir.exists():
        print(f"[錯誤] 找不到資源庫目錄：{library_dir}", file=sys.stderr)
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
            "tags":       meta.get("tags", []) + (["archived"] if meta.get("isDeleted") else []),
            "folders":    meta.get("folders", []),
            "thumb":      local["thumb"],
            "file":       local["file"],
            "media_type": local["media_type"],
            "width":      w if isinstance(w, int) and w > 0 else None,
            "height":     h if isinstance(h, int) and h > 0 else None,
            "mtime":      meta.get("mtime"),
            "size":       meta.get("size"),
            "star":       meta.get("star", 0),
            "annotation": meta.get("annotation", ""),
            "ext":        meta.get("ext", ""),
            "duration":   meta.get("duration"),
        })

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

    grouped: dict = defaultdict(list)
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
                "folders":    i.get("folders", []),
                "thumb":      i["thumb"],
                "file":       i["file"],
                "media_type": i["media_type"],
                "width":      i["width"],
                "height":     i["height"],
                "mtime":      i.get("mtime"),
                "size":       i.get("size"),
                "star":       i.get("star", 0),
                "annotation": i.get("annotation", ""),
                "ext":        i.get("ext", ""),
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
# Manifest helpers (mtime-based incremental index)
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
            "schema_version": SCHEMA_VERSION,
            "indexed_at":     datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "dir_mtime":      dir_mtime,
            "items":          items_mtime,
        }, ensure_ascii=False),
        encoding="utf-8",
    )
    tmp.replace(p)


def _audit_isdeleted_inplace(items: list, library_dir) -> int:
    """Re-check isDeleted for each item by reading metadata.json（DrvFS mtime 補漏）.
    Mutates items in-place, returns count of changed items."""
    changed = 0
    for item in items:
        meta_path = library_dir / f"{item['id']}.info" / "metadata.json"
        if not meta_path.exists():
            continue
        try:
            with open(meta_path, encoding="utf-8") as f:
                meta = json.load(f)
            is_deleted   = bool(meta.get("isDeleted"))
            has_archived = "archived" in item.get("tags", [])
            if is_deleted != has_archived:
                base_tags    = [t for t in item.get("tags", []) if t != "archived"]
                item["tags"] = base_tags + (["archived"] if is_deleted else [])
                changed += 1
        except Exception:
            pass
    return changed


def _run_incremental(lib_name: str) -> bool:
    """mtime-based incremental index: only rebuild changed items."""
    lib_path = LIBRARY_PATHS.get(lib_name)
    if lib_path is None:
        return False

    library_dir = lib_path / "images"
    output_dir  = DATA_DIR / lib_name
    json_file   = output_dir / "urls_data.json"

    if not library_dir.exists():
        return False

    manifest = _load_manifest(lib_name)
    prev: dict = manifest.get("items", {})

    # schema 版本異動 → 強制全量重建（由 migration script 在首次升版時代為處理，之後此路徑為保底）
    if manifest.get("schema_version") != SCHEMA_VERSION and len(prev) > 0:
        print(f"  [{lib_name}] schema 版本異動（v{manifest.get('schema_version')} → v{SCHEMA_VERSION}），強制全量重建...")
        return _run_one(lib_name)

    dir_mtime = library_dir.stat().st_mtime
    if dir_mtime == manifest.get("dir_mtime") and len(prev) > 0:
        # 目錄 mtime 未變（add/delete 無變化），但 DrvFS 上 isDeleted 變更不改 dir mtime
        # → 補做 isDeleted audit（僅限小型 library，≤5000 項目）
        # 大型 library 逐一讀取 metadata.json 成本太高，啟動時略過
        _AUDIT_THRESHOLD = 500
        try:
            data     = json.loads(json_file.read_text(encoding="utf-8"))
            existing = data.get("items", [])
            if len(existing) <= _AUDIT_THRESHOLD:
                n_changed = _audit_isdeleted_inplace(existing, library_dir)
                if n_changed:
                    tmp = json_file.with_suffix(".tmp")
                    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                    tmp.replace(json_file)
                    print(f"  [{lib_name}] 目錄無異動，isDeleted 更新 {n_changed} 筆")
                else:
                    print(f"  [{lib_name}] 無異動，跳過（{len(existing)} 項目）")
            else:
                print(f"  [{lib_name}] 無異動，跳過（{len(existing)} 項目，大型 library 略過 isDeleted audit）")
        except Exception:
            print(f"  [{lib_name}] 無異動，跳過（{len(prev)} 項目）")
        return True

    current: dict = {}
    with os.scandir(library_dir) as it:
        for entry in it:
            if entry.is_dir() and entry.name.endswith(".info"):
                try:
                    current[entry.name] = entry.stat().st_mtime
                except OSError:
                    pass

    current_set = set(current)
    prev_set    = set(prev)
    added    = current_set - prev_set
    deleted  = prev_set - current_set
    modified = {k for k in current_set & prev_set if current[k] != prev.get(k, 0)}
    changed  = added | modified | deleted

    if not changed:
        _save_manifest(lib_name, current, dir_mtime)
        print(f"  [{lib_name}] 無異動，跳過（{len(current)} 項目）")
        return True

    print(f"  [{lib_name}] 異動：+{len(added)} 新增 / ~{len(modified)} 修改 / -{len(deleted)} 刪除，重建中...")

    existing: list = []
    if json_file.exists():
        try:
            existing = json.loads(json_file.read_text(encoding="utf-8")).get("items", [])
        except Exception:
            existing = []

    remove_ids = {Path(k).stem for k in (deleted | modified)}
    surviving  = [item for item in existing if item.get("id") not in remove_ids]
    # DrvFS mtime 補漏：surviving items 可能有 isDeleted 變更但 mtime 未更新
    _audit_isdeleted_inplace(surviving, library_dir)

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
            "tags":       meta.get("tags", []) + (["archived"] if meta.get("isDeleted") else []),
            "folders":    meta.get("folders", []),
            "thumb":      local["thumb"],
            "file":       local["file"],
            "media_type": local["media_type"],
            "width":      w if isinstance(w, int) and w > 0 else None,
            "height":     h if isinstance(h, int) and h > 0 else None,
            "mtime":      meta.get("mtime"),
            "size":       meta.get("size"),
            "star":       meta.get("star", 0),
            "annotation": meta.get("annotation", ""),
            "ext":        meta.get("ext", ""),
            "duration":   meta.get("duration"),
        })

    all_items   = surviving + new_items
    domains     = len({item["domain"] for item in all_items})
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

    _save_manifest(lib_name, current, dir_mtime)
    print(f"  [{lib_name}] 完成（共 {len(all_items)} 項，video {total_video} post {total_post} other {total_other}）")
    return True


# ---------------------------------------------------------------------------
# Library listing and indexing
# ---------------------------------------------------------------------------

def _list_libraries():
    """Return library list from LIBRARY_PATHS, or {configured: False}."""
    if not LIBRARY_PATHS:
        return {"configured": False}
    libs = []
    for name in sorted(LIBRARY_PATHS):
        label     = name[:-len(".library")] if name.endswith(".library") else name
        extracted = (DATA_DIR / name / "urls_data.json").exists()
        libs.append({"name": name, "label": label, "extracted": extracted})
    return libs


def _index_library(lib_name: str) -> dict:
    """Dispatch _run_one for a library. Returns {ok} or {ok, error}."""
    if lib_name not in LIBRARY_PATHS:
        return {"ok": False, "error": f"資源庫未設定：{lib_name}"}
    with _extract_lock:
        try:
            success = _run_one(lib_name)
            if success:
                return {"ok": True}
            return {"ok": False, "error": f"_run_one returned False for '{lib_name}'"}
        except Exception as e:
            return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Folder source (Excire-style plain directory scan)
# ---------------------------------------------------------------------------

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"}


def _run_one_folder(folder_name: str) -> bool:
    """Scan a plain folder tree (resource/ subdirs as categories). Returns True on success."""
    folder_root = FOLDER_PATHS.get(folder_name)
    if folder_root is None:
        print(f"[錯誤] 資料夾來源未設定：{folder_name}", file=sys.stderr)
        return False

    output_dir = DATA_DIR / folder_name
    output_dir.mkdir(parents=True, exist_ok=True)

    items = []
    item_id = 0

    def _scan_dir(d: Path, category: str) -> None:
        nonlocal item_id
        try:
            entries = sorted(d.iterdir(), key=lambda e: e.name.lower())
        except PermissionError:
            return
        for entry in entries:
            if entry.is_dir():
                _scan_dir(entry, category)
            elif entry.is_file():
                ext = entry.suffix.lower()
                if ext in IMAGE_EXTS:
                    media_type = "image"
                elif ext in VIDEO_EXTS:
                    media_type = "video"
                else:
                    continue
                item_id += 1
                rel = entry.relative_to(folder_root)
                items.append({
                    "id":         f"folder_{item_id:08d}",
                    "name":       entry.stem,
                    "url":        "",
                    "domain":     "local",
                    "kind":       "other" if media_type == "image" else "video",
                    "tags":       [category] if category else [],
                    "folders":    [category] if category else [],
                    "thumb":      None,
                    "file":       f"folder-images/{folder_name}/{rel.as_posix()}",
                    "media_type": media_type,
                    "width":      None,
                    "height":     None,
                    "mtime":      int(entry.stat().st_mtime * 1000),
                    "size":       entry.stat().st_size,
                    "star":       0,
                    "annotation": "",
                    "ext":        ext.lstrip("."),
                    "source":     "folder",
                })

    # Top-level subdirs become categories; files directly under root go to ""
    try:
        top_entries = sorted(folder_root.iterdir(), key=lambda e: e.name.lower())
    except Exception as e:
        print(f"[錯誤] 無法讀取資料夾：{e}", file=sys.stderr)
        return False

    for entry in top_entries:
        if entry.is_dir():
            _scan_dir(entry, entry.name)
        elif entry.is_file():
            ext = entry.suffix.lower()
            if ext in IMAGE_EXTS or ext in VIDEO_EXTS:
                _scan_dir(folder_root, "")
                break  # handled inside _scan_dir already via flat call

    total_img   = sum(1 for i in items if i["media_type"] == "image")
    total_video = sum(1 for i in items if i["media_type"] == "video")
    cats = sorted({t for i in items for t in i["tags"]})
    print(f"[{folder_name}] 掃描完成：{len(items)} 個檔案（圖片 {total_img} 影片 {total_video}），分類 {len(cats)} 個")

    json_data = {
        "library":  folder_name,
        "source":   "folder",
        "stats": {
            "total":      len(items),
            "video":      total_video,
            "post":       0,
            "other":      total_img,
            "domains":    1,
            "categories": cats,
        },
        "items": items,
    }
    json_file = output_dir / "urls_data.json"
    tmp = json_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(json_data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(json_file)
    return True


def _list_folder_sources():
    """Return folder source list from FOLDER_PATHS."""
    libs = []
    for name in sorted(FOLDER_PATHS):
        extracted = (DATA_DIR / name / "urls_data.json").exists()
        # display_label: parent dir name (e.g. "Handsome" from "Handsome_resource")
        display_label = FOLDER_PATHS[name].parent.name
        libs.append({"name": name, "label": name, "display_label": display_label, "extracted": extracted, "source": "folder"})
    return libs


def _index_folder(folder_name: str) -> dict:
    """Dispatch _run_one_folder. Returns {ok} or {ok, error}."""
    if folder_name not in FOLDER_PATHS:
        return {"ok": False, "error": f"資料夾來源未設定：{folder_name}"}
    with _extract_lock:
        try:
            success = _run_one_folder(folder_name)
            if success:
                return {"ok": True}
            return {"ok": False, "error": f"_run_one_folder returned False for '{folder_name}'"}
        except Exception as e:
            return {"ok": False, "error": str(e)}
