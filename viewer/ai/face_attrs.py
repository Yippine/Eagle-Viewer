"""人物性別/年齡屬性（B2）：Excire backend.db FaceTagger → person_attrs.json 快取。

資料源唯讀：backend.db 一律經 excire.py 的 mode=ro 連線（本模組不自行開 DB，
沿用其鎖定負快取 / DrvFS 重試容錯）；絕不寫入任何 Excire SQLite。

歸因規則（免 bbox 匹配）：只取「單臉照片」（FaceSegmenter plugin 17 恰 1 個臉
region）的臉層級 FaceTagger（plugin 9）標籤——單臉照的性別/年齡必屬照片中唯一
人物；多臉照片歸因不明確，一律不計。每個人物簇再以其 items 中單臉照的標籤
多數決聚合（平票 → 不判定）。

快取：data/{lib}/ai_index/person_attrs.json（tmp + os.replace 原子寫），以
persons.json 的 clustered_at 判斷新鮮度；重聚類後首次讀取自動重建。
Eagle 庫（無 Excire 資料）與 backend.db 不可用（Excire Foto 鎖定中）→ 空 attrs
優雅降級（沿用過期舊快取或 {}，前端顯示「未知」）。
"""
import json
import os
from datetime import datetime, timezone

from . import _VIEWER_DIR  # noqa: F401
from config import EXCIRE_PATHS
from .face_indexer import ai_index_dir

GENDER_TAGS = ("male", "female")
AGE_TAGS    = ("baby", "child", "teenager", "adult", "elderly")

_FACE_SEGMENTER_PLUGIN = 17
_FACE_TAGGER_PLUGIN    = 9


def _attrs_file(lib: str):
    return ai_index_dir(lib) / "person_attrs.json"


def _solo_face_tags(lib: str):
    """→ {photo_id: {"gender": str?, "age": str?}}（僅單臉照片）；庫不可用 → None。

    Excire 每個臉 region 至多各掛一個性別 / 一個年齡標籤（已實查驗證），
    故不需依 confidence 挑選。
    """
    try:
        from excire import get_excire_library
        exlib = get_excire_library(lib)
    except Exception:
        return None
    if exlib is None or not exlib.ai_available:
        return None
    counts = exlib._q_backend(
        "SELECT image_id, COUNT(DISTINCT region_id) AS n FROM region_relations"
        " WHERE plugin_id = ? GROUP BY image_id", (_FACE_SEGMENTER_PLUGIN,))
    if not counts:                       # 查詢失敗 / 鎖定 → 降級（不寫壞快取）
        return None
    solo_images = {r["image_id"] for r in counts if r["n"] == 1}
    rows = exlib._q_backend(
        "SELECT ar.image_id, i.custom_id AS pid, a.annotation"
        " FROM annotation_relations ar"
        " JOIN images i ON i.id = ar.image_id"
        " JOIN annotations a ON a.id = ar.annotation_id"
        " JOIN region_relations rr ON rr.image_id = ar.image_id"
        "   AND rr.region_id = ar.region_id AND rr.plugin_id = ?"
        " WHERE ar.plugin_id = ? AND i.custom_id IS NOT NULL",
        (_FACE_SEGMENTER_PLUGIN, _FACE_TAGGER_PLUGIN))
    if not rows:
        return None
    out = {}
    for r in rows:
        if r["image_id"] not in solo_images:
            continue
        entry = out.setdefault(r["pid"], {})
        tag = r["annotation"]
        if tag in GENDER_TAGS:
            entry["gender"] = tag
        elif tag in AGE_TAGS:
            entry["age"] = tag
    return out


def _majority(votes: dict):
    """多數決：最高票唯一才判定；平票 → None（避免混簇誤標）。"""
    if not votes:
        return None
    top = max(votes.values())
    winners = [k for k, v in votes.items() if v == top]
    return winners[0] if len(winners) == 1 else None


def build_person_attrs(lib: str, persons_data: dict):
    """由 backend.db（唯讀）聚合每人物的性別/年齡 → attrs dict；資料不可用 → None。"""
    tags = _solo_face_tags(lib)
    if tags is None:
        return None
    persons = {}
    for p in persons_data.get("persons", []):
        gv, av = {}, {}
        for iid in p.get("items", []):
            try:
                pid = int(str(iid).replace("excire_", ""))
            except ValueError:
                continue
            t = tags.get(pid)
            if not t:
                continue
            g, a = t.get("gender"), t.get("age")
            if g:
                gv[g] = gv.get(g, 0) + 1
            if a:
                av[a] = av.get(a, 0) + 1
        entry = {}
        gender, age = _majority(gv), _majority(av)
        if gender:
            entry["gender"] = gender
        if age:
            entry["age"] = age
        if gv:
            entry["gender_votes"] = gv
        if av:
            entry["age_votes"] = av
        if entry:
            persons[p["person_id"]] = entry
    return {
        "lib": lib,
        "source": "excire-facetagger(solo-face)",
        "clustered_at": persons_data.get("clustered_at"),
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "persons": persons,
    }


def get_person_attrs(lib: str, persons_data: dict) -> dict:
    """→ {person_id: {"gender": …, "age": …, *_votes}}；無資料 → {}。

    快取新鮮（clustered_at 相符）直接回；過期 / 缺失 → 重建並落盤；
    重建失敗（Excire 鎖定中）→ 沿用過期舊快取（總比沒有好）或 {}。
    Eagle 庫（非 EXCIRE_PATHS）恆回 {}（自建管線目前無性別/年齡資料）。
    """
    if lib not in EXCIRE_PATHS:
        return {}
    f = _attrs_file(lib)
    cached = None
    if f.exists():
        try:
            cached = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            cached = None
    if cached and cached.get("clustered_at") == persons_data.get("clustered_at"):
        return cached.get("persons", {})
    built = build_person_attrs(lib, persons_data)
    if built is None:
        return cached.get("persons", {}) if cached else {}
    tmp = f.with_name("person_attrs.json.tmp")
    tmp.write_text(json.dumps(built, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, f)
    return built["persons"]
