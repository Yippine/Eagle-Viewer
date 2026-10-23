"""Read-only adapter for Excire Foto libraries.

安全律：兩個 SQLite DB（excire_foto.local.db / backend.db）一律以
``sqlite3.connect("file:...?mode=ro", uri=True)`` 唯讀開啟——絕不寫入、
絕不 immutable=1（Excire App 可能同時開啟，WAL 快照讀取即一致）。

縮圖規則（W01_P3_r01 已實證）：
    {lib}/thumbnails.exfoto/{md5(資料夾Windows路徑)}/{md5(檔名)}.jpg
    previews.exfoto 同規則（1280px 版本）。hash 必須用原始 Windows 字串。
"""
import hashlib
import re
import sqlite3
import threading
import time
from pathlib import Path
from urllib.parse import quote, unquote

from config import EXCIRE_PATHS

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff", ".heic"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"}

# 整圖層級 taggers（排除 9 FaceTagger 的臉部層級標籤）
_IMAGE_TAGGER_PLUGINS = "(5, 6, 7, 8)"   # Aesthetics / Semantic / DominantColors / ImageProperty
_FACE_SEGMENTER_PLUGIN = 17
_TAG_MIN_CONFIDENCE = 0.5
_SQL_IN_CHUNK = 400                       # 避開 SQLite 999 參數上限


def _win_to_posix_path(win: str) -> str:
    """C:\\a\\b → /mnt/c/a/b（僅用於讀檔；hash 計算一律用原始 Windows 字串）。"""
    if not re.match(r"^[A-Za-z]:\\", win):
        return win
    return f"/mnt/{win[0].lower()}{win[2:].replace(chr(92), '/')}"


def _uri_to_posix(file_uri: str) -> str:
    """file:///C:/a/b%20c.jpg → /mnt/c/a/b c.jpg（三庫 100% file:///C:/ 開頭已驗證）。"""
    if not file_uri.startswith("file:///"):
        return unquote(file_uri)
    p = unquote(file_uri[len("file:///"):])          # C:/a/b c.jpg
    if len(p) > 2 and p[1] == ":":
        return f"/mnt/{p[0].lower()}{p[2:]}"
    return p


def _md5(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def _iso_to_ms(iso: str | None):
    """'2019-05-30T07:03:47(.123)' → epoch ms；無效值容忍為 None。"""
    if not iso:
        return None
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(str(iso)).timestamp() * 1000)
    except Exception:
        return None


def _parse_face_region(region_data: str):
    """解析 boost 文字序列化的 FaceSegmenter region_data。

    格式：``... FaceSegmenter {region_number} {region_type} 0 0 <5 floats × N>``
    每框 5 浮點 = cx cy w h angle（中心點/寬高為 0~1 正規化，angle 為度數）。
    region_type=4：臉框 + 左右眼框；region_type=5：單臉框（-1 padding）。
    """
    tok = region_data.split()
    try:
        i = tok.index("FaceSegmenter")
    except ValueError:
        return None
    try:
        region_type = int(tok[i + 2])
    except (IndexError, ValueError):
        region_type = None
    nums = []
    for t in tok[i + 3:]:
        try:
            nums.append(float(t))
        except ValueError:
            continue
    nums = nums[2:]                                   # 跳過前導 "0 0"
    if len(nums) < 5:
        return None
    boxes = [nums[j:j + 5] for j in range(0, len(nums) - len(nums) % 5, 5)]
    face = boxes[0]
    out = {
        "cx": face[0], "cy": face[1], "w": face[2], "h": face[3], "angle": face[4],
        "region_type": region_type,
    }
    if region_type == 4 and len(boxes) >= 3:          # 附眼框（landmark）
        out["eyes"] = [
            {"cx": b[0], "cy": b[1], "w": b[2], "h": b[3], "angle": b[4]}
            for b in boxes[1:3]
        ]
    return out


class ExcireLibrary:
    """單一 Excire Foto 資源庫的唯讀存取（thread-safe，連線快取）。"""

    def __init__(self, name: str, root: Path):
        self.name = name
        self.root = Path(root)
        self.local_db = self.root / "excire_foto.local.db"
        self.backend_db = self.root / "backend.db"
        self.thumb_dir = self.root / "thumbnails.exfoto"
        self.preview_dir = self.root / "previews.exfoto"
        self._lock = threading.Lock()                 # per-query 連線序列化（避免 DrvFS race）
        self._folder_cache = None                     # collectionId → folder dict
        self._aesthetics_cache = None                 # photo_id → score
        self._busy_until = 0.0                        # Excire Foto 獨佔鎖定中 → 此刻前跳過查詢

    # ── availability ────────────────────────────────────────────────────────
    @property
    def available(self) -> bool:
        return self.local_db.exists()

    @property
    def ai_available(self) -> bool:
        return self.backend_db.exists()

    # ── read-only connections（查完即關，不快取 handle）────────────────────
    # 不可長期持有連線：Windows 端 Excire Foto 需要對這些 .db 檔取得鎖，
    # 快取連線會讓檔案 handle 隨伺服器存活而永不釋放，導致 Excire 端無法開啟。
    @staticmethod
    def _connect_ro(db_path: Path):
        # timeout=0.5：Excire Foto 對開啟中的庫持獨佔鎖，等待無意義，
        # 快速失敗讓 status/瀏覽請求不被鎖住的庫拖垮（預設 5s × 重試會疊到數十秒）
        con = sqlite3.connect(
            f"file:{quote(str(db_path))}?mode=ro", uri=True,
            check_same_thread=False, timeout=0.5)
        con.row_factory = sqlite3.Row
        return con

    def _mark_busy_if_locked(self, e) -> None:
        # 僅對「鎖定中」做 30s 負快取；DrvFS 偶發 I/O error 不列入，保留原重試語意
        if "locked" in str(e).lower() or "busy" in str(e).lower():
            self._busy_until = time.monotonic() + 30

    def _query(self, db_path: Path, gate: bool, label: str, sql, params=()):
        # DrvFS（/mnt/c）上 SQLite 偶發 disk I/O error（尤其 Windows 側 Excire
        # 同時開啟時）→ 重連重試一次，仍失敗回空結果，不讓例外炸掉 request
        if not gate:
            return []
        if time.monotonic() < self._busy_until:
            return []
        with self._lock:
            try:
                con = self._connect_ro(db_path)
            except sqlite3.Error as e:
                self._mark_busy_if_locked(e)
                print(f"[excire] {self.name} {label} connect failed: {e}")
                return []
            try:
                try:
                    return con.execute(sql, params).fetchall()
                except sqlite3.OperationalError:
                    con.close()
                    try:
                        con = self._connect_ro(db_path)
                    except sqlite3.Error as e:
                        self._mark_busy_if_locked(e)
                        print(f"[excire] {self.name} {label} reconnect failed: {e}")
                        return []
                    try:
                        return con.execute(sql, params).fetchall()
                    except sqlite3.Error as e:
                        self._mark_busy_if_locked(e)
                        print(f"[excire] {self.name} {label} query failed after retry: {e}")
                        return []
                except sqlite3.Error:
                    return []
            finally:
                con.close()

    def _q_local(self, sql, params=()):
        return self._query(self.local_db, self.available, "local", sql, params)

    def _q_backend(self, sql, params=()):
        """backend.db 查詢；DB 缺失或查詢失敗（TSJH 分析未完/DrvFS I/O）→ 空結果容忍。"""
        return self._query(self.backend_db, self.ai_available, "backend", sql, params)

    # ── folders ──────────────────────────────────────────────────────────────
    def _folder_map(self) -> dict:
        """collectionId → {name, path_win, rel, dirhash}。rel = resource/ 之後的相對路徑。"""
        if self._folder_cache is not None:
            return self._folder_cache
        rows = self._q_local("SELECT Id, Name, Path FROM registered_collection ORDER BY Path")
        fmap = {}
        for r in rows:
            path_win = r["Path"]
            marker = "\\resource\\"
            idx = path_win.find(marker)
            if idx >= 0:
                rel = path_win[idx + len(marker):].replace("\\", "/")
            elif path_win.endswith("\\resource"):
                rel = ""
            else:
                rel = r["Name"]
            fmap[r["Id"]] = {
                "id": r["Id"], "name": r["Name"], "path_win": path_win,
                "rel": rel, "dirhash": _md5(path_win),
            }
        self._folder_cache = fmap
        return fmap

    def _folder_descendants(self, folder_id: int) -> list:
        """folder 及其所有子資料夾的 collectionId（樹狀靠 Path 前綴推導）。"""
        fmap = self._folder_map()
        target = fmap.get(folder_id)
        if target is None:
            return []
        prefix = target["path_win"] + "\\"
        return [fid for fid, f in fmap.items()
                if fid == folder_id or f["path_win"].startswith(prefix)]

    def folder_tree(self) -> list:
        """registered_collection → 樹（Path 前綴組樹），含直屬/遞迴照片數。"""
        fmap = self._folder_map()
        counts = {r["collectionId"]: r["n"] for r in self._q_local(
            "SELECT collectionId, COUNT(*) AS n FROM photo_info GROUP BY collectionId")}
        by_path = {f["path_win"]: f["id"] for f in fmap.values()}
        nodes = {fid: {"id": fid, "name": f["name"], "path": f["rel"],
                       "photo_count": counts.get(fid, 0), "children": []}
                 for fid, f in fmap.items()}
        roots = []
        for fid, f in fmap.items():
            parent_path = f["path_win"].rsplit("\\", 1)[0]
            pid = by_path.get(parent_path)
            if pid is not None and pid != fid:
                nodes[pid]["children"].append(nodes[fid])
            else:
                roots.append(nodes[fid])

        def _finish(node):
            node["children"].sort(key=lambda n: n["name"].lower())
            node["total_count"] = node["photo_count"] + sum(
                _finish(c) for c in node["children"])
            return node["total_count"]

        for r in roots:
            _finish(r)
        roots.sort(key=lambda n: n["name"].lower())
        return roots

    # ── collections（相簿）──────────────────────────────────────────────────
    def collections(self) -> list:
        rows = self._q_local(
            "SELECT cc.Id, cc.Name, g.Name AS grp,"
            " (SELECT COUNT(*) FROM custom_collection__photo_infos_photo_info l"
            "  WHERE l.customCollectionId = cc.Id) AS n"
            " FROM custom_collection cc"
            " LEFT JOIN custom_collection_group g ON g.Id = cc.groupId"
            " ORDER BY g.Id, cc.Name")
        return [{"id": r["Id"], "name": r["Name"], "group": r["grp"],
                 "photo_count": r["n"]} for r in rows]

    def _collection_photo_ids(self, collection_id: int) -> set:
        rows = self._q_local(
            "SELECT photoInfoId FROM custom_collection__photo_infos_photo_info"
            " WHERE customCollectionId = ?", (collection_id,))
        return {r["photoInfoId"] for r in rows}

    # ── AI keywords / tags ───────────────────────────────────────────────────
    def keywords(self) -> list:
        """AI 標籤字典（backend.db annotations）。backend 缺失 → []。"""
        rows = self._q_backend(
            "SELECT id, annotation, images_count FROM annotations"
            " WHERE images_count > 0 AND annotation != 'image_aesthetics'"
            " ORDER BY images_count DESC")
        return [{"id": r["id"], "keyword": r["annotation"], "count": r["images_count"]}
                for r in rows]

    def _keyword_photo_ids(self, keyword: str) -> set:
        rows = self._q_backend(
            "SELECT DISTINCT i.custom_id AS pid"
            " FROM annotation_relations ar"
            " JOIN images i ON i.id = ar.image_id"
            " JOIN annotations a ON a.id = ar.annotation_id"
            " WHERE a.annotation = ? AND ar.confidence >= ?"
            "   AND i.custom_id IS NOT NULL",
            (keyword, _TAG_MIN_CONFIDENCE))
        return {r["pid"] for r in rows}

    def _aesthetics_map(self) -> dict:
        """photo_id → 美學分數（annotation 'image_aesthetics' 的 confidence）。"""
        if self._aesthetics_cache is not None:
            return self._aesthetics_cache
        rows = self._q_backend(
            "SELECT i.custom_id AS pid, ar.confidence AS score"
            " FROM annotation_relations ar"
            " JOIN images i ON i.id = ar.image_id"
            " JOIN annotations a ON a.id = ar.annotation_id"
            " WHERE a.annotation = 'image_aesthetics' AND i.custom_id IS NOT NULL")
        self._aesthetics_cache = {r["pid"]: round(r["score"], 3) for r in rows}
        return self._aesthetics_cache

    def _tags_for(self, photo_ids: list) -> dict:
        """批次抓一頁照片的整圖 AI 標籤：pid → (tags[], aesthetics|None)。
        TSJH 未分析照片查無資料 → 缺值容忍（空標籤）。"""
        result = {pid: ([], None) for pid in photo_ids}
        for i in range(0, len(photo_ids), _SQL_IN_CHUNK):
            chunk = photo_ids[i:i + _SQL_IN_CHUNK]
            ph = ",".join("?" * len(chunk))
            rows = self._q_backend(
                f"SELECT i.custom_id AS pid, a.annotation, ar.confidence"
                f" FROM annotation_relations ar"
                f" JOIN images i ON i.id = ar.image_id"
                f" JOIN annotations a ON a.id = ar.annotation_id"
                f" WHERE ar.plugin_id IN {_IMAGE_TAGGER_PLUGINS}"
                f"   AND ar.confidence >= ? AND i.custom_id IN ({ph})"
                f" ORDER BY ar.confidence DESC",
                [_TAG_MIN_CONFIDENCE, *chunk])
            for r in rows:
                tags, aest = result[r["pid"]]
                if r["annotation"] == "image_aesthetics":
                    aest = round(r["confidence"], 3)
                elif r["annotation"] not in tags:
                    tags.append(r["annotation"])
                result[r["pid"]] = (tags, aest)
        return result

    # ── photos ───────────────────────────────────────────────────────────────
    _PHOTO_SELECT = (
        "SELECT p.Id, p.Filename, p.FileUri, p.Stars, p.collectionId,"
        " m.Width, m.Height, m.CreationDate"
        " FROM photo_info p LEFT JOIN metadata m ON m.photoInfoId = p.Id")

    _SORT_SQL = {
        "date":  "m.CreationDate IS NULL, m.CreationDate {d}, p.Id {d}",
        "name":  "p.Filename COLLATE NOCASE {d}, p.Id {d}",
        "stars": "p.Stars {d}, p.Id {d}",
        "id":    "p.Id {d}",
    }

    def _row_to_item(self, row, fmap: dict, tags_map: dict) -> dict:
        """轉為與 Eagle urls_data.json item 相容的 schema。"""
        pid = row["Id"]
        filename = row["Filename"] or ""
        ext = Path(filename).suffix.lower()
        media_type = "video" if ext in VIDEO_EXTS else "image"
        folder = fmap.get(row["collectionId"])
        tags, aesthetics = tags_map.get(pid, ([], None))
        w, h = row["Width"], row["Height"]
        return {
            "id":         f"excire_{pid}",
            "photo_id":   pid,
            "name":       Path(filename).stem or filename,
            "url":        "",
            "domain":     "local",
            "kind":       "video" if media_type == "video" else "other",
            "tags":       tags,
            "folders":    [folder["rel"]] if folder else [],
            "thumb":      f"excire-thumb/{self.name}/{pid}",
            "preview":    f"excire-preview/{self.name}/{pid}",
            "file":       f"excire-file/{self.name}/{pid}",
            "media_type": media_type,
            "width":      w if isinstance(w, int) and w > 0 else None,
            "height":     h if isinstance(h, int) and h > 0 else None,
            "mtime":      _iso_to_ms(row["CreationDate"]),
            "size":       None,
            "star":       row["Stars"] or 0,
            "annotation": "",
            "ext":        ext.lstrip("."),
            "aesthetics": aesthetics,
            "source":     "excire",
        }

    def list_photos(self, offset: int = 0, limit: int = 100, folder=None,
                    keyword: str | None = None, collection=None,
                    sort: str = "date", order: str = "desc") -> dict:
        """分頁列出照片。folder=collectionId（含子資料夾）、keyword=AI 標籤、
        collection=相簿 Id。sort ∈ {date,name,stars,id,aesthetics}。"""
        if not self.available:
            return {"available": False, "total": 0, "offset": offset,
                    "limit": limit, "items": []}
        offset = max(0, int(offset))
        limit = min(max(1, int(limit)), 500)
        fmap = self._folder_map()

        where, params = [], []
        # A1 檔案層垃圾桶：journal 內（已搬入 .viewer-trash）的照片自查詢結果排除
        # （DB 紀錄不動、縮圖不受影響；還原後自動恢復可見）
        from trashlib import trashed_photo_ids
        trashed = trashed_photo_ids(self.name)
        if trashed:
            where.append(
                f"p.Id NOT IN ({','.join(str(int(x)) for x in sorted(trashed))})")
        if folder is not None:
            cids = self._folder_descendants(int(folder))
            if not cids:
                return {"available": True, "total": 0, "offset": offset,
                        "limit": limit, "items": []}
            where.append(f"p.collectionId IN ({','.join('?' * len(cids))})")
            params += cids
        wsql = (" WHERE " + " AND ".join(where)) if where else ""

        id_filter = None
        if keyword:
            id_filter = self._keyword_photo_ids(keyword)
        if collection is not None:
            cset = self._collection_photo_ids(int(collection))
            id_filter = cset if id_filter is None else (id_filter & cset)

        d = "ASC" if str(order).lower() == "asc" else "DESC"
        order_sql = self._SORT_SQL.get(sort, self._SORT_SQL["date"]).format(d=d)

        if id_filter is None and sort != "aesthetics":
            total = self._q_local(
                f"SELECT COUNT(*) AS n FROM photo_info p{wsql}", params)[0]["n"]
            rows = self._q_local(
                f"{self._PHOTO_SELECT}{wsql} ORDER BY {order_sql} LIMIT ? OFFSET ?",
                [*params, limit, offset])
        else:
            rows = self._q_local(
                f"{self._PHOTO_SELECT}{wsql} ORDER BY {order_sql}", params)
            if id_filter is not None:
                rows = [r for r in rows if r["Id"] in id_filter]
            if sort == "aesthetics":
                amap = self._aesthetics_map()
                rows.sort(key=lambda r: amap.get(r["Id"], -1.0),
                          reverse=(d == "DESC"))
            total = len(rows)
            rows = rows[offset:offset + limit]

        tags_map = self._tags_for([r["Id"] for r in rows])
        return {
            "available": True, "total": total, "offset": offset, "limit": limit,
            "items": [self._row_to_item(r, fmap, tags_map) for r in rows],
        }

    # ── faces ────────────────────────────────────────────────────────────────
    def faces(self, photo_id: int) -> list:
        """單張照片的人臉框（plugin_id=17 FaceSegmenter）。未分析 → []。"""
        rows = self._q_backend(
            "SELECT rr.region_id, r.region_data,"
            " (d.image_id IS NOT NULL) AS has_embedding"
            " FROM region_relations rr"
            " JOIN images i ON i.id = rr.image_id"
            " JOIN regions r ON r.id = rr.region_id"
            " LEFT JOIN SimilarFaceExtractor_descriptors d"
            "   ON d.image_id = rr.image_id AND d.region_id = rr.region_id"
            " WHERE rr.plugin_id = ? AND i.custom_id = ?",
            (_FACE_SEGMENTER_PLUGIN, int(photo_id)))
        out = []
        for r in rows:
            box = _parse_face_region(r["region_data"] or "")
            if box is None:
                continue
            box["region_id"] = r["region_id"]
            box["has_embedding"] = bool(r["has_embedding"])
            out.append(box)
        return out

    # ── file paths（縮圖 md5 規則 / 原圖）───────────────────────────────────
    def _photo_row(self, photo_id: int):
        rows = self._q_local(
            "SELECT Id, Filename, FileUri, collectionId FROM photo_info WHERE Id = ?",
            (int(photo_id),))
        return rows[0] if rows else None

    def _hashed_path(self, base_dir: Path, photo_id: int):
        row = self._photo_row(photo_id)
        if row is None:
            return None
        folder = self._folder_map().get(row["collectionId"])
        if folder is None:
            return None
        return base_dir / folder["dirhash"] / f"{_md5(row['Filename'])}.jpg"

    def thumb_path(self, photo_id: int):
        """480px 縮圖：thumbnails.exfoto/{md5(folderWinPath)}/{md5(Filename)}.jpg"""
        return self._hashed_path(self.thumb_dir, photo_id)

    def preview_path(self, photo_id: int):
        """1280px 預覽：previews.exfoto 同 hash 規則。"""
        return self._hashed_path(self.preview_dir, photo_id)

    def original_path(self, photo_id: int):
        """原圖實體路徑（FileUri → WSL /mnt/...）。"""
        row = self._photo_row(photo_id)
        if row is None:
            return None
        return Path(_uri_to_posix(row["FileUri"]))

    # ── stats ────────────────────────────────────────────────────────────────
    def stats(self) -> dict:
        if not self.available:
            return {"photos": 0, "folders": 0, "collections": 0, "analyzed": 0}
        n = lambda sql: (self._q_local(sql) or [{"n": 0}])[0]["n"]
        analyzed = 0
        rows = self._q_backend("SELECT COUNT(*) AS n FROM images WHERE analysis_status = 1")
        if rows:
            analyzed = rows[0]["n"]
        return {
            "photos":      n("SELECT COUNT(*) AS n FROM photo_info"),
            "folders":     n("SELECT COUNT(*) AS n FROM registered_collection"),
            "collections": n("SELECT COUNT(*) AS n FROM custom_collection"),
            "analyzed":    analyzed,
        }


# ---------------------------------------------------------------------------
# Library registry（連線快取，thread-safe）
# ---------------------------------------------------------------------------

_libraries: dict = {}
_registry_lock = threading.Lock()


def get_excire_library(name: str):
    """依 EXCIRE_PATHS 取得（快取的）ExcireLibrary；未設定 → None。"""
    root = EXCIRE_PATHS.get(name)
    if root is None:
        return None
    with _registry_lock:
        lib = _libraries.get(name)
        if lib is None or lib.root != Path(root):
            lib = ExcireLibrary(name, Path(root))
            _libraries[name] = lib
        return lib


def list_excire_libraries() -> list:
    """庫清單 + 可用性 + 統計（DB 缺失時 available=False 優雅降級）。"""
    out = []
    for name in sorted(EXCIRE_PATHS):
        lib = get_excire_library(name)
        out.append({
            "name":         name,
            "label":        name,
            "path":         str(lib.root),
            "source":       "excire",
            "available":    lib.available,
            "ai_available": lib.ai_available,
            "stats":        lib.stats(),
        })
    return out
