"""Item/folder CRUD, SSE event bus, and item-link helpers."""
import json
import queue
import threading
from pathlib import Path

from config import DATA_DIR, LIBRARY_PATHS, _lib_locks

try:
    import urllib.request as _urllib_req
except ImportError:
    _urllib_req = None  # type: ignore

# ---------------------------------------------------------------------------
# SSE event bus
# ---------------------------------------------------------------------------

_sse_clients: dict = {}   # lib_name → [queue.Queue, ...]
_sse_lock = threading.Lock()


def _sse_subscribe(lib_name: str) -> queue.Queue:
    q: queue.Queue = queue.Queue(maxsize=64)
    with _sse_lock:
        _sse_clients.setdefault(lib_name, []).append(q)
    return q


def _sse_unsubscribe(lib_name: str, q: queue.Queue) -> None:
    with _sse_lock:
        lst = _sse_clients.get(lib_name, [])
        if q in lst:
            lst.remove(q)


def _sse_broadcast(lib_name: str, event: dict) -> None:
    import json as _json
    payload = _json.dumps(event, ensure_ascii=False)
    with _sse_lock:
        for q in list(_sse_clients.get(lib_name, [])):
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass


# ---------------------------------------------------------------------------
# Folder map / tree
# ---------------------------------------------------------------------------

def _build_folder_map(lib_name: str) -> dict:
    """Return {folder_id: expected_tags[]} based on folder name hierarchy."""
    lib_path = LIBRARY_PATHS.get(lib_name)
    if not lib_path:
        return {}
    meta_path = lib_path / "metadata.json"
    if not meta_path.exists():
        return {}
    try:
        meta = json.loads(meta_path.read_text("utf-8"))
    except Exception:
        return {}
    result: dict = {}

    def _recurse(folders, parent_tags):
        for f in folders:
            my_tags = parent_tags + [f.get("name", "")]
            result[f["id"]] = my_tags
            _recurse(f.get("children", []), my_tags)

    _recurse(meta.get("folders", []), [])
    return result


def _get_folder_tree(lib_name: str) -> list:
    """Return folder tree list for UI folder picker."""
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

    def _build(folders):
        result = []
        for f in folders:
            node = {
                "id":       f.get("id", ""),
                "name":     f.get("name", ""),
                "children": _build(f.get("children", [])),
            }
            result.append(node)
        return result

    return _build(meta.get("folders", []))


# ---------------------------------------------------------------------------
# Item CRUD helpers
# ---------------------------------------------------------------------------

def _get_item_meta(lib_name: str, item_id: str):
    """Read item metadata.json. Returns dict or None."""
    lib_path = LIBRARY_PATHS.get(lib_name)
    if not lib_path:
        return None
    meta_path = lib_path / "images" / f"{item_id}.info" / "metadata.json"
    if not meta_path.exists():
        return None
    try:
        return json.loads(meta_path.read_text("utf-8"))
    except Exception:
        return None


def _write_item_meta(lib_name: str, item_id: str, meta: dict) -> bool:
    """Atomically write item metadata.json. Returns True on success."""
    lib_path = LIBRARY_PATHS.get(lib_name)
    if not lib_path:
        return False
    meta_path = lib_path / "images" / f"{item_id}.info" / "metadata.json"
    if not meta_path.parent.exists():
        return False
    try:
        with _lib_locks[lib_name]:
            tmp = meta_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
            tmp.replace(meta_path)
        return True
    except Exception:
        return False


def _patch_item_cache(lib_name: str, item_id: str, updates: dict) -> bool:
    """Patch a single item in urls_data.json cache. Returns True on success."""
    cache_path = DATA_DIR / lib_name / "urls_data.json"
    if not cache_path.exists():
        return False
    with _lib_locks[lib_name]:
        try:
            data = json.loads(cache_path.read_text("utf-8"))
            for item in data.get("items", []):
                if item.get("id") == item_id:
                    item.update(updates)
                    break
            tmp = cache_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
            tmp.replace(cache_path)
            return True
        except Exception:
            return False


def _remove_item_cache(lib_name: str, item_id: str) -> bool:
    """Remove an item from urls_data.json cache. Returns True on success."""
    cache_path = DATA_DIR / lib_name / "urls_data.json"
    if not cache_path.exists():
        return False
    with _lib_locks[lib_name]:
        try:
            data = json.loads(cache_path.read_text("utf-8"))
            before = len(data.get("items", []))
            data["items"] = [i for i in data.get("items", []) if i.get("id") != item_id]
            if "stats" in data:
                data["stats"]["total"] = len(data["items"])
            if len(data["items"]) < before:
                tmp = cache_path.with_suffix(".tmp")
                tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
                tmp.replace(cache_path)
            return True
        except Exception:
            return False


# ---------------------------------------------------------------------------
# Eagle App API bridge
# ---------------------------------------------------------------------------

def _write_via_eagle_api(op: str, payload: dict) -> bool:
    """Try Eagle App V1 API (localhost:41595/api/…). Returns True if succeeded."""
    if _urllib_req is None:
        return False
    import json as _json
    try:
        url  = f"http://localhost:41595/api/{op}"
        data = _json.dumps(payload).encode("utf-8")
        req  = _urllib_req.Request(url, data=data,
                                   headers={"Content-Type": "application/json"})
        with _urllib_req.urlopen(req, timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def _write_via_eagle_api_v2(op: str, payload: dict) -> bool:
    """Try Eagle App V2 API (localhost:41595/api/v2/…). Returns True if succeeded.

    Eagle 4.0 Build 21+ required.
    Example: _write_via_eagle_api_v2("item/update", {"id": item_id, "isDeleted": False})
    """
    if _urllib_req is None:
        return False
    import json as _json
    try:
        url  = f"http://localhost:41595/api/v2/{op}"
        data = _json.dumps(payload).encode("utf-8")
        req  = _urllib_req.Request(url, data=data,
                                   headers={"Content-Type": "application/json"})
        with _urllib_req.urlopen(req, timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Item links (data/{lib}/links.json, bidirectional)
# ---------------------------------------------------------------------------

def _load_links(lib_name: str) -> dict:
    p = DATA_DIR / lib_name / "links.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return {}


def _save_links(lib_name: str, data: dict) -> None:
    lib_dir = DATA_DIR / lib_name
    lib_dir.mkdir(parents=True, exist_ok=True)
    tmp = lib_dir / "links.json.tmp"
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(lib_dir / "links.json")


def _add_link(lib_name: str, item_id: str, target_id: str) -> None:
    with _lib_locks[lib_name]:
        data = _load_links(lib_name)
        for a, b in [(item_id, target_id), (target_id, item_id)]:
            lst = data.setdefault(a, [])
            if b not in lst:
                lst.append(b)
        _save_links(lib_name, data)


def _remove_link(lib_name: str, item_id: str, target_id: str) -> None:
    with _lib_locks[lib_name]:
        data = _load_links(lib_name)
        for a, b in [(item_id, target_id), (target_id, item_id)]:
            if a in data:
                data[a] = [x for x in data[a] if x != b]
                if not data[a]:
                    del data[a]
        _save_links(lib_name, data)
