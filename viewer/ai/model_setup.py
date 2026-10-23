"""模型準備：下載 / 驗證 Chinese-CLIP ViT-B/16 ONNX 至 data/models/。

模型來源（現成 ONNX 轉出，免 torch 一次性轉換）：
    https://huggingface.co/zihuv/chinese-clip-vit-base-patch16-onnx
    （OFA-Sys/chinese-clip-vit-base-patch16 官方權重的 ONNX 匯出，
      embedding 512 維，text context length 52，Apache/MIT 授權鏈）

僅用 stdlib urllib 下載（支援斷點續傳 Range），sha256 + 檔案大小雙重驗證，
不依賴 huggingface_hub——Windows 側 Python 亦可直接使用。
"""
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import _VIEWER_DIR  # noqa: F401  (side effect: sys.path 打平)
from config import DATA_DIR

HF_REPO   = "zihuv/chinese-clip-vit-base-patch16-onnx"
BASE_URL  = f"https://huggingface.co/{HF_REPO}/resolve/main/"
MODEL_DIR = DATA_DIR / "models" / "chinese-clip-vit-b16"

# sha256 為 2026-07-03 首次下載後的實測值（sha256sum）
MODEL_FILES = {
    "visual.onnx": {
        "size": 344963070,
        "sha256": "303f72307943b7ef5e478ac0f8a5686bdfc62847b8b331e32e89fe223ffcfe35",
    },
    "text.onnx": {
        "size": 408491787,
        "sha256": "6d8de6ba498ae2c944ec2b578371c1b3e9dd5a9a991dd4f7dabc16b8111c6f4d",
    },
    "vocab.txt": {
        "size": 109540,
        "sha256": "45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c",
    },
    "model_config.json": {
        "size": 949,
        "sha256": "343ffa322c2f1ee0687e535911752df3b77589dac9be05bd6a0aec2dc486b081",
    },
}

EMBED_DIM      = 512
CONTEXT_LENGTH = 52
IMAGE_SIZE     = 224
MODEL_NAME     = "chinese-clip-vit-b16"


def _sha256(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def _verify(path: Path, spec: dict, check_hash: bool = True) -> bool:
    """大小必驗；sha256 已知時亦驗（大檔 hash 約數秒，僅首次/損毀時觸發重驗）。"""
    if not path.exists():
        return False
    if path.stat().st_size != spec["size"]:
        return False
    if check_hash and spec.get("sha256"):
        return _sha256(path) == spec["sha256"]
    return True


def _download(url: str, dest: Path, expected_size: int, verbose: bool = True) -> None:
    """urllib 下載，.part 暫存 + Range 斷點續傳 + 進度輸出。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    done = part.stat().st_size if part.exists() else 0
    if done > expected_size:          # 損毀的暫存檔
        part.unlink()
        done = 0

    while done < expected_size:
        req = urllib.request.Request(url, headers={"User-Agent": "eagle-viewer-ai/1.0"})
        if done:
            req.add_header("Range", f"bytes={done}-")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp, open(part, "ab" if done else "wb") as out:
                t0, last = time.time(), done
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
                    done += len(chunk)
                    if verbose and time.time() - t0 >= 2:
                        speed = (done - last) / (time.time() - t0) / (1 << 20)
                        print(f"    {dest.name}: {done / (1 << 20):.0f}/{expected_size / (1 << 20):.0f} MB"
                              f" ({speed:.1f} MB/s)", flush=True)
                        t0, last = time.time(), done
        except (urllib.error.URLError, OSError) as e:
            if done < expected_size:
                print(f"    [重試] {dest.name} 於 {done / (1 << 20):.0f} MB 中斷：{e}", flush=True)
                time.sleep(3)
                continue
            raise
    part.replace(dest)


def ensure_model(verbose: bool = True, check_hash: bool = True) -> dict:
    """確保模型檔齊備且通過驗證。回傳各檔絕對路徑 dict。

    Raises:
        RuntimeError: 下載後仍驗證失敗（網路截斷 / 來源異動）。
    """
    paths = {}
    for fname, spec in MODEL_FILES.items():
        fpath = MODEL_DIR / fname
        if not _verify(fpath, spec, check_hash=check_hash):
            if verbose:
                print(f"  下載模型檔 {fname}（{spec['size'] / (1 << 20):.0f} MB）...", flush=True)
            _download(BASE_URL + fname, fpath, spec["size"], verbose=verbose)
            if not _verify(fpath, spec, check_hash=True):
                actual = _sha256(fpath) if fpath.exists() else "missing"
                raise RuntimeError(
                    f"模型檔驗證失敗：{fname}\n"
                    f"  期望 sha256={spec.get('sha256')} size={spec['size']}\n"
                    f"  實際 sha256={actual} size={fpath.stat().st_size if fpath.exists() else 0}\n"
                    f"  請刪除 {fpath} 後重試，或確認來源 {BASE_URL + fname}"
                )
        paths[fname] = fpath
    return paths


def model_info() -> dict:
    """模型現況（供 meta.json / 狀態 API 用）。"""
    files = {}
    for fname, spec in MODEL_FILES.items():
        p = MODEL_DIR / fname
        files[fname] = {
            "present": p.exists(),
            "size": p.stat().st_size if p.exists() else 0,
            "expected_size": spec["size"],
        }
    return {
        "model": MODEL_NAME,
        "repo": HF_REPO,
        "embed_dim": EMBED_DIM,
        "context_length": CONTEXT_LENGTH,
        "image_size": IMAGE_SIZE,
        "dir": str(MODEL_DIR),
        "files": files,
    }


if __name__ == "__main__":
    print(f"模型目錄：{MODEL_DIR}")
    ensure_model(verbose=True)
    print(json.dumps(model_info(), ensure_ascii=False, indent=2))
    print("模型就緒 ✓")
