#!/usr/bin/env python3
"""Eagle Viewer – System Tray Launcher"""
import os
import socket
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

DEV_MODE = True  # set False before release

_ROOT = Path(__file__).parent.parent
_LOG_DIR = _ROOT / "logs"
_LOG_DIR.mkdir(exist_ok=True)
_LOG = _LOG_DIR / "eagle_viewer.log"
_PID_FILE = _LOG_DIR / "eagle_viewer.pid"

def _log(msg: str):
    with open(_LOG, "a", encoding="utf-8") as f:
        f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")

sys.stdout = open(_LOG, "a", encoding="utf-8")
sys.stderr = sys.stdout

sys.path.insert(0, str(Path(__file__).parent))
_log("=== tray.py 啟動 ===")

PORT = 8765


def _kill_existing():
    if not _PID_FILE.exists():
        return
    try:
        old_pid = int(_PID_FILE.read_text().strip())
        if old_pid == os.getpid():
            return
        _log(f"發現舊 PID {old_pid}，嘗試終止")
        subprocess.run(
            ["taskkill", "/F", "/PID", str(old_pid)],
            capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        time.sleep(0.6)
    except Exception:
        _log("終止舊 process 失敗（可能已關閉）：\n" + traceback.format_exc())
    finally:
        try:
            _PID_FILE.unlink(missing_ok=True)
        except Exception:
            pass


def _write_pid():
    _PID_FILE.write_text(str(os.getpid()))


def _cleanup_pid():
    try:
        _PID_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def _make_icon():
    from PIL import Image
    ico = Path(__file__).parent / "icon.ico"
    if ico.exists():
        try:
            img = Image.open(ico).convert("RGBA")
            img.thumbnail((64, 64), Image.LANCZOS)
            return img
        except Exception:
            pass
    # fallback: draw eagle inline (same design as make_icon.py)
    from PIL import ImageDraw
    sz = 64
    img = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    sc = sz / 512
    def p(x, y): return (int(x * sc), int(y * sc))
    def bb(x1, y1, x2, y2): return [int(x1*sc), int(y1*sc), int(x2*sc), int(y2*sc)]
    W, BK = (255, 255, 255, 255), (252, 211, 77, 255)
    d.rounded_rectangle(bb(0,0,512,512), radius=int(100*sc), fill=(37,99,235,255))
    d.polygon([p(222,252),p(50,188),p(84,206),p(158,228),p(202,254),p(46,290),p(96,282),p(170,266),p(222,266)], fill=W)
    d.polygon([p(290,252),p(462,188),p(428,206),p(354,228),p(310,254),p(466,290),p(416,282),p(342,266),p(290,266)], fill=W)
    d.ellipse(bb(204,240,308,276), fill=W)
    d.ellipse(bb(214,240,298,392), fill=W)
    d.ellipse(bb(257,186,309,258), fill=W)
    d.ellipse(bb(264,130,352,218), fill=W)
    d.polygon([p(348,162),p(392,175),p(348,188)], fill=BK)
    d.polygon([p(234,382),p(216,424),p(240,408),p(256,428),p(272,408),p(296,424),p(278,382)], fill=W)
    return img


def _start_server():
    try:
        _log("server thread 啟動")
        import serve
        _log("serve.py import 成功")
        serve.main()
    except Exception:
        _log("server 崩潰：\n" + traceback.format_exc())


def _port_in_use() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=1):
            return True
    except OSError:
        return False


def main():
    _kill_existing()
    _write_pid()

    try:
        import pystray
        _log("pystray import 成功")
    except Exception:
        _log("pystray import 失敗：\n" + traceback.format_exc())
        _cleanup_pid()
        return

    if _port_in_use():
        _log(f"port {PORT} 已佔用，嘗試繼續（舊 server 可能尚未關閉）")
        time.sleep(1.5)

    threading.Thread(target=_start_server, daemon=True).start()
    _log("server thread 已啟動，進入 icon.run()")

    def on_open(icon, item):
        import webbrowser
        webbrowser.open(f"http://localhost:{PORT}/")

    def on_reload(icon, item):
        _log("使用者觸發重新載入，重啟 tray.py")
        script = str(Path(__file__).resolve())
        subprocess.Popen(
            ["pythonw", script],
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW,
            close_fds=True,
        )
        icon.stop()

    def on_quit(icon, item):
        _cleanup_pid()
        icon.stop()

    menu_items = [
        pystray.MenuItem("開啟", on_open, default=True),
    ]
    if DEV_MODE:
        menu_items.append(pystray.MenuItem("重新啟動", on_reload))
    menu_items.append(pystray.MenuItem("結束", on_quit))

    icon = pystray.Icon(
        name="eagle-viewer",
        icon=_make_icon(),
        title="Eagle Viewer",
        menu=pystray.Menu(*menu_items),
    )

    icon.run()
    _cleanup_pid()


if __name__ == "__main__":
    main()
