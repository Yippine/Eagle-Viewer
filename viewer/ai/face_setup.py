"""人臉模型準備：下載 / 驗證 InsightFace buffalo_l ONNX 至 data/models/。

模型來源（buffalo_l 模型包的單檔直取，免下載整包 zip）：
    https://huggingface.co/public-data/insightface/tree/main/models/buffalo_l
    （deepinsight/insightface 官方 v0.7 release 同內容之 HF 鏡像）

    det_10g.onnx    SCRFD-10G 人臉偵測（640×640，含 5 點 landmark）
    w600k_r50.onnx  ArcFace ResNet-50（WebFace600K），112×112 → 512 維 embedding

僅用 stdlib urllib 下載（斷點續傳 + sha256 雙重驗證），沿用 model_setup.py 模式。
"""
import hashlib
import json
from pathlib import Path

from . import _VIEWER_DIR  # noqa: F401  (side effect: sys.path 打平)
from config import DATA_DIR
from .model_setup import _download, _sha256, _verify

HF_REPO       = "public-data/insightface"
BASE_URL      = f"https://huggingface.co/{HF_REPO}/resolve/main/models/buffalo_l/"
FACE_MODEL_DIR = DATA_DIR / "models" / "insightface-buffalo_l"

# sha256 為 2026-07-03 首次下載後的實測值（sha256sum）
FACE_MODEL_FILES = {
    "det_10g.onnx": {
        "size": 16923827,
        "sha256": "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
    },
    "w600k_r50.onnx": {
        "size": 174383860,
        "sha256": "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
    },
}

FACE_EMBED_DIM  = 512
DET_INPUT_SIZE  = 640      # SCRFD 輸入邊長
ALIGN_SIZE      = 112      # ArcFace 對齊輸入邊長
FACE_MODEL_NAME = "insightface-buffalo_l"


def ensure_face_model(verbose: bool = True, check_hash: bool = True) -> dict:
    """確保人臉模型檔齊備且通過驗證。回傳各檔絕對路徑 dict。

    Raises:
        RuntimeError: 下載後仍驗證失敗（網路截斷 / 來源異動）。
    """
    paths = {}
    for fname, spec in FACE_MODEL_FILES.items():
        fpath = FACE_MODEL_DIR / fname
        if not _verify(fpath, spec, check_hash=check_hash):
            if verbose:
                print(f"  下載人臉模型檔 {fname}（{spec['size'] / (1 << 20):.0f} MB）...", flush=True)
            _download(BASE_URL + fname, fpath, spec["size"], verbose=verbose)
            if not _verify(fpath, spec, check_hash=True):
                actual = _sha256(fpath) if fpath.exists() else "missing"
                raise RuntimeError(
                    f"人臉模型檔驗證失敗：{fname}\n"
                    f"  期望 sha256={spec.get('sha256')} size={spec['size']}\n"
                    f"  實際 sha256={actual} size={fpath.stat().st_size if fpath.exists() else 0}\n"
                    f"  請刪除 {fpath} 後重試，或確認來源 {BASE_URL + fname}"
                )
        paths[fname] = fpath
    return paths


def face_model_info() -> dict:
    """人臉模型現況（供 meta / 狀態 API 用）。"""
    files = {}
    for fname, spec in FACE_MODEL_FILES.items():
        p = FACE_MODEL_DIR / fname
        files[fname] = {
            "present": p.exists(),
            "size": p.stat().st_size if p.exists() else 0,
            "expected_size": spec["size"],
        }
    return {
        "model": FACE_MODEL_NAME,
        "repo": HF_REPO,
        "embed_dim": FACE_EMBED_DIM,
        "det_input_size": DET_INPUT_SIZE,
        "align_size": ALIGN_SIZE,
        "dir": str(FACE_MODEL_DIR),
        "files": files,
    }


if __name__ == "__main__":
    print(f"人臉模型目錄：{FACE_MODEL_DIR}")
    ensure_face_model(verbose=True)
    print(json.dumps(face_model_info(), ensure_ascii=False, indent=2))
    print("人臉模型就緒 ✓")
