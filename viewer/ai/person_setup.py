"""人物偵測模型準備：下載 / 驗證 YOLOX-Tiny ONNX 至 data/models/。

模型來源（Megvii 官方 release，授權 Apache-2.0）：
    https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx
    YOLOX-Tiny（COCO 80 類，class 0 = person），416×416 輸入，opset 11。

    輸入  images   float32 (1, 3, 416, 416)  BGR（cv2 訓練慣例）、0–255 未正規化
    輸出  output   float32 (1, 3549, 85)      85 = cx,cy,w,h(grid 單位)+obj+80 類
                                              3549 = 52²+26²+13²（strides 8/16/32）

僅用 stdlib urllib 下載（斷點續傳 + sha256 雙重驗證），沿用 model_setup.py /
fer_setup.py 模式。
"""
import json

from . import _VIEWER_DIR  # noqa: F401  (side effect: sys.path 打平)
from config import DATA_DIR
from .model_setup import _download, _sha256, _verify

BASE_URL = ("https://github.com/Megvii-BaseDetection/YOLOX/releases/"
            "download/0.1.1rc0/")
PERSON_MODEL_DIR = DATA_DIR / "models" / "yolox-tiny"

# sha256 為 2026-07-17 首次下載後的實測值（sha256sum）
PERSON_FILES = {
    "yolox_tiny.onnx": {
        "size": 20219662,
        "sha256": "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7",
    },
}

PERSON_INPUT_SIZE  = 416     # letterbox 邊長
PERSON_MODEL_NAME  = "yolox-tiny"
PERSON_STRIDES     = (8, 16, 32)
PERSON_CLASS_ID    = 0       # COCO class 0 = person


def ensure_person_model(verbose: bool = True, check_hash: bool = True) -> dict:
    """確保人物偵測模型檔齊備且通過驗證。回傳各檔絕對路徑 dict。

    Raises:
        RuntimeError: 下載後仍驗證失敗（網路截斷 / 來源異動）。
    """
    paths = {}
    for fname, spec in PERSON_FILES.items():
        fpath = PERSON_MODEL_DIR / fname
        if not _verify(fpath, spec, check_hash=check_hash):
            if verbose:
                print(f"  下載人物偵測模型檔 {fname}（{spec['size'] / (1 << 20):.0f} MB）...",
                      flush=True)
            _download(BASE_URL + fname, fpath, spec["size"], verbose=verbose)
            if not _verify(fpath, spec, check_hash=True):
                actual = _sha256(fpath) if fpath.exists() else "missing"
                raise RuntimeError(
                    f"人物偵測模型檔驗證失敗：{fname}\n"
                    f"  期望 sha256={spec.get('sha256')} size={spec['size']}\n"
                    f"  實際 sha256={actual} size={fpath.stat().st_size if fpath.exists() else 0}\n"
                    f"  請刪除 {fpath} 後重試，或確認來源 {BASE_URL + fname}"
                )
        paths[fname] = fpath
    return paths


def person_model_info() -> dict:
    """人物偵測模型現況（供 meta / 狀態 API 用）。"""
    files = {}
    for fname, spec in PERSON_FILES.items():
        p = PERSON_MODEL_DIR / fname
        files[fname] = {
            "present": p.exists(),
            "size": p.stat().st_size if p.exists() else 0,
            "expected_size": spec["size"],
        }
    return {
        "model": PERSON_MODEL_NAME,
        "license": "Apache-2.0（Megvii-BaseDetection/YOLOX release 0.1.1rc0）",
        "source": BASE_URL + "yolox_tiny.onnx",
        "input_size": PERSON_INPUT_SIZE,
        "dir": str(PERSON_MODEL_DIR),
        "files": files,
    }


if __name__ == "__main__":
    print(f"人物偵測模型目錄：{PERSON_MODEL_DIR}")
    ensure_person_model(verbose=True)
    print(json.dumps(person_model_info(), ensure_ascii=False, indent=2))
    print("人物偵測模型就緒 ✓")
