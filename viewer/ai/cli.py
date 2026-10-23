"""CLI 入口——於專案根目錄執行：

    python3 -m viewer.ai.cli setup                                   # 下載/驗證模型
    python3 -m viewer.ai.cli libs                                    # 列出可索引/已索引庫
    python3 -m viewer.ai.cli index  --lib "1 - Handsome.library" [--limit 200]
    python3 -m viewer.ai.cli search --lib "1 - Handsome.library" --query "海邊 日落" [--topk 5]
    python3 -m viewer.ai.cli search --all --query "動漫 角色"

（viewer/ 為 namespace package；viewer/ai/__init__.py 已將 viewer/ 打平進
  sys.path，故 config/excire 平面 import 於此照常成立。）
"""
import argparse
import json
import sys
import time

from . import _VIEWER_DIR  # noqa: F401
import config as _cfg
from config import EXCIRE_PATHS, LIBRARY_PATHS


def _cmd_setup(_args) -> int:
    from .model_setup import ensure_model, model_info
    ensure_model(verbose=True)
    print(json.dumps(model_info(), ensure_ascii=False, indent=2))
    return 0


def _cmd_libs(_args) -> int:
    from .indexer import ai_index_dir, load_index
    print("Eagle 庫：")
    for name in sorted(LIBRARY_PATHS):
        _, ids = load_index(name)
        mark = f"已索引 {len(ids)} 筆" if ids else "未索引"
        print(f"  {name}  [{mark}]")
    print("Excire 庫：")
    for name in sorted(EXCIRE_PATHS):
        _, ids = load_index(name)
        mark = f"已索引 {len(ids)} 筆" if ids else "未索引"
        print(f"  {name}  [{mark}]")
    return 0


def _cmd_index(args) -> int:
    from .indexer import build_index

    def _progress(done, total):
        pct = done * 100 // max(total, 1)
        print(f"  進度 {done}/{total}（{pct}%）", flush=True)

    print(f"開始索引：{args.lib}（limit={args.limit or '全量'}，batch={args.batch}）")
    result = build_index(args.lib, limit=args.limit, batch_size=args.batch,
                         flush_every=args.flush_every, throttle=args.throttle,
                         progress_cb=_progress)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def _cmd_search(args) -> int:
    from .search import resolve_items, search, search_all

    t0 = time.time()
    if args.all:
        hits = search_all(args.query, topk=args.topk)
    else:
        hits = [{**h, "lib": args.lib} for h in search(args.lib, args.query, topk=args.topk)]
    elapsed = time.time() - t0

    # id → 名稱/資料夾（人工可判讀）
    by_lib: dict = {}
    for h in hits:
        by_lib.setdefault(h["lib"], []).append(h["id"])
    info = {}
    for lib, ids in by_lib.items():
        for iid, meta in resolve_items(lib, ids).items():
            info[(lib, iid)] = meta

    print(f"查詢：「{args.query}」  top-{args.topk}  耗時 {elapsed:.2f}s")
    for rank, h in enumerate(hits, 1):
        meta = info.get((h["lib"], h["id"]), {})
        folders = "/".join(meta.get("folders", [])) or "-"
        name = meta.get("name", "?")
        print(f"  {rank}. [{h['score']:.4f}] {name}  (庫={h['lib']}, 資料夾={folders},"
              f" id={h['id']}, {meta.get('media_type', '?')})")
    return 0


def _cmd_face_index(args) -> int:
    from .face_indexer import build_face_index

    def _progress(done, total):
        pct = done * 100 // max(total, 1)
        print(f"  進度 {done}/{total}（{pct}%）", flush=True)

    print(f"開始人臉索引：{args.lib}（limit={args.limit or '全量'}）")
    result = build_face_index(args.lib, limit=args.limit,
                              flush_every=args.flush_every, throttle=args.throttle,
                              max_faces=args.max_faces, min_size=args.min_size,
                              progress_cb=_progress)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def _cmd_face_cluster(args) -> int:
    from .face_cluster import build_clusters

    t0 = time.time()
    result = build_clusters(args.lib, eps=args.eps, min_samples=args.min_samples)
    result["elapsed_s"] = round(time.time() - t0, 2)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def _cmd_face_search(args) -> int:
    from .face_search import SAME_PERSON_THRESH, search_by_item
    from .search import resolve_items

    t0 = time.time()
    result = search_by_item(args.lib, args.item, face_idx=args.face,
                            topk=args.topk, all_libs=args.all)
    elapsed = time.time() - t0

    hits = result["hits"]
    by_lib: dict = {}
    for h in hits:
        by_lib.setdefault(h["lib"], []).append(h["id"])
    info = {}
    for lib, ids in by_lib.items():
        for iid, meta in resolve_items(lib, ids).items():
            info[(lib, iid)] = meta

    q = result["query"]
    print(f"查詢臉：item={args.item} face_idx={q['face_idx']}"
          f"（det={q['det_score']:.3f}，該圖共 {q['n_faces_in_item']} 臉）"
          f"  top-{args.topk}  耗時 {elapsed:.2f}s")
    print(f"（cosine ≥ {SAME_PERSON_THRESH} 高機率同人）")
    for rank, h in enumerate(hits, 1):
        meta = info.get((h["lib"], h["id"]), {})
        folders = "/".join(meta.get("folders", [])) or "-"
        same = "同人?" if h["score"] >= SAME_PERSON_THRESH else "  -  "
        print(f"  {rank}. [{h['score']:.4f}] [{same}] {meta.get('name', '?')}"
              f"  (庫={h['lib']}, 資料夾={folders}, id={h['id']},"
              f" det={h['det_score']:.3f}, face_idx={h['face_idx']})")
    return 0


def main(argv=None) -> int:
    _cfg._load_config()

    ap = argparse.ArgumentParser(prog="viewer.ai.cli", description="Eagle Viewer 語意索引/查詢 CLI")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("setup", help="下載/驗證模型")
    sub.add_parser("libs", help="列出庫與索引狀態")

    p_idx = sub.add_parser("index", help="建立/增量更新語意索引")
    p_idx.add_argument("--lib", required=True, help="庫名（Eagle：目錄名；Excire：顯示名）")
    p_idx.add_argument("--limit", type=int, default=None, help="本次最多新索引 N 張")
    p_idx.add_argument("--batch", type=int, default=16, help="推論 batch size（預設 16）")
    p_idx.add_argument("--flush-every", type=int, default=256, help="每 N 張落盤（預設 256）")
    p_idx.add_argument("--throttle", type=float, default=0.0, help="每落盤批次間 sleep 秒數")

    p_s = sub.add_parser("search", help="語意查詢")
    g = p_s.add_mutually_exclusive_group(required=True)
    g.add_argument("--lib", help="單庫查詢")
    g.add_argument("--all", action="store_true", help="跨所有已索引庫")
    p_s.add_argument("--query", required=True, help="自然語言查詢（中/英）")
    p_s.add_argument("--topk", type=int, default=5)

    p_fi = sub.add_parser("face-index", help="建立/增量更新人臉索引（SCRFD+ArcFace）")
    p_fi.add_argument("--lib", required=True, help="庫名（Eagle：目錄名；Excire：顯示名）")
    p_fi.add_argument("--limit", type=int, default=None, help="本次最多新處理 N 個 item")
    p_fi.add_argument("--flush-every", type=int, default=64, help="每 N 個 item 落盤（預設 64）")
    p_fi.add_argument("--throttle", type=float, default=0.0, help="每落盤批次間 sleep 秒數")
    p_fi.add_argument("--max-faces", type=int, default=16, help="每張圖最多取臉數（預設 16）")
    p_fi.add_argument("--min-size", type=int, default=20, help="bbox 短邊下限 px（預設 20）")

    p_fc = sub.add_parser("face-cluster", help="人物聚類（DBSCAN，不重算 embedding）")
    p_fc.add_argument("--lib", required=True)
    p_fc.add_argument("--eps", type=float, default=0.45, help="cosine distance 半徑（預設 0.45）")
    p_fc.add_argument("--min-samples", type=int, default=2, help="成簇最少臉數（預設 2）")

    p_fs = sub.add_parser("face-search", help="以臉找臉（item 的臉 → top-k 相似臉）")
    p_fs.add_argument("--lib", required=True, help="查詢 item 所在庫")
    p_fs.add_argument("--item", required=True, help="查詢 item id")
    p_fs.add_argument("--face", type=int, default=None, help="指定 face_idx（預設取 det 最高臉）")
    p_fs.add_argument("--topk", type=int, default=5)
    p_fs.add_argument("--all", action="store_true", help="跨所有已建人臉索引的庫")

    args = ap.parse_args(argv)
    try:
        return {"setup": _cmd_setup, "libs": _cmd_libs,
                "index": _cmd_index, "search": _cmd_search,
                "face-index": _cmd_face_index, "face-cluster": _cmd_face_cluster,
                "face-search": _cmd_face_search}[args.cmd](args)
    except RuntimeError as e:
        print(f"[錯誤] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
