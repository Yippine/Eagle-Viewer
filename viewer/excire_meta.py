"""Excire 單張照片詳情（B7：E04 per-tag confidence + E07 EXIF）.

獨立模組承載新增邏輯（excire.py 既有 510 行超標不再加重，比照 B6
api_ai_similar.py 先例）。僅唯讀查詢，消費 ExcireLibrary 的
_q_local/_q_backend 介面；backend.db 缺失（TSJH）→ tags 空清單容忍。
"""
from excire import _IMAGE_TAGGER_PLUGINS, _TAG_MIN_CONFIDENCE

# metadata 表中回傳給前端的 EXIF 欄位（空值過濾後輸出）
_EXIF_KEYS = (
    "Camera", "Lens", "ExposureTime", "FocalLengthMM", "FocalLength35MM",
    "Iso", "FNumber", "FlashFired", "Latitude", "Longitude", "Altitude",
    "CreationDate",
)


def photo_meta(lib, photo_id: int) -> dict:
    """→ {tags: [{keyword, confidence}], exif: {欄位: 值}}"""
    tags = [{"keyword": r["annotation"], "confidence": round(r["c"], 3)}
            for r in lib._q_backend(
                "SELECT a.annotation, MAX(ar.confidence) AS c"
                " FROM annotation_relations ar"
                " JOIN images i ON i.id = ar.image_id"
                " JOIN annotations a ON a.id = ar.annotation_id"
                f" WHERE ar.plugin_id IN {_IMAGE_TAGGER_PLUGINS}"
                "   AND ar.confidence >= ? AND i.custom_id = ?"
                "   AND a.annotation != 'image_aesthetics'"
                " GROUP BY a.annotation ORDER BY c DESC",
                (_TAG_MIN_CONFIDENCE, int(photo_id)))]
    rows = lib._q_local(
        "SELECT * FROM metadata WHERE photoInfoId = ?", (int(photo_id),))
    exif = {}
    if rows:
        r = rows[0]
        for k in _EXIF_KEYS:
            v = r[k] if k in r.keys() else None
            if v not in (None, ""):
                exif[k] = v
    return {"tags": tags, "exif": exif}
