"""Tags synchronisation helpers (folder tags and item tags)."""
import json
from pathlib import Path

from config import DATA_DIR, LIBRARY_PATHS, _lib_locks
from api_helpers import _build_folder_map


def _compute_folder_tags_diff(lib_name: str) -> list:
    """Compute diff: current vs hierarchy-expected folder tags."""
    lib_path = LIBRARY_PATHS.get(lib_name)
    if not lib_path:
        return []
    meta_path = lib_path / "metadata.json"
    if not meta_path.exists():
        return []
    try:
        meta = json.loads(meta_path.read_text("utf-8"))
    except Exception:
        return []
    changes: list = []

    def _recurse(folders, parent_tags):
        for f in folders:
            expected = parent_tags + [f.get("name", "")]
            current  = f.get("tags", [])
            if sorted(current) != sorted(expected):
                changes.append({
                    "id":            f["id"],
                    "name":          f.get("name", ""),
                    "current_tags":  current,
                    "expected_tags": expected,
                })
            _recurse(f.get("children", []), expected)

    _recurse(meta.get("folders", []), [])
    return changes


def _apply_folder_tags_sync(lib_name: str) -> int:
    """Write expected tags to library metadata.json folders. Returns updated count."""
    lib_path = LIBRARY_PATHS.get(lib_name)
    if not lib_path:
        return 0
    meta_path = lib_path / "metadata.json"
    if not meta_path.exists():
        return 0
    with _lib_locks[lib_name]:
        try:
            meta = json.loads(meta_path.read_text("utf-8"))
            count = [0]

            def _recurse(folders, parent_tags):
                for f in folders:
                    expected = parent_tags + [f.get("name", "")]
                    if sorted(f.get("tags", [])) != sorted(expected):
                        f["tags"] = expected
                        count[0] += 1
                    _recurse(f.get("children", []), expected)

            _recurse(meta.get("folders", []), [])
            if count[0] > 0:
                tmp = meta_path.with_suffix(".tmp")
                tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
                tmp.replace(meta_path)
            return count[0]
        except Exception:
            return 0


def _expected_item_tags(meta: dict, folder_map: dict) -> list:
    """素材期望標籤 = 其「全部」資料夾階層標籤的有序聯集（A1 A2 A B1 B2 B3 B C；同 Eagle 自動標籤），
    並保留系統標記 archived（垃圾桶狀態不因同步而消失）。"""
    out: list = []
    seen: set = set()
    for fid in meta.get("folders", []) or []:
        for t in folder_map.get(fid, []):
            if t and t not in seen:
                seen.add(t); out.append(t)
    if "archived" in (meta.get("tags") or []) and "archived" not in seen:
        out.append("archived")
    return out


def _iter_item_metas(lib_path: Path):
    images_dir = lib_path / "images"
    if not images_dir.exists():
        return
    for info_dir in sorted(images_dir.iterdir()):
        if not info_dir.is_dir() or not info_dir.name.endswith(".info"):
            continue
        meta_path = info_dir / "metadata.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text("utf-8"))
        except Exception:
            continue
        yield meta_path, meta


def _media_kind(meta: dict) -> str:
    ext = str(meta.get("ext", "")).lower()
    if ext in ("mp4", "mov", "webm", "mkv", "avi", "m4v", "ts", "flv", "wmv"):
        return "video"
    return "other"


def _compute_items_tags_diff(lib_name: str, only: str = "") -> list:
    """Compute diff: current vs expected item tags（全部資料夾階層聯集）。only='video' 僅影片。"""
    lib_path = LIBRARY_PATHS.get(lib_name)
    if not lib_path:
        return []
    folder_map = _build_folder_map(lib_name)
    changes: list = []
    try:
        for _, meta in _iter_item_metas(lib_path):
            if not meta.get("folders"):
                continue
            if only == "video" and _media_kind(meta) != "video":
                continue
            expected = _expected_item_tags(meta, folder_map)
            current  = meta.get("tags", [])
            if sorted(current) != sorted(expected):
                changes.append({
                    "id":            meta.get("id", ""),
                    "name":          meta.get("name", ""),
                    "current_tags":  current,
                    "expected_tags": expected,
                })
    except Exception:
        pass
    return changes


def _apply_items_tags_sync(lib_name: str, only: str = "") -> int:
    """Apply items tags sync：Eagle 開啟該庫時優先走 Eagle API（item/update，Eagle 立即生效且不會回寫覆蓋），
    否則直接寫 metadata.json；最後批次更新快取。回傳更新筆數。"""
    from api_helpers import _eagle_sync_gate, _write_via_eagle_api
    lib_path = LIBRARY_PATHS.get(lib_name)
    if not lib_path:
        return 0
    folder_map = _build_folder_map(lib_name)
    can_api, _reason = _eagle_sync_gate(lib_name)
    updated: dict = {}   # item_id → new_tags
    try:
        for meta_path, meta in _iter_item_metas(lib_path):
            if not meta.get("folders"):
                continue
            if only == "video" and _media_kind(meta) != "video":
                continue
            expected = _expected_item_tags(meta, folder_map)
            if sorted(meta.get("tags", [])) == sorted(expected):
                continue
            item_id = meta.get("id", "")
            ok = False
            if can_api and item_id:
                ok = _write_via_eagle_api("item/update", {"id": item_id, "tags": expected})
            if not ok:
                meta["tags"] = expected
                try:
                    tmp = meta_path.with_suffix(".tmp")
                    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
                    tmp.replace(meta_path)
                    ok = True
                except Exception:
                    ok = False
            if ok and item_id:
                updated[item_id] = expected
    except Exception:
        pass
    if updated:
        cache_path = DATA_DIR / lib_name / "urls_data.json"
        if cache_path.exists():
            with _lib_locks[lib_name]:
                try:
                    data = json.loads(cache_path.read_text("utf-8"))
                    for item in data.get("items", []):
                        if item["id"] in updated:
                            item["tags"] = updated[item["id"]]
                    tmp = cache_path.with_suffix(".tmp")
                    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
                    tmp.replace(cache_path)
                except Exception:
                    pass
    return len(updated)
