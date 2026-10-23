"""File upload helpers, user data, and URL import (wf-007/wf-008)."""
import json
import os
import random
import re
import shutil
import string
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

from config import DATA_DIR, LIBRARY_PATHS, _lib_locks
from api_helpers import _build_folder_map, _sse_broadcast

# ---------------------------------------------------------------------------
# Eagle ID generator
# ---------------------------------------------------------------------------

def _gen_eagle_id() -> str:
    ts   = int(time.time() * 1000)
    rand = "".join(random.choices(string.ascii_uppercase + string.digits, k=5))
    return f"{ts:013X}"[:8] + rand


# ---------------------------------------------------------------------------
# Multipart parser
# ---------------------------------------------------------------------------

def _parse_multipart(body: bytes, content_type: str) -> dict:
    """Parse multipart/form-data. Returns {field: (bytes, filename|None)}."""
    m = re.search(r'boundary=([^\s;]+)', content_type)
    if not m:
        return {}
    boundary = ("--" + m.group(1).strip('"')).encode("latin-1")
    parts: dict = {}
    segments = body.split(boundary)
    for seg in segments[1:]:
        if seg in (b"--\r\n", b"--"):
            break
        if seg.startswith(b"\r\n"):
            seg = seg[2:]
        if b"\r\n\r\n" not in seg:
            continue
        header_raw, data = seg.split(b"\r\n\r\n", 1)
        if data.endswith(b"\r\n"):
            data = data[:-2]
        header_str = header_raw.decode("utf-8", errors="replace")
        cd_match   = re.search(r'\bname="([^"]+)"', header_str)
        fn_match   = re.search(r'filename="([^"]*)"', header_str)
        if not cd_match:
            continue
        field_name = cd_match.group(1)
        filename   = fn_match.group(1) if fn_match else None
        parts[field_name] = (data, filename)
    return parts


# ---------------------------------------------------------------------------
# Eagle item creation (shared by wf-007 upload and wf-008 URL import)
# ---------------------------------------------------------------------------

_VIDEO_EXTS = {"mp4", "mov", "avi", "mkv", "webm", "m4v", "flv", "wmv", "ts", "3gp"}
_IMAGE_EXTS = {"jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "tiff", "svg", "avif"}


def _create_eagle_item_from_file(
    lib_name: str,
    folder_id: str,
    file_name: str,
    file_bytes: bytes,
    source_url: str = "",
    custom_name: str = "",
) -> dict:
    """Create an Eagle item from raw bytes. Returns {ok, id, name} or {ok, error}."""
    lib_path = LIBRARY_PATHS.get(lib_name)
    if not lib_path:
        return {"ok": False, "error": "Library not found"}

    safe_name = file_name.replace("/", "_").replace("\\", "_").strip()
    if "." in safe_name:
        name_no_ext, ext = safe_name.rsplit(".", 1)
        ext = ext.lower()
    else:
        name_no_ext, ext = safe_name, "bin"

    # 使用者自訂名稱優先
    if custom_name:
        name_no_ext = custom_name

    if ext in _VIDEO_EXTS:
        kind = "video"; media_type = "video"
    elif ext in _IMAGE_EXTS:
        kind = "image"; media_type = "image"
    else:
        kind = "other"; media_type = "other"

    item_id  = _gen_eagle_id()
    info_dir = lib_path / "images" / f"{item_id}.info"
    info_dir.mkdir(parents=True, exist_ok=True)
    file_dest = info_dir / f"{name_no_ext}.{ext}"
    file_dest.write_bytes(file_bytes)

    now_ms      = int(time.time() * 1000)
    folder_tags = _build_folder_map(lib_name).get(folder_id, []) if folder_id else []
    meta = {
        "id": item_id, "name": name_no_ext,
        "size": len(file_bytes), "btime": now_ms, "mtime": now_ms,
        "ext": ext, "tags": folder_tags,
        "folders": [folder_id] if folder_id else [],
        "isDeleted": False, "url": source_url, "annotation": "",
        "modificationTime": now_ms, "height": 0, "width": 0,
        "lastModified": now_ms, "star": 0, "palettes": [],
    }
    (info_dir / "metadata.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), "utf-8"
    )

    # Eagle App 以 library 根 mtime.json（{item_id: ms}）做增量掃描，需同步登錄新 item
    with _lib_locks[lib_name]:
        mtime_path = lib_path / "mtime.json"
        try:
            mt = json.loads(mtime_path.read_text("utf-8")) if mtime_path.exists() else {}
        except Exception:
            mt = {}
        mt[item_id] = now_ms
        tmp = mtime_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(mt, ensure_ascii=False), "utf-8")
        tmp.replace(mtime_path)

    file_rel  = f"images/{lib_name}/{item_id}.info/{name_no_ext}.{ext}"
    thumb_rel = file_rel if media_type == "image" else ""
    cache_item = {
        "id": item_id, "name": name_no_ext, "url": source_url, "domain": "local",
        "kind": kind, "tags": folder_tags, "thumb": thumb_rel, "file": file_rel,
        "width": 0, "height": 0, "media_type": media_type, "mtime": now_ms // 1000,
    }
    cache_path = DATA_DIR / lib_name / "urls_data.json"
    if cache_path.exists():
        with _lib_locks[lib_name]:
            try:
                data = json.loads(cache_path.read_text("utf-8"))
                data.setdefault("items", []).insert(0, cache_item)
                if "stats" in data:
                    data["stats"]["total"] = len(data["items"])
                tmp = cache_path.with_suffix(".tmp")
                tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
                tmp.replace(cache_path)
            except Exception:
                pass

    return {"ok": True, "id": item_id, "name": name_no_ext}


# ---------------------------------------------------------------------------
# User data (filter preset sync)
# ---------------------------------------------------------------------------

_USER_DATA_PATH  = DATA_DIR / "user_data.json"
_EMPTY_USER_DATA = {"version": 0, "filterPresets": [], "transformSnapshots": {}, "videoFilterLinks": {}}


def _load_user_data() -> dict:
    try:
        if _USER_DATA_PATH.exists():
            with open(_USER_DATA_PATH, encoding="utf-8") as f:
                data = json.load(f)
                if "presets" in data and "filterPresets" not in data:
                    data["filterPresets"] = [
                        {k: v for k, v in p.items() if k != "tx"}
                        for p in data.pop("presets", [])
                    ]
                if "videoPresets" in data and "transformSnapshots" not in data:
                    snaps = {}
                    for vid_id, vd in data.pop("videoPresets", {}).items():
                        snaps[vid_id] = {"tx": vd.get("tx", {}), "savedAt": vd.get("modifiedAt", 0)}
                    data["transformSnapshots"] = snaps
                return data
    except Exception:
        pass
    return dict(_EMPTY_USER_DATA)


def _save_user_data(obj: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    tmp = _USER_DATA_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    tmp.replace(_USER_DATA_PATH)


_BACKUP_DIR   = DATA_DIR / "backups"
_BACKUP_RE    = re.compile(r"^user_data\.backup-\d{8}-\d{6}\.json$")


def _backup_name(ts: float | None = None) -> str:
    return time.strftime("user_data.backup-%Y%m%d-%H%M%S.json", time.localtime(ts))


def _make_backup() -> str:
    """複製目前 user_data.json → backups/user_data.backup-YYYYMMDD-HHMMSS.json，回傳檔名。"""
    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    name = _backup_name()
    dst = _BACKUP_DIR / name
    if _USER_DATA_PATH.exists():
        shutil.copy2(_USER_DATA_PATH, dst)
    else:
        dst.write_text(json.dumps(_EMPTY_USER_DATA, ensure_ascii=False, indent=2), "utf-8")
    return name


def _list_backups() -> list:
    if not _BACKUP_DIR.exists():
        return []
    out = []
    for p in _BACKUP_DIR.iterdir():
        if not p.is_file() or not _BACKUP_RE.match(p.name):
            continue
        try:
            st = p.stat()
            out.append({"name": p.name, "size": st.st_size, "ts": int(st.st_mtime * 1000)})
        except OSError:
            continue
    out.sort(key=lambda x: x["ts"], reverse=True)
    return out


def _restore_backup(name: str) -> dict:
    """驗證 name（basename、符合命名規則）→ 先備份目前檔 → 覆蓋 user_data.json → 回傳新 data。"""
    safe = Path(name).name
    if not _BACKUP_RE.match(safe):
        raise ValueError("invalid backup name")
    src = _BACKUP_DIR / safe
    if not src.exists():
        raise FileNotFoundError("backup not found")
    _make_backup()
    with open(src, encoding="utf-8") as f:
        data = json.load(f)
    _save_user_data(data)
    return data


def _merge_user_data(server: dict, client: dict) -> dict:
    s_fp = {p["id"]: p for p in server.get("filterPresets", []) if "id" in p}
    for cp in client.get("filterPresets", []):
        cid = cp.get("id")
        if not cid:
            continue
        if cid not in s_fp or cp.get("modifiedAt", 0) > s_fp[cid].get("modifiedAt", 0):
            s_fp[cid] = cp
    s_ts = dict(server.get("transformSnapshots", {}))
    for vid_id, snap in client.get("transformSnapshots", {}).items():
        if vid_id not in s_ts or snap.get("savedAt", 0) > s_ts[vid_id].get("savedAt", 0):
            s_ts[vid_id] = snap
    # per-video 濾鏡連結（eagle-media-filter-*）：LWW by savedAt，跨裝置共用
    s_vfl = dict(server.get("videoFilterLinks", {}))
    for vid_id, vfl in client.get("videoFilterLinks", {}).items():
        if not isinstance(vfl, dict):
            continue
        if vid_id not in s_vfl or vfl.get("savedAt", 0) >= s_vfl[vid_id].get("savedAt", 0):
            s_vfl[vid_id] = vfl
    return {
        "version":            int(time.time() * 1000),
        "filterPresets":      list(s_fp.values()),
        "transformSnapshots": s_ts,
        "videoFilterLinks":   s_vfl,
    }


# ---------------------------------------------------------------------------
# wf-008: URL Import  (async background download + 5 engines)
#   cobalt / Evil0ctal / XHS-Downloader / yt-dlp / gallery-dl
# ---------------------------------------------------------------------------

_import_tasks: dict    = {}
_import_lock = threading.Lock()

# Engine base URLs – override via env vars
_COBALT_API      = os.environ.get("COBALT_API",      "http://localhost:9001")
_EVIL_OCTAL_API  = os.environ.get("EVIL_OCTAL_API",  "http://localhost:9003")
_XHS_API         = os.environ.get("XHS_DOWNLOADER_API", "http://localhost:5555")

# ── Cookie 機制（C1）：config/cookies/{platform}.txt（Netscape 格式）────────
# 取得方式見 config/cookies/README.md（瀏覽器擴充「Get cookies.txt LOCALLY」匯出）
_COOKIES_DIR = Path(__file__).resolve().parent.parent / "config" / "cookies"
# 登入牆平台：受限內容（NSFW / 私密 / 反爬）需要 cookie 才能下載
_COOKIE_PLATFORMS = {"x", "instagram", "facebook"}


def _cookie_file(platform: str) -> Path | None:
    """Return config/cookies/{platform}.txt if present and non-empty, else None."""
    p = _COOKIES_DIR / f"{platform}.txt"
    try:
        if p.is_file() and p.stat().st_size > 0:
            return p
    except OSError:
        pass
    return None


def _netscape_cookie_header(path: Path, domains: tuple[str, ...] | None = None) -> str:
    """Netscape cookies.txt → 'k=v; k2=v2' HTTP Cookie header string.

    domains 提供時，僅保留第 1 欄 domain 尾綴匹配者（全瀏覽器混雜匯出檔含他站 cookie）；
    name/value 含非 ascii 字元一律跳過（容器內 httpx 以 ascii 組 header，中文值會拋 UnicodeEncodeError）。
    """
    pairs = []
    for line in path.read_text("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or (line.startswith("#") and not line.startswith("#HttpOnly_")):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        cookie_domain = parts[0].removeprefix("#HttpOnly_").lstrip(".")
        if domains and not _host_match(cookie_domain, *domains):
            continue
        name, value = parts[5], parts[6]
        if not name.isascii() or not value.isascii():
            continue
        pairs.append(f"{name}={value}")
    return "; ".join(pairs)


def _cookie_hint(platform: str) -> str:
    """優雅降級訊息：告知使用者放置 cookie 檔的位置。"""
    return (
        f"此平台受限內容需登入 cookie，請放置 config/cookies/{platform}.txt"
        f"（Netscape 格式，匯出方式見 config/cookies/README.md）後重試"
    )


def _host_of(url_or_text: str) -> str:
    """Extract hostname from a URL（或含 URL 的分享文字）."""
    m = re.search(r'https?://[^\s]+', url_or_text)
    target = m.group(0) if m else url_or_text
    try:
        return (urlparse(target).netloc or "").lower().split("@")[-1].split(":")[0]
    except Exception:
        return ""


def _host_match(host: str, *domains: str) -> bool:
    return any(host == d or host.endswith("." + d) for d in domains)


def _classify_platform(url: str) -> str:
    """Return platform key based on URL hostname（支援分享文字內嵌 URL）.

    keys: douyin | tiktok | xhs | x | instagram | facebook | youtube |
          threads | linevoom | tumblr | generic
    """
    host = _host_of(url)
    if _host_match(host, "douyin.com", "iesdouyin.com"):
        return "douyin"
    if _host_match(host, "tiktok.com", "tiktokv.com"):
        return "tiktok"
    if _host_match(host, "xiaohongshu.com", "xhslink.com"):
        return "xhs"
    if _host_match(host, "x.com", "twitter.com", "fxtwitter.com", "t.co"):
        return "x"
    if _host_match(host, "instagram.com", "instagr.am", "ddinstagram.com"):
        return "instagram"
    if _host_match(host, "facebook.com", "fb.com", "fb.watch", "m.facebook.com"):
        return "facebook"
    if _host_match(host, "youtube.com", "youtu.be"):
        return "youtube"
    if _host_match(host, "threads.net", "threads.com"):
        return "threads"
    if _host_match(host, "linevoom.line.me"):
        return "linevoom"
    if _host_match(host, "tumblr.com"):
        return "tumblr"
    return "generic"


def _extract_url_from_text(text: str, domain_hint: str) -> str:
    """Extract first https URL containing domain_hint from share text."""
    m = re.search(r'https?://[^\s]+' + re.escape(domain_hint) + r'[^\s]*', text)
    if m:
        return m.group(0).rstrip('/')
    # fallback: any https URL
    m2 = re.search(r'https?://[^\s]+', text)
    return m2.group(0).rstrip('/') if m2 else text


def _resolve_redirect(url: str, timeout: int = 10) -> str:
    """Follow HTTP redirects and return final URL. Returns original on failure."""
    try:
        import requests as _req
        r = _req.head(url, allow_redirects=True, timeout=timeout)
        return r.url
    except Exception:
        try:
            import requests as _req
            r = _req.get(url, allow_redirects=True, timeout=timeout, stream=True)
            final = r.url
            r.close()
            return final
        except Exception:
            return url


# ── 共用下載小工具 ──────────────────────────────────────────────────────────

_CT_EXT_MAP = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
    "image/gif": ".gif",  "image/avif": ".avif", "image/heic": ".heic",
    "video/mp4": ".mp4",  "video/quicktime": ".mov",
}


def _ext_from_content_type(content_type: str, fallback: str) -> str:
    ct = (content_type or "").split(";")[0].strip().lower()
    return _CT_EXT_MAP.get(ct, fallback)


def _stream_download(req, dl_url: str, dest_stem: Path, fallback_ext: str,
                     timeout: int = 120, headers: dict | None = None) -> Path:
    """Stream dl_url → {dest_stem}{ext}（副檔名依 Content-Type 修正）."""
    r = req.get(dl_url, stream=True, timeout=timeout, headers=headers or {})
    r.raise_for_status()
    ext = _ext_from_content_type(r.headers.get("Content-Type", ""), fallback_ext)
    file_path = Path(str(dest_stem) + ext)
    with open(file_path, "wb") as fh:
        for chunk in r.iter_content(65536):
            fh.write(chunk)
    return file_path


def _linevoom_download(url: str, tmp_dir: Path) -> Path:
    """Scrape Line VOOM page for og:video / og:image and download."""
    try:
        import requests as _req
    except ImportError:
        raise RuntimeError("requests library not installed (pip install requests)")

    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    page = _req.get(url, headers=headers, timeout=15)
    page.raise_for_status()
    html = page.text

    # Extract og:video (preferred) → og:image fallback
    media_url, is_video = None, True
    for prop in ("og:video", "line:video", "og:image"):
        m = re.search(
            r'<meta[^>]+property=["\']' + prop + r'["\'][^>]+content=["\']([^"\']+)["\']',
            html, re.IGNORECASE,
        )
        if not m:
            m = re.search(
                r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']' + prop + r'["\']',
                html, re.IGNORECASE,
            )
        if m:
            media_url = m.group(1)
            is_video = "video" in prop
            break

    if not media_url:
        raise ValueError("Line VOOM: 無法從頁面擷取影片/圖片 URL（OG meta 缺失）")

    # Title → filename
    tm = re.search(
        r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', html, re.IGNORECASE
    )
    if not tm:
        tm = re.search(
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title["\']', html, re.IGNORECASE
        )
    title = re.sub(r'[^\w\s\-]', '', tm.group(1) if tm else "linevoom")[:60].strip()
    ext = ".mp4" if is_video else ".jpg"
    file_path = tmp_dir / (title + ext)

    r = _req.get(media_url, stream=True, headers=headers, timeout=120)
    r.raise_for_status()
    with open(file_path, "wb") as fh:
        for chunk in r.iter_content(65536):
            fh.write(chunk)
    return file_path


def _ytdlp_download(url: str, tmp_dir: Path) -> Path:
    """Download via yt-dlp Python API. Returns downloaded file path."""
    try:
        import yt_dlp
    except ImportError:
        raise RuntimeError("yt-dlp not installed (pip install yt-dlp)")

    ydl_opts = {
        "outtmpl": str(tmp_dir / "%(title)s.%(ext)s"),
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    files = sorted(tmp_dir.glob("*"), key=lambda f: f.stat().st_size, reverse=True)
    if not files or files[0].stat().st_size == 0:
        raise RuntimeError("yt-dlp: 下載後無法找到有效檔案")
    return files[0]


def _import_task_update(task_id: str, **kwargs) -> None:
    with _import_lock:
        _import_tasks[task_id] = dict(_import_tasks.get(task_id, {}), **kwargs)


def _gallery_dl_download(url: str, tmp_dir: Path, platform: str = "") -> list[Path]:
    """C1: Download via gallery-dl（本機 pip 套件）。Returns downloaded files.

    cookie 機制：config/cookies/{platform}.txt 存在即掛載；不存在則裸連，
    失敗時回覆優雅降級訊息（提示放置 cookie 檔）。
    """
    try:
        import gallery_dl  # noqa: F401 — 僅檢查安裝
    except ImportError:
        raise RuntimeError("gallery-dl not installed (pip install gallery-dl)")

    cmd = [sys.executable, "-m", "gallery_dl", "-D", str(tmp_dir), "--quiet"]
    ck = _cookie_file(platform)
    if ck:
        cmd += ["--cookies", str(ck)]
    if platform == "tumblr":
        api_key = os.environ.get("TUMBLR_CONSUMER_KEY")
        api_secret = os.environ.get("TUMBLR_CONSUMER_SECRET")
        if api_key and api_secret:
            cmd += ["-o", f"extractor.tumblr.api-key={api_key}",
                    "-o", f"extractor.tumblr.api-secret={api_secret}"]
        # 缺值時走原行為（gallery-dl 內建共用 key，易被限流）；不在此提前失敗
    cmd.append(url)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        raise RuntimeError("gallery-dl: 下載逾時（900s）")

    files = sorted(
        (f for f in tmp_dir.rglob("*")
         if f.is_file() and f.stat().st_size > 0 and f.suffix.lower() != ".json"),
        key=lambda f: f.name,
    )
    if files:
        return files

    err_lines = (proc.stderr or proc.stdout or "").strip().splitlines()
    detail = err_lines[-1][:200] if err_lines else f"exit code {proc.returncode}"
    msg = f"gallery-dl: {detail}"
    if not ck and platform in _COOKIE_PLATFORMS:
        msg += f"（{_cookie_hint(platform)}）"
    if platform == "tumblr" and not (os.environ.get("TUMBLR_CONSUMER_KEY") and os.environ.get("TUMBLR_CONSUMER_SECRET")):
        msg += "（未設定 TUMBLR_CONSUMER_KEY/SECRET，走內建共用 key 易被限流，請於 .ai-core/config/.env 設定專屬 key）"
    raise RuntimeError(msg)


# ---------------------------------------------------------------------------
# Engine functions — 統一簽名 (url, tmp_dir, task_id, platform) -> list[Path]
# ---------------------------------------------------------------------------

def _engine_cobalt(url: str, tmp_dir: Path, task_id: str, platform: str) -> list[Path]:
    import requests as _req
    try:
        resp = _req.post(
            f"{_COBALT_API}/",
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            json={"url": url}, timeout=10,
        )
    except (_req.exceptions.ConnectionError, _req.exceptions.Timeout):
        raise RuntimeError(f"cobalt 服務未啟動（{_COBALT_API}），請先啟動 cobalt Docker")
    try:
        data = resp.json()   # cobalt 4xx 也帶 JSON error body（error.code 較 HTTP 碼有資訊量）
    except ValueError:
        resp.raise_for_status()
        raise ValueError("cobalt: invalid JSON response")
    status = data.get("status", "")

    if status == "picker":
        # Multi-image picker (e.g. X.com tweet with multiple photos)
        picker_items = data.get("picker", [])
        if not picker_items:
            raise ValueError("cobalt: picker response has no items")
        files: list[Path] = []
        for idx, item in enumerate(picker_items):
            item_url = item.get("url")
            if not item_url:
                continue
            _import_task_update(task_id, status="running",
                                progress=30 + int(45 * idx / len(picker_items)))
            img_r = _req.get(item_url, stream=True, timeout=120)
            img_r.raise_for_status()
            cd = img_r.headers.get("Content-Disposition", "")
            fn_m = re.search(r'filename[^;=\n]*=(([\'"]).*?\2|[^\n;]+)', cd)
            if fn_m:
                img_name = fn_m.group(1).strip("\"'")
            else:
                url_base = item_url.split("?")[0].split("/")[-1]
                img_name = url_base if "." in url_base else f"photo_{idx + 1}.jpg"
            img_path = tmp_dir / img_name
            with open(img_path, "wb") as fh:
                for chunk in img_r.iter_content(65536):
                    fh.write(chunk)
            if img_path.stat().st_size > 0:
                files.append(img_path)
        if not files:
            raise RuntimeError("cobalt picker: no items downloaded successfully")
        return files

    if status not in ("stream", "redirect", "tunnel"):
        err_code = data.get("error", {}).get("code", "unknown")
        raise ValueError(f"cobalt: unexpected status '{status}' (error: {err_code})")
    dl_url = data.get("url")
    if not dl_url:
        raise ValueError("cobalt: no URL in response")
    _import_task_update(task_id, status="running", progress=30)
    r = _req.get(dl_url, stream=True, timeout=300)
    r.raise_for_status()
    cd = r.headers.get("Content-Disposition", "")
    # RFC 5987: filename*=UTF-8''... 優先；fallback filename="..."
    fn_m = re.search(r"filename\*=UTF-8''([^\s;]+)", cd, re.IGNORECASE)
    if fn_m:
        from urllib.parse import unquote as _unquote
        file_name = _unquote(fn_m.group(1))
    else:
        fn_m2 = re.search(r'filename[^;=\n]*=(([\'"]).*?\2|[^\n;]+)', cd)
        file_name = fn_m2.group(1).strip("\"'") if fn_m2 else "cobalt_download.mp4"
    file_path = tmp_dir / file_name
    with open(file_path, "wb") as fh:
        for chunk in r.iter_content(65536):
            fh.write(chunk)
    if file_path.stat().st_size == 0:
        file_path.unlink(missing_ok=True)
        # 空檔案（CDN 限制）→ 交由 fallback 鏈換引擎（youtube→yt-dlp 等）
        raise RuntimeError("cobalt tunnel 回傳空檔案（CDN 限制）")
    return [file_path]


def _engine_evil0ctal(url: str, tmp_dir: Path, task_id: str, platform: str) -> list[Path]:
    """Evil0ctal /api/hybrid/video_data：抖音 + TikTok（影片 & 圖文全圖）。"""
    import requests as _req
    hint = "tiktok.com" if platform == "tiktok" else "douyin.com"
    src_url = _extract_url_from_text(url, hint)
    if any(d in src_url.lower() for d in ("v.douyin.com", "vt.tiktok.com", "vm.tiktok.com")):
        _import_task_update(task_id, status="running", progress=15)
        src_url = _resolve_redirect(src_url)
    def _fetch(minimal: str) -> dict:
        resp = _req.get(
            f"{_EVIL_OCTAL_API}/api/hybrid/video_data",
            params={"url": src_url, "minimal": minimal}, timeout=45,
        )
        resp.raise_for_status()
        return resp.json().get("data") or {}

    try:
        api_data = _fetch("true")
    except _req.exceptions.HTTPError as _he:
        if _he.response is not None and _he.response.status_code == 400:
            raise ValueError("Evil0ctal: 無法取得資料（400）— 作品可能為私密、已刪除或 cookie 失效")
        raise

    # ── 影片 ────────────────────────────────────────────────────────────────
    # minimal=true 時 API 會把 data.video 清空為 {}（實測），需以 minimal=false 重打取回 play_addr；
    # 圖文的 image_data 不受影響，故只在 type=="video" 且 video 為空時才重打，維持圖文輕量路徑。
    if api_data.get("type") == "video" and not api_data.get("video"):
        api_data = _fetch("false")

    dl_url = (
        api_data.get("video", {})
                .get("play_addr", {})
                .get("url_list", [None])[0]
    )
    if dl_url:
        base_title = (api_data.get("desc") or "video")[:80]
        _import_task_update(task_id, status="running", progress=30)
        return [_stream_download(_req, dl_url, tmp_dir / base_title, ".mp4")]

    # ── 圖文作品：下載全部圖片 ──────────────────────────────────────────────
    img_urls = api_data.get("image_data", {}).get("no_watermark_image_list", []) or []
    if not img_urls:
        raise ValueError("Evil0ctal: 無法取得影片或圖片 URL（私密、已刪除或 cookie 失效）")
    base_title = (api_data.get("desc") or platform)[:60]
    files: list[Path] = []
    for _idx, _img_url in enumerate(img_urls):
        _import_task_update(task_id, status="running",
                            progress=30 + int(45 * _idx / len(img_urls)))
        try:
            files.append(_stream_download(
                _req, _img_url, tmp_dir / f"{base_title}_{_idx + 1}", ".jpg", timeout=60))
        except Exception:
            continue
    if not files:
        raise RuntimeError(f"{platform} 圖文：所有圖片下載失敗")
    return files


def _engine_xhs(url: str, tmp_dir: Path, task_id: str, platform: str) -> list[Path]:
    """XHS-Downloader /xhs/detail：C2 — 圖集完整抓取（非只取第一張）。

    新版容器回傳 data 為單一 dict（中文鍵：作品标题/作品类型/下载地址）；
    舊版為 list + 英文鍵。兩者皆相容。
    """
    import requests as _req
    body: dict = {"url": url, "download": False}
    ck = _cookie_file("xhs")
    if ck:
        try:
            body["cookie"] = _netscape_cookie_header(ck, ("xiaohongshu.com", "xhscdn.com"))
        except Exception:
            pass
    try:
        resp = _req.post(f"{_XHS_API}/xhs/detail", json=body, timeout=90)
        resp.raise_for_status()
    except _req.exceptions.ConnectionError:
        raise RuntimeError(f"XHS-Downloader 服務未啟動（{_XHS_API}），請先啟動 xhs Docker")
    except _req.exceptions.Timeout:
        raise RuntimeError(
            "XHS-Downloader: 解析逾時（若容器無法連上 xiaohongshu.com，"
            "多為台灣 DNS 封鎖，docker-compose 已改用 8.8.8.8，請 docker compose up -d 重建容器）"
        )
    payload = resp.json()
    data = payload.get("data")
    items = data if isinstance(data, list) else ([data] if data else [])
    items = [i for i in items if isinstance(i, dict) and i]
    if not items:
        msg = payload.get("message") or "no data in response"
        extra = ""
        if "xhslink.com" in url.lower():
            extra = "（xhslink.com 短鏈在台灣可能被 DNS 封鎖，請改貼 xiaohongshu.com 完整連結或啟用 VPN）"
        elif not ck:
            extra = "（小紅書多數內容需登入 cookie，請放置 config/cookies/xhs.txt，Netscape 格式，見 config/cookies/README.md）"
        raise ValueError(f"XHS-Downloader: {msg}{extra}")

    files: list[Path] = []
    for item in items:
        raw_title = (item.get("作品标题") or item.get("title")
                     or item.get("作品描述") or "xhs_media").strip()[:60] or "xhs_media"
        typ = str(item.get("作品类型") or item.get("type") or "").lower()
        addrs = item.get("下载地址") or item.get("download_address") or []
        if isinstance(addrs, str):
            addrs = addrs.split()
        if not addrs:
            continue
        is_video = typ in ("视频", "video")
        if is_video:
            addrs = addrs[:1]  # 影片僅取主檔
        for i, dl_url in enumerate(addrs):
            _import_task_update(task_id, status="running",
                                progress=30 + int(45 * i / len(addrs)))
            stem = tmp_dir / (raw_title if (is_video or len(addrs) == 1)
                              else f"{raw_title}_{i + 1}")
            try:
                files.append(_stream_download(
                    _req, dl_url, stem, ".mp4" if is_video else ".jpg"))
            except Exception:
                continue
    if not files:
        raise RuntimeError("XHS-Downloader: 圖集/影片所有檔案下載失敗")
    return files


def _engine_ytdlp(url: str, tmp_dir: Path, task_id: str, platform: str) -> list[Path]:
    _import_task_update(task_id, status="running", progress=35)
    return [_ytdlp_download(url, tmp_dir)]


def _engine_gallery_dl(url: str, tmp_dir: Path, task_id: str, platform: str) -> list[Path]:
    _import_task_update(task_id, status="running", progress=35)
    # facebook.com/share/{p,v}/ 與 t.co 短鏈 gallery-dl 不吃，先展開 redirect
    low = url.lower()
    if "facebook.com/share/" in low or "//t.co/" in low or "fb.watch" in low:
        url = _resolve_redirect(url)
    return _gallery_dl_download(url, tmp_dir, platform)


def _engine_linevoom(url: str, tmp_dir: Path, task_id: str, platform: str) -> list[Path]:
    _import_task_update(task_id, status="running", progress=20)
    return [_linevoom_download(url, tmp_dir)]


_ENGINES = {
    "cobalt":     _engine_cobalt,
    "evil0ctal":  _engine_evil0ctal,
    "xhs":        _engine_xhs,
    "ytdlp":      _engine_ytdlp,
    "gallery_dl": _engine_gallery_dl,
    "linevoom":   _engine_linevoom,
}

# ── 八平台引擎優先序表（宣告式 fallback 鏈）─────────────────────────────────
_ENGINE_CHAINS: dict[str, tuple[str, ...]] = {
    "douyin":    ("evil0ctal",),
    "tiktok":    ("cobalt", "evil0ctal", "ytdlp"),   # C3：cobalt/evil0ctal 實測失效時自動落到 yt-dlp
    "xhs":       ("xhs",),
    "x":         ("cobalt", "gallery_dl"),           # NSFW/受限推文 → gallery-dl + cookie
    "instagram": ("cobalt", "gallery_dl"),           # IG 反爬 → gallery-dl + cookie
    "facebook":  ("cobalt", "gallery_dl"),           # FB 相片 cobalt 不支援 → gallery-dl
    "youtube":   ("cobalt", "ytdlp"),
    "linevoom":  ("linevoom",),
    "tumblr":    ("gallery_dl", "ytdlp"),            # cobalt→ytdlp 雙敗實測；gallery-dl 專屬 API key 優先
    "generic":   ("cobalt", "ytdlp"),
}


def _run_engine_chain(task_id: str, platform: str, url: str, tmp_dir: Path) -> list[Path]:
    """依 _ENGINE_CHAINS 逐引擎嘗試，全數失敗時彙整錯誤（含 cookie 降級提示）。"""
    chain = _ENGINE_CHAINS.get(platform, ("cobalt",))
    errors: list[str] = []
    for idx, engine in enumerate(chain):
        engine_tmp = tmp_dir / f"eng{idx}_{engine}"
        engine_tmp.mkdir(parents=True, exist_ok=True)
        if idx:
            _import_task_update(task_id, status="running", progress=25,
                                message=f"改用備援引擎 {engine} …")
        try:
            files = _ENGINES[engine](url, engine_tmp, task_id, platform)
            if files:
                return files
            errors.append(f"{engine}: 無檔案產出")
        except Exception as exc:
            errors.append(f"{engine}: {exc}")
    msg = "；".join(errors) or "無可用引擎"
    hint = _cookie_hint(platform)
    if platform in _COOKIE_PLATFORMS and not _cookie_file(platform) and hint not in msg:
        msg += f"。{hint}"
    raise RuntimeError(msg)


def _download_worker(task_id: str, url: str, lib_name: str, folder_id: str = "", name: str = "") -> None:
    """Background thread: download URL via engine chain, create Eagle item(s), broadcast SSE."""
    _import_task_update(task_id, status="running", progress=10)
    tmp_dir = Path(tempfile.mkdtemp())
    try:
        platform = _classify_platform(url)

        if platform == "threads":
            raise ValueError(
                "Threads 平台暫不支援：目前無穩定下載工具鏈（規劃於後期支援）"
            )

        files = _run_engine_chain(task_id, platform, url, tmp_dir)
        _import_task_update(task_id, status="running", progress=80)

        # ── Create Eagle item(s) ─────────────────────────────────────────────
        multi = len(files) > 1
        results_list = []
        for idx, fp in enumerate(files):
            cname = (f"{name}_{idx + 1}" if name else "") if multi else name
            res = _create_eagle_item_from_file(
                lib_name, folder_id, fp.name, fp.read_bytes(), url,
                custom_name=cname,
            )
            if res["ok"]:
                _sse_broadcast(lib_name, {"type": "item_created",
                                          "id": res["id"], "lib": lib_name})
                results_list.append(res)
        if not results_list:
            raise RuntimeError("item creation failed（所有檔案入庫失敗）")

        if multi:
            result = {"count": len(results_list),
                      "ids": [r["id"] for r in results_list],
                      "name": results_list[0]["name"]}
        else:
            result = {"id": results_list[0]["id"], "name": results_list[0]["name"]}
        _import_task_update(task_id, status="completed", progress=100, result=result)

    except Exception as exc:
        _import_task_update(task_id, status="failed", progress=0, error=str(exc))
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def start_import_url(url: str, lib_name: str, folder_id: str = "", name: str = "") -> str:
    """Enqueue a URL import task. Returns task_id."""
    task_id = str(uuid.uuid4())[:8]
    with _import_lock:
        _import_tasks[task_id] = {"status": "pending", "progress": 0}
    t = threading.Thread(
        target=_download_worker,
        args=(task_id, url, lib_name, folder_id),
        kwargs={"name": name},
        daemon=True,
    )
    t.start()
    return task_id


def get_import_status(task_id: str) -> dict | None:
    """Return task status dict or None if not found."""
    with _import_lock:
        return dict(_import_tasks.get(task_id, {})) or None
