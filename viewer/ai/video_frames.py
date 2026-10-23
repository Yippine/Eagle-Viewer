"""影片抽幀（B3）：ffmpeg 均勻抽 N 幀 → PIL Image（供人臉/語意索引消費）。

策略：
    幀數 n = clamp(ceil(duration / interval), 1, max_frames)，預設 interval=10s、
    上限 12 幀；時間戳均勻取 duration * (i + 0.5) / n（避開頭尾黑幀機率較高處）。
    每幀以 ffmpeg「輸入端 -ss 快速 seek」單獨解碼（-frames:v 1），不做全片解碼
    ——WSL/DrvFS I/O 慢，全片 decode 在大檔上不可接受（沿用 Excire DrvFS 容錯的
    保守 I/O 哲學）。

依賴：系統 ffmpeg / ffprobe（無 Python 套件依賴）；缺 ffmpeg → RuntimeError
（呼叫端決定降級為 Eagle 現成首幀縮圖）。
"""
import io
import json
import shutil
import subprocess

from PIL import Image

DEFAULT_FRAME_INTERVAL = 10.0   # 每 N 秒 1 幀
DEFAULT_MAX_FRAMES     = 12     # 每片上限
_PROBE_TIMEOUT  = 30            # 秒；DrvFS 冷讀容忍
_FRAME_TIMEOUT  = 60


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def video_duration(path) -> float:
    """ffprobe 讀片長（秒）；失敗 → 0.0（呼叫端保底抽 1 幀）。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "json", str(path)],
            capture_output=True, timeout=_PROBE_TIMEOUT)
        dur = json.loads(out.stdout or b"{}").get("format", {}).get("duration")
        return max(float(dur), 0.0) if dur is not None else 0.0
    except (subprocess.TimeoutExpired, ValueError, OSError):
        return 0.0


def frame_timestamps(duration: float, interval: float = DEFAULT_FRAME_INTERVAL,
                     max_frames: int = DEFAULT_MAX_FRAMES) -> list:
    """→ [ts, ...] 均勻抽樣時間戳（秒）。duration 未知（0）→ [0.5]（首秒保底）。"""
    if duration <= 0:
        return [0.5]
    n = max(1, min(int(duration / interval) + 1, max_frames))
    return [round(duration * (i + 0.5) / n, 3) for i in range(n)]


def extract_frame(path, ts: float) -> Image.Image:
    """ffmpeg 輸入端 seek 抽單幀 → PIL Image（RGB）。失敗拋 RuntimeError。"""
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{max(ts, 0):.3f}", "-i", str(path),
           "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "2", "-"]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=_FRAME_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"ffmpeg 抽幀逾時（ts={ts}s）：{path}")
    if not out.stdout:
        raise RuntimeError(f"ffmpeg 抽幀無輸出（ts={ts}s）："
                           f"{(out.stderr or b'')[:200].decode('utf-8', 'replace')}")
    return Image.open(io.BytesIO(out.stdout)).convert("RGB")


def iter_video_frames(path, interval: float = DEFAULT_FRAME_INTERVAL,
                      max_frames: int = DEFAULT_MAX_FRAMES):
    """→ yield (ts, PIL.Image)。單幀失敗跳過（片尾 seek 越界等），全失敗 → 空。"""
    if not ffmpeg_available():
        raise RuntimeError("找不到 ffmpeg / ffprobe；影片多幀索引需要系統 ffmpeg")
    duration = video_duration(path)
    for ts in frame_timestamps(duration, interval=interval, max_frames=max_frames):
        try:
            yield ts, extract_frame(path, ts)
        except RuntimeError:
            continue
