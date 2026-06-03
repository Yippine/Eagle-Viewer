"""File upload helpers, user data, and URL import (wf-007/wf-008)."""
import json
import os
import random
import re
import shutil
import string
import tempfile
import threading
import time
import uuid
from pathlib import Path

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
_EMPTY_USER_DATA = {"version": 0, "filterPresets": [], "transformSnapshots": {}}


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
    return {
        "version":            int(time.time() * 1000),
        "filterPresets":      list(s_fp.values()),
        "transformSnapshots": s_ts,
    }


# ---------------------------------------------------------------------------
# wf-008: URL Import  (async background download + 3 engines)
# ---------------------------------------------------------------------------

_import_tasks: dict    = {}
_import_lock = threading.Lock()

# Engine base URLs – override via env vars
_COBALT_API      = os.environ.get("COBALT_API",      "http://localhost:9001")
_EVIL_OCTAL_API  = os.environ.get("EVIL_OCTAL_API",  "http://localhost:9003")
_XHS_API         = os.environ.get("XHS_DOWNLOADER_API", "http://localhost:5555")


def _classify_platform(url: str) -> str:
    """Return 'douyin' | 'xhs' | 'ytdlp' | 'cobalt' based on URL domain."""
    u = url.lower()
    if "douyin.com" in u or "v.douyin.com" in u:
        return "douyin"
    if "xiaohongshu.com" in u or "xhslink.com" in u:
        return "xhs"
    if "linevoom.line.me" in u:
        return "linevoom"
    return "cobalt"


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


def _is_youtube_url(url: str) -> bool:
    u = url.lower()
    return "youtube.com" in u or "youtu.be" in u


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


def _download_worker(task_id: str, url: str, lib_name: str, folder_id: str = "", name: str = "") -> None:
    """Background thread: download URL, create Eagle item, broadcast SSE."""
    _import_task_update(task_id, status="running", progress=10)
    tmp_dir = Path(tempfile.mkdtemp())
    try:
        try:
            import requests as _req
        except ImportError:
            raise RuntimeError("requests library not installed (pip install requests)")

        platform = _classify_platform(url)

        # ── Engine dispatch ──────────────────────────────────────────────────
        if platform == "linevoom":
            # Line VOOM: scrape OG meta tags for direct video/image URL
            _import_task_update(task_id, status="running", progress=20)
            file_path = _linevoom_download(url, tmp_dir)

        elif platform == "douyin":
            # Extract URL from share text, then resolve v.douyin.com short link
            douyin_url = _extract_url_from_text(url, "douyin.com")
            if "v.douyin.com" in douyin_url.lower():
                _import_task_update(task_id, status="running", progress=15)
                douyin_url = _resolve_redirect(douyin_url)
            try:
                resp = _req.get(
                    f"{_EVIL_OCTAL_API}/api/hybrid/video_data",
                    params={"url": douyin_url, "minimal": "true"}, timeout=30,
                )
                resp.raise_for_status()
            except _req.exceptions.HTTPError as _he:
                if _he.response is not None and _he.response.status_code == 400:
                    raise ValueError("Evil0ctal: 無法取得抖音資料（400）— 影片可能為私密、已刪除或 cookie 失效")
                raise
            api_data = resp.json().get("data") or {}

            # ── 影片 ────────────────────────────────────────────────────────
            dl_url = (
                api_data.get("video", {})
                        .get("play_addr", {})
                        .get("url_list", [None])[0]
            )
            if dl_url:
                file_name = (api_data.get("desc") or "video")[:80] + ".mp4"
                _import_task_update(task_id, status="running", progress=30)
                r = _req.get(dl_url, stream=True, timeout=120)
                r.raise_for_status()
                file_path = tmp_dir / file_name
                with open(file_path, "wb") as fh:
                    for chunk in r.iter_content(65536):
                        fh.write(chunk)
            else:
                # ── 圖文作品：下載全部圖片，各建一個 Eagle item ────────────
                img_urls = api_data.get("image_data", {}).get("no_watermark_image_list", [])
                if not img_urls:
                    raise ValueError("Evil0ctal: 無法取得影片或圖片 URL（私密、已刪除或 cookie 失效）")
                base_title = (api_data.get("desc") or "douyin")[:60]
                results_list = []
                for _idx, _img_url in enumerate(img_urls):
                    _import_task_update(task_id, status="running",
                                        progress=30 + int(50 * _idx / len(img_urls)))
                    _img_r = _req.get(_img_url, stream=True, timeout=60)
                    _img_r.raise_for_status()
                    _img_path = tmp_dir / f"{base_title}_{_idx + 1}.jpg"
                    with open(_img_path, "wb") as fh:
                        for chunk in _img_r.iter_content(65536):
                            fh.write(chunk)
                    _cname = f"{name}_{_idx + 1}" if name else f"{base_title}_{_idx + 1}"
                    _res = _create_eagle_item_from_file(
                        lib_name, folder_id, _img_path.name, _img_path.read_bytes(), url,
                        custom_name=_cname,
                    )
                    if _res["ok"]:
                        _sse_broadcast(lib_name, {"type": "item_created",
                                                   "id": _res["id"], "lib": lib_name})
                        results_list.append(_res)
                if not results_list:
                    raise RuntimeError("douyin 圖文：所有圖片下載失敗")
                _import_task_update(task_id, status="completed", progress=100,
                                    result={"count": len(results_list),
                                            "ids": [_r["id"] for _r in results_list],
                                            "name": results_list[0]["name"]})
                return  # 圖文已處理完畢，跳過後續影片流程

        elif platform == "xhs":
            # XHS-Downloader API mode（joeanamier/xhs-downloader, port 5556）
            # endpoint: POST /xhs/detail（非 /xhs/download）
            resp = _req.post(
                f"{_XHS_API}/xhs/detail",
                json={"url": url, "download": False}, timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            # response: {"data": [{"type": "video"|"image", "title": "...",
            #                      "download_address": ["url1", ...]}]}
            items = data.get("data") or []
            if not items:
                raise ValueError("XHS-Downloader: no data in response")
            item0 = items[0]
            raw_title = (item0.get("title") or "xhs_media")[:80]
            addrs = item0.get("download_address", [])
            dl_url = addrs[0] if addrs else None
            if not dl_url:
                raise ValueError("XHS-Downloader: no download URL in response")
            ext_guess = ".mp4" if item0.get("type", "").lower() == "video" else ".jpg"
            file_name = raw_title + ext_guess
            _import_task_update(task_id, status="running", progress=30)
            r = _req.get(dl_url, stream=True, timeout=120)
            r.raise_for_status()
            file_path = tmp_dir / file_name
            with open(file_path, "wb") as fh:
                for chunk in r.iter_content(65536):
                    fh.write(chunk)

        else:  # cobalt
            try:
                resp = _req.post(
                    f"{_COBALT_API}/",
                    headers={"Content-Type": "application/json", "Accept": "application/json"},
                    json={"url": url}, timeout=10,
                )
            except (_req.exceptions.ConnectionError, _req.exceptions.Timeout):
                raise RuntimeError(f"cobalt 服務未啟動（{_COBALT_API}），請先啟動 cobalt Docker")
            resp.raise_for_status()
            data = resp.json()
            status = data.get("status", "")

            if status == "picker":
                # Multi-image picker (e.g. X.com tweet with multiple photos)
                picker_items = data.get("picker", [])
                if not picker_items:
                    raise ValueError("cobalt: picker response has no items")
                results_list = []
                for idx, item in enumerate(picker_items):
                    item_url = item.get("url")
                    if not item_url:
                        continue
                    _import_task_update(task_id, status="running",
                                        progress=30 + int(50 * idx / len(picker_items)))
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
                    cname = f"{name}_{idx + 1}" if name else ""
                    res_i = _create_eagle_item_from_file(
                        lib_name, folder_id, img_path.name, img_path.read_bytes(), url,
                        custom_name=cname,
                    )
                    if res_i["ok"]:
                        _sse_broadcast(lib_name, {"type": "item_created",
                                                   "id": res_i["id"], "lib": lib_name})
                        results_list.append(res_i)
                if not results_list:
                    raise RuntimeError("cobalt picker: no items downloaded successfully")
                _import_task_update(task_id, status="completed", progress=100,
                                    result={"count": len(results_list),
                                            "ids": [r["id"] for r in results_list],
                                            "name": results_list[0]["name"]})
                return

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
                if _is_youtube_url(url):
                    _import_task_update(task_id, status="running", progress=35)
                    file_path = _ytdlp_download(url, tmp_dir)
                else:
                    raise RuntimeError(
                        "cobalt tunnel 回傳空檔案（CDN 限制，請確認 URL 是否有效）"
                    )

        _import_task_update(task_id, status="running", progress=80)

        # ── Create Eagle item ────────────────────────────────────────────────
        file_bytes = file_path.read_bytes()
        result     = _create_eagle_item_from_file(
            lib_name, folder_id, file_path.name, file_bytes, url,
            custom_name=name,
        )
        if not result["ok"]:
            raise RuntimeError(result.get("error", "item creation failed"))

        _sse_broadcast(lib_name, {"type": "item_created", "id": result["id"], "lib": lib_name})
        _import_task_update(task_id, status="completed", progress=100,
                            result={"id": result["id"], "name": result["name"]})

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
