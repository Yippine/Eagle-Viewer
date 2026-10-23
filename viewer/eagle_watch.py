"""Eagle watcher（新素材偵測 / 刪除偵測）— 背景輪詢 Eagle library，經 SSE 廣播異動。"""
import json
import threading
from pathlib import Path

from config import DATA_DIR, LIBRARY_PATHS
from api_helpers import _get_folder_tree, _sse_broadcast

_eagle_last_ids        = {}   # lib -> frozenset of all .info folder IDs
_eagle_trashed_ids     = {}   # lib -> set of IDs known to be isDeleted=True in Eagle
_eagle_watcher_started = set()
_eagle_snap_cache      = {}   # lib -> { item_id -> snap_dict }（供永久刪除時回查）
_eagle_meta_sig        = {}   # lib -> { item_id -> sig }（tags/folders/name/star/annotation/url 變更偵測）

_SIG_FIELDS = ("tags", "folders", "name", "star", "annotation", "url", "duration", "width", "height")

def _meta_sig(meta: dict):
    return tuple(json.dumps(meta.get(k), ensure_ascii=False, sort_keys=True) for k in _SIG_FIELDS)


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


def _scan_metas(lib: str, item_ids):
    """單趟讀全部 metadata.json：回傳 (isDeleted 集合, {id: sig}, {id: meta})。
    watcher 原本每 10s 就全量讀一次（只看 isDeleted），這裡順便取 tags/folders 等欄位簽章，
    讓 Eagle 內改標籤／移資料夾／改名／評分能即時反映到 viewer 快取（修「快取過期、標籤對不上」）。"""
    lib_path = LIBRARY_PATHS.get(lib)
    if not lib_path:
        return set(), {}, {}
    images_dir = Path(lib_path) / "images"
    trashed, sigs, metas = set(), {}, {}
    for item_id in item_ids:
        meta_path = images_dir / f"{item_id}.info" / "metadata.json"
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            if meta.get("isDeleted"):
                trashed.add(item_id)
            sigs[item_id] = _meta_sig(meta)
            metas[item_id] = meta
        except Exception:
            pass
    return trashed, sigs, metas


def _sync_meta_changes(lib: str, changed_ids, metas: dict) -> int:
    """把變更過的 metadata 欄位寫回 urls_data.json 快取並廣播 item_updated。回傳更新筆數。"""
    from config import _lib_locks
    cache_path = DATA_DIR / lib / "urls_data.json"
    if not cache_path.exists() or not changed_ids:
        return 0
    n = 0
    with _lib_locks[lib]:
        try:
            data = json.loads(cache_path.read_text("utf-8"))
            by_id = {it.get("id"): it for it in data.get("items", [])}
            for item_id in changed_ids:
                meta = metas.get(item_id); it = by_id.get(item_id)
                if not meta or not it:
                    continue
                it["tags"]       = list(meta.get("tags", [])) + (["archived"] if meta.get("isDeleted") else [])
                it["folders"]    = meta.get("folders", [])
                it["name"]       = meta.get("name", it.get("name", ""))
                it["star"]       = meta.get("star", 0)
                it["annotation"] = meta.get("annotation", "")
                if meta.get("url"): it["url"] = meta.get("url")
                if meta.get("duration") is not None: it["duration"] = meta.get("duration")
                w, h = meta.get("width"), meta.get("height")
                if isinstance(w, int) and w > 0: it["width"] = w
                if isinstance(h, int) and h > 0: it["height"] = h
                n += 1
            if n:
                tmp = cache_path.with_suffix(".tmp")
                tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
                tmp.replace(cache_path)
        except Exception:
            return 0
    for item_id in changed_ids:
        _sse_broadcast(lib, {"type": "item_updated", "id": item_id, "lib": lib, "source": "eagle"})
    return n


def _find_cache_stale(lib: str, metas: dict) -> list:
    """快取 vs metadata 對帳：tags/folders/name/star 任一不同者回傳 id 清單。"""
    cache_path = DATA_DIR / lib / "urls_data.json"
    if not cache_path.exists():
        return []
    try:
        data = json.loads(cache_path.read_text("utf-8"))
    except Exception:
        return []
    stale = []
    for it in data.get("items", []):
        m = metas.get(it.get("id"))
        if not m:
            continue
        exp_tags = list(m.get("tags", [])) + (["archived"] if m.get("isDeleted") else [])
        if (sorted(it.get("tags", [])) != sorted(exp_tags)
                or list(it.get("folders", [])) != list(m.get("folders", []))
                or it.get("name", "") != m.get("name", "")
                or (it.get("star", 0) or 0) != (m.get("star", 0) or 0)):
            stale.append(it.get("id"))
    return stale


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
                # ── 首次掃描：建立基準線（全量讀取 isDeleted 狀態 + 欄位簽章），
                #    並與快取對帳一次（伺服器離線期間 Eagle 的標籤／資料夾變更在此補上）
                initial_trashed, sigs, metas = _scan_metas(lib, current_ids)
                _eagle_last_ids[lib]    = current_ids
                _eagle_trashed_ids[lib] = initial_trashed
                _eagle_meta_sig[lib]    = sigs
                stale = _find_cache_stale(lib, metas)
                n_fix = _sync_meta_changes(lib, stale, metas) if stale else 0
                _wlog(f"[watcher:{lib}] 基準線建立：{len(current_ids)} 個 items，{len(initial_trashed)} 個已垃圾桶，快取對帳更新 {n_fix} 筆")
            else:
                added   = current_ids - prev_ids   # 新增的 .info 資料夾
                removed = prev_ids    - current_ids # 消失的 .info 資料夾（永久刪除）

                # 全量讀取 isDeleted 狀態 + 欄位簽章（移除 mtime filter：WSL2 DrvFS mtime 不可靠）
                current_trashed, sigs, metas = _scan_metas(lib, current_ids)
                newly_trashed = (current_trashed - known_trashed) - removed
                known_trashed -= removed          # 已永久刪除的不再追蹤
                known_trashed |= newly_trashed    # 累積已知垃圾桶狀態

                prev_sigs = _eagle_meta_sig.get(lib, {})
                changed = [i for i, sg in sigs.items() if i in prev_sigs and prev_sigs[i] != sg and i not in added]
                _eagle_meta_sig[lib] = sigs
                if changed:
                    n_upd = _sync_meta_changes(lib, changed, metas)
                    _wlog(f"[watcher:{lib}] metadata 變更 {len(changed)} 筆（tags/folders/name/star…）→ 快取更新 {n_upd} 筆")

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
