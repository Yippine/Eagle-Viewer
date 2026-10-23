"""Tier-1 延伸辨識（B5）：入鏡人數 / 場景地點 / 運動類 → scene_tags.json。

三個維度、低成本策略（audit「第一波＋第二波」路線）：
    人數  faces_meta.json 現成臉數聚合——photo = 臉數；video = 各抽樣幀
          （frame_ts 分組）中的最大臉數。背影/無臉者不計（已知限制）。
    場景  Excire backend.db 既有關鍵字優先（唯讀 mode=ro，經 excire.py 容錯
          層；confidence ≥ 0.5），詞表沒有的類別用 Chinese-CLIP zero-shot
          補（消費既有 clip_vectors.npy，免重新推論影像，全庫矩陣內積秒級）。
    運動  同場景策略（Excire basketball/soccer/badminton 直取；棒球/賽車/
          拳擊 CLIP zero-shot）。

Zero-shot 判定（寧缺勿濫）：每類多個中文 prompt 取 max 分；單維度取全類別
argmax，且分數 ≥ 門檻、與第二名差 ≥ margin 才打標。門檻以 Handsome 庫
Excire 既有標籤交叉校準（見 wave-3 報告）。

輸出 data/{lib}/ai_index/scene_tags.json（tmp + os.replace 原子寫）：
    {lib, built_at, model, thresholds, labels: {scene: [...], sport: [...]},
     items: {item_id: {people?: int, scene?: str, scene_src?: excire|clip,
                       scene_score?: float, sport?: str, ...}}}

紅線：Excire SQLite 一律唯讀；本模組只寫本專案自有 ai_index。
"""
import json
import os
from datetime import datetime, timezone

import numpy as np

from . import _VIEWER_DIR  # noqa: F401
from config import EXCIRE_PATHS, LIBRARY_PATHS
from .indexer import ai_index_dir, load_index

# ── 類別詞表（全繁體中文；excire = backend.db annotation 名映射）──────────
# Excire 450 詞固定詞彙表（TSJH 實查）沒有的類別 excire 留空 → 純 CLIP。
SCENE_LABELS = [
    ("捷運", {"excire": ["tram"],
              "prompts": ["捷運車廂內部", "地鐵車廂裡的乘客", "捷運站月台"]}),
    ("火車", {"excire": ["train", "railroad"],
              "prompts": ["火車車廂內部", "鐵軌上的火車", "火車站月台"]}),
    ("公車", {"excire": ["bus"],
              "prompts": ["公車車廂內部", "巴士上的乘客"]}),
    ("教室", {"excire": ["seminar_room"],
              "prompts": ["學校教室裡的課桌椅", "教室黑板前的學生"]}),
    ("場館", {"excire": ["stadium", "concert_hall"],
              "prompts": ["室內體育館", "大型體育場館的看台", "演唱會場館"]}),
    ("廁所", {"excire": [],
              "prompts": ["公共廁所的隔間和小便斗", "洗手間裡的馬桶"]}),
    ("浴室", {"excire": ["bathroom"],
              "prompts": ["浴室裡的淋浴間和洗手台"]}),
    ("走廊", {"excire": ["hallway"],
              "prompts": ["建築物室內的走廊"]}),
    ("客廳", {"excire": [],
              "prompts": ["家裡的客廳沙發和電視"]}),
    ("宿舍", {"excire": [],
              "prompts": ["學生宿舍房間的上下舖床位"]}),
    ("戶外", {"excire": [],
              "prompts": ["在戶外空地拍攝的照片", "室外的自然風景"]}),
]
SPORT_LABELS = [
    ("籃球", {"excire": ["basketball"],
              "prompts": ["打籃球的人", "籃球場上的比賽"]}),
    ("足球", {"excire": ["soccer"],
              "prompts": ["踢足球的人", "足球場上的比賽"]}),
    ("羽毛球", {"excire": ["badminton"],
                "prompts": ["打羽毛球的人", "羽毛球場上的比賽"]}),
    ("棒球", {"excire": [],
              "prompts": ["打棒球的人", "棒球場上的投手和打者"]}),
    ("賽車", {"excire": [],
              "prompts": ["賽車場跑道上的賽車比賽"]}),
    ("拳擊", {"excire": [],
              "prompts": ["拳擊擂台上的比賽", "戴著拳擊手套的拳擊手"]}),
]

# zero-shot 門檻（Chinese-CLIP ViT-B/16 cosine；以 Handsome Excire 標籤校準：
# sport thresh 0.42 → 已知類 precision ~98%；scene 全庫背景 p90=0.454 →
# 取 0.46 僅打 ~7% 高信心項；margin 0.02 抑制 argmax 邊界誤判。寧缺勿濫。）
CLIP_THRESH_SCENE = 0.46
CLIP_THRESH_SPORT = 0.42
CLIP_MARGIN       = 0.02     # 與同維度第二名的最小差距（argmax 保守化）


def scene_tags_file(lib: str):
    return ai_index_dir(lib) / "scene_tags.json"


def load_scene_tags(lib: str) -> dict:
    """讀取 scene_tags.json；不存在 / 壞檔 → {}。"""
    f = scene_tags_file(lib)
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


# ── 人數：faces_meta.json 聚合 ────────────────────────────────────────────

def _people_counts(lib: str) -> dict:
    """→ {item_id: 人數}；photo = 臉數，video = 各幀（frame_ts 分組）最大臉數。"""
    f = ai_index_dir(lib) / "faces_meta.json"
    if not f.exists():
        return {}
    try:
        meta = json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    per_frame: dict = {}                       # (id, frame_ts|None) → n
    for m in meta:
        key = (m["id"], m.get("frame_ts"))
        per_frame[key] = per_frame.get(key, 0) + 1
    out: dict = {}
    for (iid, _ts), n in per_frame.items():
        if n > out.get(iid, 0):
            out[iid] = n
    return out


# ── Excire 既有關鍵字 ────────────────────────────────────────────────────

def _excire_label_items(lib: str, label_defs: list) -> dict:
    """→ {item_id: 中文標籤}（依詞表順序 first-hit）；非 Excire 庫 / 不可用 → {}。"""
    if lib not in EXCIRE_PATHS:
        return {}
    try:
        from excire import get_excire_library
        exlib = get_excire_library(lib)
    except Exception:
        return {}
    if exlib is None or not exlib.ai_available:
        return {}
    out: dict = {}
    for zh, spec in label_defs:               # 詞表序 = 優先序；先到先得
        for kw in spec["excire"]:
            try:
                pids = exlib._keyword_photo_ids(kw)
            except Exception:
                continue
            for pid in pids:
                out.setdefault(f"excire_{pid}", zh)
    return out


# ── CLIP zero-shot ───────────────────────────────────────────────────────

def _encode_label_texts(label_defs: list) -> np.ndarray:
    """→ float32 (n_labels, 512)：每類多 prompt 編碼後取平均再 L2-normalize。"""
    from .clip_engine import get_engine
    eng = get_engine()
    rows = []
    for _zh, spec in label_defs:
        t = eng.encode_texts(spec["prompts"])            # (k, 512) L2-normalized
        v = t.mean(axis=0)
        v /= max(float(np.linalg.norm(v)), 1e-12)
        rows.append(v)
    return np.stack(rows).astype(np.float32)


def _clip_zero_shot(vecs: np.ndarray, ids: list, label_defs: list,
                    thresh: float, skip_ids: set) -> dict:
    """全庫矩陣內積 argmax + 門檻 + margin → {item_id: (中文標籤, score)}。"""
    tmat = _encode_label_texts(label_defs)               # (L, 512)
    scores = np.asarray(vecs, dtype=np.float32) @ tmat.T  # (N, L)
    top = scores.argmax(axis=1)
    out: dict = {}
    labels = [zh for zh, _ in label_defs]
    for i, iid in enumerate(ids):
        if iid in skip_ids:
            continue
        s = float(scores[i, top[i]])
        if s < thresh:
            continue
        if len(labels) > 1:
            row = scores[i].copy()
            row[top[i]] = -1.0
            if s - float(row.max()) < CLIP_MARGIN:
                continue                                  # 與次名太接近 → 不判定
        out[iid] = (labels[top[i]], round(s, 4))
    return out


# ── 主流程 ───────────────────────────────────────────────────────────────

def build_scene_tags(lib: str, progress_cb=None) -> dict:
    """建立 lib 的人數/場景/運動標籤索引 → scene_tags.json。

    CLIP 向量索引缺失 → 僅寫人數 + Excire 部分（clip: false 註記）；
    Excire 鎖定中 → 該部分空集合（不寫壞資料，重跑即補）。
    """
    if lib not in LIBRARY_PATHS and lib not in EXCIRE_PATHS:
        known = sorted(LIBRARY_PATHS) + sorted(EXCIRE_PATHS)
        raise RuntimeError(f"未知的庫：{lib}\n可用：{known}")
    d = ai_index_dir(lib)

    people = _people_counts(lib)
    if progress_cb:
        progress_cb(1, 4)
    ex_scene = _excire_label_items(lib, SCENE_LABELS)
    ex_sport = _excire_label_items(lib, SPORT_LABELS)
    if progress_cb:
        progress_cb(2, 4)

    clip_ok = False
    clip_scene: dict = {}
    clip_sport: dict = {}
    vecs, ids = load_index(lib)
    if vecs is not None and len(ids):
        clip_scene = _clip_zero_shot(vecs, ids, SCENE_LABELS,
                                     CLIP_THRESH_SCENE, set(ex_scene))
        if progress_cb:
            progress_cb(3, 4)
        clip_sport = _clip_zero_shot(vecs, ids, SPORT_LABELS,
                                     CLIP_THRESH_SPORT, set(ex_sport))
        clip_ok = True

    items: dict = {}

    def _entry(iid):
        return items.setdefault(iid, {})

    for iid, n in people.items():
        if n > 0:
            _entry(iid)["people"] = n
    for iid, zh in ex_scene.items():
        e = _entry(iid)
        e["scene"], e["scene_src"] = zh, "excire"
    for iid, (zh, s) in clip_scene.items():
        e = _entry(iid)
        e["scene"], e["scene_src"], e["scene_score"] = zh, "clip", s
    for iid, zh in ex_sport.items():
        e = _entry(iid)
        e["sport"], e["sport_src"] = zh, "excire"
    for iid, (zh, s) in clip_sport.items():
        e = _entry(iid)
        e["sport"], e["sport_src"], e["sport_score"] = zh, "clip", s

    out = {
        "lib": lib,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "clip": clip_ok,
        "thresholds": {"scene": CLIP_THRESH_SCENE, "sport": CLIP_THRESH_SPORT,
                       "margin": CLIP_MARGIN},
        "labels": {"scene": [zh for zh, _ in SCENE_LABELS],
                   "sport": [zh for zh, _ in SPORT_LABELS]},
        "items": items,
    }
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "scene_tags.json.tmp"
    tmp.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, scene_tags_file(lib))
    if progress_cb:
        progress_cb(4, 4)

    return {"lib": lib, "items_tagged": len(items),
            "people_items": len(people),
            "scene_excire": len(ex_scene), "scene_clip": len(clip_scene),
            "sport_excire": len(ex_sport), "sport_clip": len(clip_sport),
            "clip": clip_ok}
