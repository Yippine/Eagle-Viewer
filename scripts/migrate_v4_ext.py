"""
migrate_v4_ext.py
──────────────────────
Schema v3 → v4 一次性遷移：對現有 urls_data.json 補 ext 欄位，
並將 .index_manifest.json schema_version 更新為 4，
使重啟時不再觸發全量重建。

用法：
    cd Eagle-Viewer
    python scripts/migrate_v4_ext.py
"""
import json
import sys
from pathlib import Path

TARGET_SCHEMA = 4
SCRIPT_DIR   = Path(__file__).resolve().parent
PROJECT_DIR  = SCRIPT_DIR.parent
DATA_DIR     = PROJECT_DIR / "data"
CONFIG_FILE  = DATA_DIR / "config.json"


def _win_to_wsl(path_str: str) -> Path:
    r"""將 Windows 路徑（C:\...）轉換為 WSL 路徑（/mnt/c/...）。"""
    p = path_str.strip().replace("\\", "/")
    if len(p) >= 2 and p[1] == ":":
        drive = p[0].lower()
        p = f"/mnt/{drive}/{p[3:]}"
    return Path(p)


def _load_config() -> dict[str, Path]:
    """讀 config.json，回傳 lib_name → library_path。"""
    if not CONFIG_FILE.exists():
        print("❌ 找不到 data/config.json，請確認專案設定。")
        sys.exit(1)
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    result = {}
    for lp in cfg.get("libraries", []):
        p = _win_to_wsl(lp)
        if not p.exists():
            p = Path(lp.strip())  # 原樣嘗試（非 WSL 環境）
        if p.exists():
            result[p.name] = p
        else:
            print(f"  ⚠️  路徑不存在，跳過：{lp}")
    return result


def migrate_library(lib_name: str, lib_path: Path) -> None:
    lib_data_dir  = DATA_DIR / lib_name
    json_file     = lib_data_dir / "urls_data.json"
    manifest_file = lib_data_dir / ".index_manifest.json"

    if not json_file.exists():
        print(f"  [{lib_name}] ⚠️  urls_data.json 不存在，跳過")
        return

    # ── 1. 讀現有資料 ──────────────────────────────────────────────
    data       = json.loads(json_file.read_text(encoding="utf-8"))
    items      = data.get("items", [])
    images_dir = lib_path / "images"

    patched = 0
    missing = 0
    for item in items:
        if "ext" in item:
            continue  # 已有欄位，跳過

        item_id   = item.get("id", "")
        meta_path = images_dir / f"{item_id}.info" / "metadata.json"
        ext       = ""
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                ext  = meta.get("ext", "") or ""
            except Exception:
                pass
        else:
            missing += 1

        item["ext"] = ext
        patched += 1

    # ── 2. 寫回（atomic tmp→replace，僅 patched > 0 時才需要）────────
    if patched > 0:
        tmp = json_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(json_file)

    # ── 3. 更新 manifest schema_version → 4（無論是否有 patch 皆執行）─
    if manifest_file.exists():
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            old_ver  = manifest.get("schema_version", "?")
            if old_ver == TARGET_SCHEMA and patched == 0:
                print(f"  [{lib_name}] ✅  已是 v{TARGET_SCHEMA}，無需遷移")
                return
            manifest["schema_version"] = TARGET_SCHEMA
            mtmp = manifest_file.with_suffix(".tmp")
            mtmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            mtmp.replace(manifest_file)
            note = f"（其中 {missing} 項找不到 metadata.json）" if missing else ""
            if patched > 0:
                print(f"  [{lib_name}] ✅  ext 補齊 {patched} 項{note}；manifest v{old_ver} → v{TARGET_SCHEMA}")
            else:
                print(f"  [{lib_name}] ✅  所有項目已有 ext；manifest v{old_ver} → v{TARGET_SCHEMA}")
        except Exception as e:
            print(f"  [{lib_name}] ⚠️  manifest 更新失敗：{e}（data 已 patch）")
    else:
        print(f"  [{lib_name}] ✅  ext 補齊 {patched} 項（manifest 不存在，將在下次重建時建立）")


def main() -> None:
    print(f"Eagle Viewer migrate v3 → v{TARGET_SCHEMA}: 補 ext 欄位\n")
    libs = _load_config()
    if not libs:
        print("❌ 未設定任何資源庫路徑。")
        sys.exit(1)
    for lib_name, lib_path in libs.items():
        migrate_library(lib_name, lib_path)
    print("\n完成。重啟 Eagle Viewer 後無需全量重建。")


if __name__ == "__main__":
    main()
