#!/usr/bin/env python3
"""Eagle Viewer – System Tray Launcher"""
import socket
import sys
import threading
import time
import traceback
import webbrowser
from pathlib import Path

_LOG_DIR = Path(__file__).parent.parent / "logs"
_LOG_DIR.mkdir(exist_ok=True)
_LOG = _LOG_DIR / "eagle_viewer.log"

def _log(msg: str):
    with open(_LOG, "a", encoding="utf-8") as f:
        f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")

sys.stdout = open(_LOG, "a", encoding="utf-8")
sys.stderr = sys.stdout

sys.path.insert(0, str(Path(__file__).parent))
_log("=== tray.py 啟動 ===")

PORT = 8765


def _make_icon():
    from PIL import Image, ImageDraw
    sz = 64
    img = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([0, 0, sz - 1, sz - 1], fill=(37, 99, 235, 255))
    d.polygon([(22, 16), (22, 48), (50, 32)], fill=(255, 255, 255, 230))
    return img


def _start_server():
    try:
        _log("server thread 啟動")
        import serve
        _log("serve.py import 成功")
        serve.main()
    except Exception:
        _log("server 崩潰：\n" + traceback.format_exc())


def _open_when_ready():
    """等 server port 開始 listen 後再開瀏覽器（最多等 60 秒）。"""
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=1):
                break
        except OSError:
            time.sleep(0.3)
    webbrowser.open(f"http://localhost:{PORT}/")


def _port_in_use() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=1):
            return True
    except OSError:
        return False


def main():
    try:
        import pystray
        _log("pystray import 成功")
    except Exception:
        _log("pystray import 失敗：\n" + traceback.format_exc())
        return

    if _port_in_use():
        _log(f"port {PORT} 已佔用，直接開瀏覽器")
        webbrowser.open(f"http://localhost:{PORT}/")
        return

    threading.Thread(target=_start_server, daemon=True).start()
    threading.Thread(target=_open_when_ready, daemon=True).start()
    _log("threads 已啟動，進入 icon.run()")

    def on_open(icon, item):
        webbrowser.open(f"http://localhost:{PORT}/")

    def on_quit(icon, item):
        icon.stop()

    icon = pystray.Icon(
        name="eagle-viewer",
        icon=_make_icon(),
        title="Eagle Viewer",
        menu=pystray.Menu(
            pystray.MenuItem("開啟瀏覽器", on_open, default=True),
            pystray.MenuItem("關閉伺服器", on_quit),
        ),
    )

    icon.run()


if __name__ == "__main__":
    main()
