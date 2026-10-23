"""檔案層垃圾桶（Phase A：A1 Excire 型 / A3 dir 型共用）。

機制：刪除 = 原檔搬移至庫根目錄 `.viewer-trash/`（保留相對路徑）＋
intent journal（`data/{lib}/trash_journal.json`）；還原 = 依 journal 搬回原位；
永久刪除 = 刪 `.viewer-trash` 內檔案 + 移除 journal 條目。

安全律：
- 絕不寫 Excire 的兩顆 SQLite DB（Excire Foto 獨佔鎖 + ON DELETE CASCADE 真刪風險）。
- journal 為 SSOT：intent 先行（state=pending）→ 搬移完成標記 done → crash 後載入時自癒。
- DrvFS mtime 不可靠 → 時間一律以 journal ts（epoch ms）為準。
"""
import json
import shutil
import threading
import time
from collections import defaultdict
from pathlib import Path

from config import DATA_DIR, EXCIRE_PATHS, FOLDER_PATHS, LIBRARY_PATHS

VIDEO_EXTS = {"mp4", "webm", "mov", "avi", "mkv", "m4v"}

# journal 專用鎖（獨立於 config._lib_locks，避免與 cache helper 重入死鎖）
_journal_locks: dict = defaultdict(threading.Lock)


# ---------------------------------------------------------------------------
# 庫型判別 / 路徑
# ---------------------------------------------------------------------------

def lib_kind(lib_key: str):
    """依 lib 參數判別庫型：'eagle' | 'excire' | 'dir' | None（三組 key 無碰撞）。"""
    if lib_key in LIBRARY_PATHS:
        return "eagle"
    if lib_key in EXCIRE_PATHS:
        return "excire"
    if lib_key in FOLDER_PATHS:
        return "dir"
    return None


def trash_root(lib_key: str):
    """`.viewer-trash` 實體位置。

    - Excire 型：庫根目錄（resource/ 同層）→ Excire 資料夾同步不會把垃圾桶當新照片重匯入。
    - dir 型：若掛載點是 Excire 庫的 resource/（parent 有 excire_foto.local.db）
      → 與 Excire 型共用庫根 `.viewer-trash`（同一實體檔案單一垃圾桶位置）；
      否則落在掛載目錄自身之下（索引掃描一律排除 . 開頭目錄）。
    """
    root = EXCIRE_PATHS.get(lib_key)
    if root is not None:
        return Path(root) / ".viewer-trash"
    root = FOLDER_PATHS.get(lib_key)
    if root is None:
        return None
    root = Path(root)
    if (root.parent / "excire_foto.local.db").exists():
        return root.parent / ".viewer-trash"
    return root / ".viewer-trash"


def _journal_path(lib_key: str) -> Path:
    return DATA_DIR / lib_key / "trash_journal.json"


# ---------------------------------------------------------------------------
# journal 載入 / 儲存（載入時自癒）
# ---------------------------------------------------------------------------

def _save_entries(lib_key: str, entries: list) -> None:
    p = _journal_path(lib_key)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps({"version": 1, "entries": entries},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def _load_entries(lib_key: str) -> list:
    """讀 journal 並自癒（呼叫端須已持 _journal_locks[lib_key]）：
    - pending + trash 檔已在 → 補標 done（crash 於 rename 後、標記前）
    - pending + trash 檔不在、原檔仍在 → 意圖未執行 → 丟棄
    - done + trash 檔消失 → 已還原或外部刪除 → 丟棄
    """
    p = _journal_path(lib_key)
    if not p.exists():
        return []
    try:
        entries = json.loads(p.read_text(encoding="utf-8")).get("entries", [])
    except Exception:
        return []
    healed, changed = [], False
    for e in entries:
        trash_p = Path(e.get("trash", ""))
        if e.get("state") == "pending":
            if e.get("trash") and trash_p.exists():
                e["state"] = "done"
                changed = True
                healed.append(e)
            else:
                changed = True          # 意圖未執行 / 兩邊皆無 → 丟棄
        else:
            if e.get("trash") and trash_p.exists():
                healed.append(e)
            else:
                changed = True          # trash 檔消失 → 丟棄
    if changed:
        _save_entries(lib_key, healed)
    return healed


def trashed_photo_ids(lib_key: str) -> set:
    """Excire 查詢排除用：journal 內（仍在垃圾桶）的 photo_info.Id 集合。"""
    with _journal_locks[lib_key]:
        entries = _load_entries(lib_key)
    return {int(e["photo_id"]) for e in entries if e.get("photo_id") is not None}


# ---------------------------------------------------------------------------
# 來源解析（excire id / dir cache item → 實體路徑 + 條目欄位）
# ---------------------------------------------------------------------------

def _resolve_excire(lib_key: str, item_id: str):
    """'excire_{pid}' → (entry_fields, orig_path)；失敗回 (None, 錯誤訊息)。"""
    from excire import get_excire_library          # 延遲載入避免循環 import
    if not item_id.startswith("excire_"):
        return None, f"非 Excire 項目 id：{item_id}"
    try:
        pid = int(item_id[len("excire_"):])
    except ValueError:
        return None, f"無效的 Excire 項目 id：{item_id}"
    lib = get_excire_library(lib_key)
    if lib is None or not lib.available:
        return None, f"Excire 資源庫無法使用：{lib_key}"
    row = lib._photo_row(pid)
    if row is None:
        return None, f"Excire 找不到照片：{pid}"
    orig = lib.original_path(pid)
    if orig is None or not orig.exists():
        return None, f"原始檔不存在：{item_id}"
    folder = lib._folder_map().get(row["collectionId"])
    rel = (f"{folder['rel']}/{row['Filename']}" if folder and folder["rel"]
           else str(row["Filename"]))
    ext = Path(row["Filename"] or "").suffix.lstrip(".").lower()
    fields = {
        "id":       item_id,
        "kind":     "excire",
        "photo_id": pid,
        "orig_id":  item_id,
        "rel":      rel,
        "name":     Path(row["Filename"] or "").stem or str(pid),
        "ext":      ext,
    }
    return fields, orig


def _resolve_dir(lib_key: str, item_id: str):
    """dir 型：urls_data.json cache item id → (entry_fields, orig_path)。"""
    cache_path = DATA_DIR / lib_key / "urls_data.json"
    if not cache_path.exists():
        return None, f"尚未索引：{lib_key}"
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception as e:
        return None, f"快取讀取失敗：{e}"
    item = next((i for i in data.get("items", []) if i.get("id") == item_id), None)
    if item is None:
        return None, f"找不到項目：{item_id}"
    prefix = f"folder-images/{lib_key}/"
    file_field = item.get("file", "")
    if not file_field.startswith(prefix):
        return None, f"非本庫檔案：{item_id}"
    rel = file_field[len(prefix):]
    orig = Path(FOLDER_PATHS[lib_key]) / rel
    if not orig.exists():
        return None, f"原始檔不存在：{rel}"
    fields = {
        "id":       f"vtrash_{int(time.time() * 1000)}",   # 唯一化於 trash_items 內處理
        "kind":     "dir",
        "photo_id": None,
        "orig_id":  item_id,
        "rel":      rel,
        "name":     item.get("name") or Path(rel).stem,
        "ext":      (item.get("ext") or Path(rel).suffix.lstrip(".")).lower(),
    }
    return fields, orig


def _unique_dest(dest: Path) -> Path:
    """搬移目的地重名 → 附加 ~n 後綴。"""
    if not dest.exists():
        return dest
    for n in range(1, 1000):
        cand = dest.with_name(f"{dest.stem}~{n}{dest.suffix}")
        if not cand.exists():
            return cand
    return dest.with_name(f"{dest.stem}~{int(time.time() * 1000)}{dest.suffix}")


# ---------------------------------------------------------------------------
# dir 型 cache 同步（移除 / 還原重建；沿用 tmp+replace 原子寫入）
# ---------------------------------------------------------------------------

def _dir_cache_mutate(lib_key: str, fn) -> None:
    from config import _lib_locks
    cache_path = DATA_DIR / lib_key / "urls_data.json"
    if not cache_path.exists():
        return
    with _lib_locks[lib_key]:
        try:
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            fn(data)
            if "stats" in data:
                data["stats"]["total"] = len(data.get("items", []))
            tmp = cache_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(cache_path)
        except Exception as e:
            print(f"[trash] {lib_key} cache 更新失敗: {e}")


def _dir_cache_remove(lib_key: str, item_id: str) -> None:
    _dir_cache_mutate(lib_key, lambda d: d.update(
        items=[i for i in d.get("items", []) if i.get("id") != item_id]))


def _dir_cache_readd(lib_key: str, entry: dict) -> None:
    """還原後把項目補回 cache（重掃前即可見；重掃會以磁碟狀態重建）。"""
    rel = entry["rel"]
    category = rel.split("/", 1)[0] if "/" in rel else ""
    ext = entry.get("ext", "")
    orig = Path(FOLDER_PATHS[lib_key]) / rel

    def _apply(d):
        items = d.get("items", [])
        used = {i.get("id") for i in items}
        item_id = entry.get("orig_id") or entry["id"]
        if item_id in used:                      # 重掃後 id 已被他人占用 → 用 journal id
            item_id = entry["id"]
        if item_id in used:
            return
        items.append({
            "id":         item_id,
            "name":       entry.get("name", ""),
            "url":        "",
            "domain":     "local",
            "kind":       "video" if ext in VIDEO_EXTS else "other",
            "tags":       [category] if category else [],
            "folders":    [category] if category else [],
            "thumb":      None,
            "file":       f"folder-images/{lib_key}/{rel}",
            "media_type": "video" if ext in VIDEO_EXTS else "image",
            "width":      None,
            "height":     None,
            "mtime":      int(orig.stat().st_mtime * 1000) if orig.exists() else entry.get("ts"),
            "size":       orig.stat().st_size if orig.exists() else entry.get("size"),
            "star":       0,
            "annotation": "",
            "ext":        ext,
            "source":     "folder",
        })
        d["items"] = items

    _dir_cache_mutate(lib_key, _apply)


# ---------------------------------------------------------------------------
# 對外操作：刪除（入垃圾桶）/ 還原 / 永久刪除 / 清空 / 列表
# ---------------------------------------------------------------------------

def trash_items(lib_key: str, ids: list) -> dict:
    """刪除 = 搬入 .viewer-trash + journal。回 {trashed, errors}。"""
    kind = lib_kind(lib_key)
    root = trash_root(lib_key)
    if kind not in ("excire", "dir") or root is None:
        return {"trashed": [], "errors": [f"庫不支援檔案層垃圾桶：{lib_key}"]}
    trashed, errors = [], []
    with _journal_locks[lib_key]:
        entries = _load_entries(lib_key)
        active_ids = {e["id"] for e in entries} | {e.get("orig_id") for e in entries}
        seq = 0
        for item_id in ids:
            if item_id in active_ids:
                errors.append(f"已在垃圾桶：{item_id}")
                continue
            fields, orig = (_resolve_excire(lib_key, item_id) if kind == "excire"
                            else _resolve_dir(lib_key, item_id))
            if fields is None:
                errors.append(orig)                # orig 此時為錯誤訊息
                continue
            if kind == "dir":
                seq += 1
                fields["id"] = f"vtrash_{int(time.time() * 1000)}_{seq}"
            dest = _unique_dest(root / fields["rel"])
            try:
                size = orig.stat().st_size
            except OSError:
                size = None
            entry = {
                **fields,
                "orig":  str(orig),
                "trash": str(dest),
                "size":  size,
                "ts":    int(time.time() * 1000),
                "state": "pending",
            }
            entries.append(entry)
            _save_entries(lib_key, entries)        # intent 先行（crash-safe）
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(orig), str(dest))
            except OSError as e:
                entries.remove(entry)              # 搬移失敗 → 回滾意圖
                _save_entries(lib_key, entries)
                errors.append(f"搬移失敗 {item_id}：{e}")
                continue
            entry["state"] = "done"
            _save_entries(lib_key, entries)
            active_ids.add(item_id)
            if kind == "dir":
                _dir_cache_remove(lib_key, entry["orig_id"])
            trashed.append(item_id)
    return {"trashed": trashed, "errors": errors}


def _match(entry: dict, wanted: set) -> bool:
    return entry["id"] in wanted or entry.get("orig_id") in wanted


def _unmatched(entries: list, wanted: set) -> list:
    """wanted 中沒有任何 journal 條目對應的 id（= 不在垃圾桶）。"""
    covered = set()
    for e in entries:
        covered.add(e["id"])
        covered.add(e.get("orig_id"))
    return [i for i in wanted if i not in covered]


def restore_items(lib_key: str, ids: list) -> dict:
    """還原 = journal 反向搬回原位。回 {restored, errors}。"""
    if lib_kind(lib_key) not in ("excire", "dir"):
        return {"restored": [], "errors": [f"庫不支援檔案層垃圾桶：{lib_key}"]}
    wanted = set(ids)
    restored, errors = [], []
    with _journal_locks[lib_key]:
        entries = _load_entries(lib_key)
        errors += [f"不在垃圾桶：{i}" for i in _unmatched(entries, wanted)]
        kept = []
        for e in entries:
            if not _match(e, wanted):
                kept.append(e)
                continue
            src, dst = Path(e["trash"]), Path(e["orig"])
            if not src.exists():
                errors.append(f"垃圾桶檔案不存在：{e['id']}")
                continue                            # 條目丟棄（自癒語意）
            if dst.exists():
                dst = _unique_dest(dst)
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dst))
            except OSError as ex:
                errors.append(f"還原失敗 {e['id']}：{ex}")
                kept.append(e)
                continue
            if e.get("kind") == "dir":
                _dir_cache_readd(lib_key, e)
            restored.append(e["id"])
        _save_entries(lib_key, kept)
    return {"restored": restored, "errors": errors}


def delete_items(lib_key: str, ids: list) -> dict:
    """永久刪除（僅限已在垃圾桶的 journal 條目）。回 {deleted, errors}。"""
    if lib_kind(lib_key) not in ("excire", "dir"):
        return {"deleted": [], "errors": [f"庫不支援檔案層垃圾桶：{lib_key}"]}
    wanted = set(ids)
    deleted, errors = [], []
    with _journal_locks[lib_key]:
        entries = _load_entries(lib_key)
        errors += [f"不在垃圾桶：{i}" for i in _unmatched(entries, wanted)]
        kept = []
        for e in entries:
            if not _match(e, wanted):
                kept.append(e)
                continue
            try:
                Path(e["trash"]).unlink(missing_ok=True)
            except OSError as ex:
                errors.append(f"刪除失敗 {e['id']}：{ex}")
                kept.append(e)
                continue
            deleted.append(e["id"])
        _save_entries(lib_key, kept)
    return {"deleted": deleted, "errors": errors}


def empty_trash(lib_key: str) -> dict:
    """清空垃圾桶（全部永久刪除）。回 {deleted, errors}。"""
    with _journal_locks[lib_key]:
        ids = [e["id"] for e in _load_entries(lib_key)]
    if not ids:
        return {"deleted": [], "errors": []}
    return delete_items(lib_key, ids)


def list_trash(lib_key: str) -> list:
    """垃圾桶清單（viewer item schema 相容；tags 固定含 'archived'）。"""
    kind = lib_kind(lib_key)
    root = trash_root(lib_key)
    if kind not in ("excire", "dir") or root is None:
        return []
    with _journal_locks[lib_key]:
        entries = _load_entries(lib_key)
    items = []
    for e in entries:
        try:
            trash_rel = Path(e["trash"]).relative_to(root).as_posix()
        except ValueError:
            trash_rel = Path(e["trash"]).name
        ext = e.get("ext", "")
        media_type = "video" if ext in VIDEO_EXTS else "image"
        rel = e.get("rel", "")
        category = rel.split("/", 1)[0] if "/" in rel else ""
        item = {
            "id":         e["id"],
            "name":       e.get("name", ""),
            "url":        "",
            "domain":     "local",
            "kind":       "video" if media_type == "video" else "other",
            "tags":       ["archived"],
            "folders":    [category] if category else [],
            "thumb":      None,
            "file":       f"trash-file/{lib_key}/{trash_rel}",
            "media_type": media_type,
            "width":      None,
            "height":     None,
            "mtime":      e.get("ts"),
            "size":       e.get("size"),
            "star":       0,
            "annotation": "",
            "ext":        ext,
            "source":     "excire" if kind == "excire" else "folder",
        }
        if kind == "excire" and e.get("photo_id") is not None:
            pid = e["photo_id"]
            item["photo_id"] = pid
            item["thumb"]    = f"excire-thumb/{lib_key}/{pid}"
            item["preview"]  = f"excire-preview/{lib_key}/{pid}"
        items.append(item)
    items.sort(key=lambda i: i.get("mtime") or 0, reverse=True)
    return items
