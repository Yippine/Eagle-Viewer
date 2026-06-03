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


def _compute_items_tags_diff(lib_name: str) -> list:
    """Compute diff: current vs expected item tags based on folder hierarchy."""
    lib_path = LIBRARY_PATHS.get(lib_name)
    if not lib_path:
        return []
    folder_map = _build_folder_map(lib_name)
    images_dir = lib_path / "images"
    if not images_dir.exists():
        return []
    changes: list = []
    try:
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
            folders = meta.get("folders", [])
            if not folders:
                continue
            expected = folder_map.get(folders[0], [])
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


def _apply_items_tags_sync(lib_name: str) -> int:
    """Apply items tags sync. Writes item files, then bulk-patches cache."""
    lib_path = LIBRARY_PATHS.get(lib_name)
    if not lib_path:
        return 0
    folder_map = _build_folder_map(lib_name)
    images_dir = lib_path / "images"
    if not images_dir.exists():
        return 0
    updated: dict = {}   # item_id → new_tags
    try:
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
            folders = meta.get("folders", [])
            if not folders:
                continue
            expected = folder_map.get(folders[0], [])
            if sorted(meta.get("tags", [])) != sorted(expected):
                meta["tags"] = expected
                item_id = meta.get("id", "")
                try:
                    tmp = meta_path.with_suffix(".tmp")
                    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
                    tmp.replace(meta_path)
                    if item_id:
                        updated[item_id] = expected
                except Exception:
                    pass
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
