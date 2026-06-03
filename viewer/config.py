"""Shared configuration, constants, and mutable globals for Eagle Viewer."""
import json
import threading
from collections import defaultdict
from pathlib import Path

# ---------------------------------------------------------------------------
# Directory layout
# ---------------------------------------------------------------------------
SCRIPT_DIR  = Path(__file__).resolve().parent   # → viewer/
VIEWER_DIR  = SCRIPT_DIR
PROJECT_DIR = VIEWER_DIR.parent                  # → Eagle-Viewer/
DATA_DIR    = PROJECT_DIR / "data"
CONFIG_FILE = DATA_DIR / "config.json"

# ---------------------------------------------------------------------------
# Schema constants
# ---------------------------------------------------------------------------
MAX_HISTORY    = 2000
SCHEMA_VERSION = 4  # v4: +ext field migration（補齊舊 library 缺失的 ext 欄位）

# ---------------------------------------------------------------------------
# Mutable globals – import by reference so mutations are visible cross-module
# ---------------------------------------------------------------------------
LIBRARY_PATHS: dict = {}                         # lib folder name → full Path
FOLDER_PATHS: dict  = {}                         # folder source name → full Path (Excire-style)
_lib_locks: dict    = defaultdict(threading.Lock)
_extract_lock       = threading.Lock()


# ---------------------------------------------------------------------------
# Config loader / saver
# ---------------------------------------------------------------------------

def _win_to_posix(raw: str) -> str:
    """Convert a Windows path (C:\\...) to WSL2 /mnt/c/... if running on Linux."""
    import re as _re, sys as _sys
    if _sys.platform.startswith("win") or not _re.match(r'^[A-Za-z]:\\', raw):
        return raw
    drive = raw[0].lower()
    rest = raw[2:].replace("\\", "/")
    return f"/mnt/{drive}{rest}"


def _load_config() -> None:
    """Read data/config.json and populate LIBRARY_PATHS / FOLDER_PATHS in-place."""
    LIBRARY_PATHS.clear()
    FOLDER_PATHS.clear()
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            for lp in cfg.get("libraries", []):
                lp = _win_to_posix(lp.strip())
                if lp:
                    p = Path(lp)
                    if p.exists():
                        LIBRARY_PATHS[p.name] = p
            for fp in cfg.get("folder_libraries", []):
                fp = _win_to_posix(fp.strip())
                if fp:
                    p = Path(fp)
                    if p.exists():
                        # Use "ParentName_folderName" to avoid collisions (e.g. multiple "resource" dirs)
                        key = f"{p.parent.name}_{p.name}" if p.parent.name else p.name
                        FOLDER_PATHS[key] = p
        except Exception:
            pass


def _add_library_path(lib_path_str: str) -> dict:
    """Add library to config.json and LIBRARY_PATHS. Returns {ok, name} or {ok, error}."""
    p = Path(lib_path_str.strip())
    if not p.exists():
        return {"ok": False, "error": f"找不到路徑：{lib_path_str}"}
    if not p.is_dir():
        return {"ok": False, "error": "請選擇一個資料夾"}
    libs_list: list = []
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            libs_list = cfg.get("libraries", [])
        except Exception:
            pass
    lib_path_norm = str(p)
    if lib_path_norm not in libs_list:
        libs_list.append(lib_path_norm)
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    cfg_data = {}
    if CONFIG_FILE.exists():
        try:
            cfg_data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    cfg_data["libraries"] = libs_list
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg_data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CONFIG_FILE)
    LIBRARY_PATHS[p.name] = p
    return {"ok": True, "name": p.name}


def _add_folder_path(folder_path_str: str) -> dict:
    """Add folder source to config.json and FOLDER_PATHS. Returns {ok, name} or {ok, error}."""
    p = Path(folder_path_str.strip())
    if not p.exists():
        return {"ok": False, "error": f"找不到路徑：{folder_path_str}"}
    if not p.is_dir():
        return {"ok": False, "error": "請選擇一個資料夾"}
    cfg_data = {}
    if CONFIG_FILE.exists():
        try:
            cfg_data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    folders_list = cfg_data.get("folder_libraries", [])
    folder_norm = str(p)
    if folder_norm not in folders_list:
        folders_list.append(folder_norm)
    cfg_data["folder_libraries"] = folders_list
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg_data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CONFIG_FILE)
    key = f"{p.parent.name}_{p.name}" if p.parent.name else p.name
    FOLDER_PATHS[key] = p
    return {"ok": True, "name": key}
