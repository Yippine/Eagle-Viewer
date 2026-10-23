"""POST / PATCH / DELETE API endpoint handlers.

所有 handle_* 函式的第一參數 ``h`` 為 BaseHTTPRequestHandler 實例
（serve.py 的 _Handler），透過其薄介面（_json/_err/_read_json/path/headers/rfile）操作。
PATCH handlers 的第二參數 ``b`` 為 serve.py 端已解析的 JSON body（維持原單次讀取行為）。
路由 dispatch 表保留在 serve.py。
"""
import shutil
from urllib.parse import parse_qs, unquote

from config import LIBRARY_PATHS, _lib_locks, _add_library_path, _add_folder_path
from extract import _index_library
from api_helpers import (
    _add_link, _build_folder_map, _get_item_meta, _patch_item_cache,
    _remove_item_cache, _remove_link, _sse_broadcast,
    _write_item_meta, _write_via_eagle_api, _write_via_eagle_api_v2,
)
from api_sync import _apply_folder_tags_sync, _apply_items_tags_sync
from api_import import (
    _create_eagle_item_from_file, _load_user_data, _merge_user_data,
    _parse_multipart, _save_user_data, start_import_url,
)
from api_routes import (
    _clear_all_views, _delete_history_entry, _start_folder_scan, _track_view,
)

# ---------------------------------------------------------------------------
# POST handlers
# ---------------------------------------------------------------------------

def handle_post_config(h):
    b = h._read_json()
    if b is None: return
    p = str(b.get("library_path", "")).strip()
    if not p: h._err(400, "Missing field: library_path"); return
    r = _add_library_path(p)
    if not r["ok"]: h._err(400, r["error"]); return
    h._json(200, r)


def handle_post_folder_config(h):
    b = h._read_json()
    if b is None: return
    p = str(b.get("folder_path", "")).strip()
    if not p: h._err(400, "Missing field: folder_path"); return
    r = _add_folder_path(p)
    if not r["ok"]: h._err(400, r["error"]); return
    h._json(200, r)


def handle_post_extract(h):
    b = h._read_json()
    if b is None: return
    lib = str(b.get("lib", "")).strip()
    if not lib: h._err(400, "Missing field: lib"); return
    r = _index_library(lib)
    h._json(200 if r["ok"] else 500, r)


def handle_post_folder_extract(h):
    b = h._read_json()
    if b is None: return
    folder = str(b.get("folder", "")).strip()
    if not folder: h._err(400, "Missing field: folder"); return
    task_id = _start_folder_scan(folder)
    h._json(200, {"ok": True, "task_id": task_id})


def handle_post_track(h):
    b = h._read_json()
    if b is None: return
    item_id  = str(b.get("id",       "")).strip()
    name     = str(b.get("name",     "")).strip()
    domain   = str(b.get("domain",   "")).strip()
    duration = int(b.get("duration", 0))
    lib      = str(b.get("lib",      "")).strip()
    if not item_id: h._err(400, "Missing field: id"); return
    if not lib:     h._err(400, "Missing field: lib"); return
    h._json(200, {"ok": True, "record": _track_view(lib, item_id, name, domain, duration)})


def handle_post_delete_view(h):
    b = h._read_json()
    if b is None: return
    item_id = str(b.get("id",  "")).strip()
    t       = str(b.get("t",   "")).strip()
    lib     = str(b.get("lib", "")).strip()
    if not item_id or not t: h._err(400, "Missing field: id or t"); return
    if not lib:              h._err(400, "Missing field: lib"); return
    h._json(200, {"ok": True, "record": _delete_history_entry(lib, item_id, t)})


def handle_post_clear_views(h):
    b = h._read_json()
    if b is None: return
    lib = str(b.get("lib", "")).strip()
    if not lib: h._err(400, "Missing field: lib"); return
    _clear_all_views(lib)
    h._json(200, {"ok": True})


def handle_post_user_data(h):
    b = h._read_json(1_048_576)
    if b is None: return
    merged = _merge_user_data(_load_user_data(), b.get("clientData", {}))
    _save_user_data(merged)
    h._json(200, {"merged": merged})


def handle_post_tags_sync_apply(h):
    b = h._read_json()
    if b is None: return
    lib = str(b.get("lib", "")).strip()
    if not lib: h._err(400, "Missing field: lib"); return
    applied = _apply_folder_tags_sync(lib)
    _sse_broadcast(lib, {"type": "tags_synced", "lib": lib})
    h._json(200, {"ok": True, "applied": applied})


def handle_post_items_tags_sync_apply(h):
    b = h._read_json()
    if b is None: return
    lib = str(b.get("lib", "")).strip()
    if not lib: h._err(400, "Missing field: lib"); return
    applied = _apply_items_tags_sync(lib)
    _sse_broadcast(lib, {"type": "tags_synced", "lib": lib})
    h._json(200, {"ok": True, "applied": applied})


def handle_post_item_archive(h):
    b = h._read_json()
    if b is None: return
    item_id = str(b.get("id",  "")).strip()
    lib     = str(b.get("lib", "")).strip()
    if not item_id or not lib: h._err(400, "Missing field: id or lib"); return
    meta = _get_item_meta(lib, item_id)
    if meta is None: h._err(404, "Item not found"); return
    # 嘗試 Eagle 原生 moveToTrash；失敗則 soft-archive（加 archived tag）
    eagle_ok = _write_via_eagle_api("item/moveToTrash", {"itemIds": [item_id]})
    tags = meta.get("tags", [])
    if "archived" not in tags:
        tags = tags + ["archived"]
        meta["tags"] = tags
        _write_item_meta(lib, item_id, meta)
        _patch_item_cache(lib, item_id, {"tags": tags})
        _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
    h._json(200, {"ok": True, "eagle_trash": eagle_ok})


def handle_post_item_restore(h):
    b = h._read_json()
    if b is None: return
    item_id = str(b.get("id",  "")).strip()
    lib     = str(b.get("lib", "")).strip()
    if not item_id or not lib: h._err(400, "Missing field: id or lib"); return
    meta = _get_item_meta(lib, item_id)
    if meta is None: h._err(404, "Item not found"); return
    # Eagle V2 API（4.0 Build 21+）：isDeleted=false 從垃圾桶還原
    eagle_ok = _write_via_eagle_api_v2("item/update", {"id": item_id, "isDeleted": False})
    tags = [t for t in meta.get("tags", []) if t != "archived"]
    meta["tags"] = tags
    _write_item_meta(lib, item_id, meta)
    _patch_item_cache(lib, item_id, {"tags": tags})
    _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
    h._json(200, {"ok": True, "eagle_restore": eagle_ok})


def handle_post_items_restore_batch(h):
    b = h._read_json()
    if b is None: return
    ids = [str(x).strip() for x in b.get("ids", [])]
    lib = str(b.get("lib", "")).strip()
    if not ids or not lib: h._err(400, "Missing field: ids or lib"); return
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
    h._json(200, {"ok": True, "restored": restored})


def handle_post_items_archive_batch(h):
    b = h._read_json()
    if b is None: return
    ids = [str(x).strip() for x in b.get("ids", [])]
    lib = str(b.get("lib", "")).strip()
    if not ids or not lib: h._err(400, "Missing field: ids or lib"); return
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
    h._json(200, {"ok": True, "archived": archived})


def handle_post_items_folders_batch(h):
    b = h._read_json()
    if b is None: return
    ids        = [str(x).strip() for x in b.get("ids", [])]
    lib        = str(b.get("lib", "")).strip()
    folder_ids = [str(x).strip() for x in b.get("folder_ids", [])]
    if not ids or not lib: h._err(400, "Missing field: ids or lib"); return
    updated = []
    for item_id in ids:
        meta = _get_item_meta(lib, item_id)
        if meta is None: continue
        meta["folders"] = folder_ids
        _write_item_meta(lib, item_id, meta)
        _patch_item_cache(lib, item_id, {"folders": folder_ids})
        updated.append(item_id)
    h._json(200, {"ok": True, "updated": updated})


def handle_post_items_delete_batch(h):
    b = h._read_json()
    if b is None: return
    ids = [str(x).strip() for x in b.get("ids", [])]
    lib = str(b.get("lib", "")).strip()
    if not ids or not lib: h._err(400, "Missing field: ids or lib"); return
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
    h._json(200, {"ok": True, "deleted": deleted})


def handle_post_item_link(h):
    b = h._read_json()
    if b is None: return
    item_id   = str(b.get("id",        "")).strip()
    lib       = str(b.get("lib",       "")).strip()
    target_id = str(b.get("target_id", "")).strip()
    if not item_id or not lib or not target_id:
        h._err(400, "Missing field: id, lib, or target_id"); return
    _add_link(lib, item_id, target_id)
    h._json(200, {"ok": True})


def handle_post_import_upload(h):
    ct = h.headers.get("Content-Type", "")
    if "multipart/form-data" not in ct:
        h._err(400, "Expected multipart/form-data"); return
    cl_raw = h.headers.get("Content-Length", "0")
    try:
        cl = int(cl_raw)
    except ValueError:
        cl = 0
    if cl > 2 * 1024 * 1024 * 1024:
        h._err(413, "File too large (max 2 GB)"); return
    raw   = h.rfile.read(cl)
    parts = _parse_multipart(raw, ct)
    if not parts:
        h._err(400, "multipart 解析失敗，請確認上傳格式"); return
    file_bytes, file_name = parts.get("file", (b"", None))
    lib  = parts.get("lib",  (b"",))[0].decode("utf-8", errors="replace").strip()
    name = parts.get("name", (b"",))[0].decode("utf-8", errors="replace").strip()
    if not file_bytes or not file_name or not lib:
        h._err(400, "Missing required fields: file, lib"); return
    r = _create_eagle_item_from_file(lib, "", file_name, file_bytes, custom_name=name)
    if not r["ok"]:
        h._err(500, r.get("error", "Upload failed")); return
    _sse_broadcast(lib, {"type": "item_created", "id": r["id"], "lib": lib})
    h._json(200, {"ok": True, "id": r["id"], "name": r["name"]})


def handle_post_import_url(h):
    b = h._read_json()
    if b is None: return
    url  = str(b.get("url",  "")).strip()
    lib  = str(b.get("lib",  "")).strip()
    name = str(b.get("name", "")).strip()
    if not url or not lib:
        h._err(400, "Missing field: url or lib"); return
    task_id = start_import_url(url, lib, name=name)
    h._json(200, {"ok": True, "task_id": task_id})


# ---------------------------------------------------------------------------
# PATCH handlers（b = 已解析 JSON body，由 serve.py 讀取後傳入）
# ---------------------------------------------------------------------------

def handle_patch_item_move(h, b):
    item_id   = str(b.get("id",        "")).strip()
    lib       = str(b.get("lib",       "")).strip()
    folder_id = str(b.get("folder_id", "")).strip()
    if not item_id or not lib or not folder_id:
        h._err(400, "Missing field: id, lib, or folder_id"); return
    meta = _get_item_meta(lib, item_id)
    if meta is None: h._err(404, "Item not found"); return
    new_tags = _build_folder_map(lib).get(folder_id, [])
    meta["folders"] = [folder_id]; meta["tags"] = new_tags
    _write_via_eagle_api("item/move", {"itemId": item_id, "folderId": folder_id})
    _write_item_meta(lib, item_id, meta)
    _patch_item_cache(lib, item_id, {"tags": new_tags})
    _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
    h._json(200, {"ok": True, "new_tags": new_tags})


def handle_patch_item_rename(h, b):
    item_id = str(b.get("id",   "")).strip()
    lib     = str(b.get("lib",  "")).strip()
    name    = str(b.get("name", "")).strip()
    if not item_id or not lib or not name:
        h._err(400, "Missing field: id, lib, or name"); return
    meta = _get_item_meta(lib, item_id)
    if meta is None: h._err(404, "Item not found"); return
    meta["name"] = name
    _write_item_meta(lib, item_id, meta)
    _patch_item_cache(lib, item_id, {"name": name})
    _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
    h._json(200, {"ok": True})


def handle_patch_item_tags(h, b):
    item_id = str(b.get("id",  "")).strip()
    lib     = str(b.get("lib", "")).strip()
    tags    = b.get("tags", [])
    if not item_id or not lib: h._err(400, "Missing field: id or lib"); return
    if not isinstance(tags, list): h._err(400, "tags must be an array"); return
    meta = _get_item_meta(lib, item_id)
    if meta is None: h._err(404, "Item not found"); return
    meta["tags"] = tags
    _write_item_meta(lib, item_id, meta)
    _patch_item_cache(lib, item_id, {"tags": tags})
    _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
    h._json(200, {"ok": True})


def handle_patch_item_folders(h, b):
    item_id    = str(b.get("id",  "")).strip()
    lib        = str(b.get("lib", "")).strip()
    folder_ids = b.get("folder_ids", [])
    if not item_id or not lib: h._err(400, "Missing field: id or lib"); return
    if not isinstance(folder_ids, list) or not folder_ids:
        h._err(400, "folder_ids must be a non-empty array"); return
    meta = _get_item_meta(lib, item_id)
    if meta is None: h._err(404, "Item not found"); return
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
    h._json(200, {"ok": True, "new_tags": new_tags})


def handle_patch_item_star(h, b):
    item_id = str(b.get("id",  "")).strip()
    lib     = str(b.get("lib", "")).strip()
    star    = b.get("star", 0)
    if not item_id or not lib: h._err(400, "Missing field: id or lib"); return
    if not isinstance(star, int) or star < 0 or star > 5:
        h._err(400, "star must be integer 0-5"); return
    meta = _get_item_meta(lib, item_id)
    if meta is None: h._err(404, "Item not found"); return
    meta["star"] = star
    _write_item_meta(lib, item_id, meta)
    _patch_item_cache(lib, item_id, {"star": star})
    _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
    h._json(200, {"ok": True})


def handle_patch_item_annotation(h, b):
    item_id    = str(b.get("id",         "")).strip()
    lib        = str(b.get("lib",        "")).strip()
    annotation = str(b.get("annotation", ""))
    if not item_id or not lib: h._err(400, "Missing field: id or lib"); return
    meta = _get_item_meta(lib, item_id)
    if meta is None: h._err(404, "Item not found"); return
    meta["annotation"] = annotation
    _write_item_meta(lib, item_id, meta)
    _patch_item_cache(lib, item_id, {"annotation": annotation})
    _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
    h._json(200, {"ok": True})


def handle_patch_item_url(h, b):
    item_id = str(b.get("id",  "")).strip()
    lib     = str(b.get("lib", "")).strip()
    url     = str(b.get("url", "")).strip()
    if not item_id or not lib: h._err(400, "Missing field: id or lib"); return
    meta = _get_item_meta(lib, item_id)
    if meta is None: h._err(404, "Item not found"); return
    meta["url"] = url
    _write_item_meta(lib, item_id, meta)
    _patch_item_cache(lib, item_id, {"url": url})
    _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib})
    h._json(200, {"ok": True})


# ---------------------------------------------------------------------------
# DELETE handlers
# ---------------------------------------------------------------------------

def handle_delete_item(h):
    qs = h.path.split("?", 1)[1] if "?" in h.path else ""
    p  = parse_qs(qs)
    item_id = unquote(p.get("id",  [""])[0]).strip()
    lib     = unquote(p.get("lib", [""])[0]).strip()
    if not item_id or not lib: h._err(400, "Missing ?id= or ?lib="); return
    lib_path = LIBRARY_PATHS.get(lib)
    if lib_path is None: h._err(404, "Library not found"); return
    info_dir = lib_path / "images" / f"{item_id}.info"
    if not info_dir.exists(): h._err(404, "Item not found"); return
    with _lib_locks[lib]:
        shutil.rmtree(info_dir, ignore_errors=True)
    _remove_item_cache(lib, item_id)
    _sse_broadcast(lib, {"type": "item_deleted", "id": item_id, "lib": lib})
    h._json(200, {"ok": True})


def handle_delete_item_link(h):
    b = h._read_json()
    if b is None: return
    item_id   = str(b.get("id",        "")).strip()
    lib       = str(b.get("lib",       "")).strip()
    target_id = str(b.get("target_id", "")).strip()
    if not item_id or not lib or not target_id:
        h._err(400, "Missing field: id, lib, or target_id"); return
    _remove_link(lib, item_id, target_id)
    h._json(200, {"ok": True})
