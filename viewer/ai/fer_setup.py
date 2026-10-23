"""表情模型準備：下載 / 驗證 emotion-ferplus-8 ONNX 至 data/models/。

模型來源（ONNX Model Zoo 官方，授權 MIT）：
    https://github.com/onnx/models/tree/main/validated/vision/body_analysis/emotion_ferplus
    emotion-ferplus-8.onnx  FER+（Barsoum et al. 2016，CNTK 訓練，opset 8）

    輸入  Input3            float32 (1, 1, 64, 64) 灰階，像素值 0–255（免正規化）
    輸出  Plus692_Output_0  float32 (1, 8) raw scores（softmax 後為機率）
    類別（訓練固定順序）：neutral, happiness, surprise, sadness,
                          anger, disgust, fear, contempt

僅用 stdlib urllib 下載（斷點續傳 + sha256 雙重驗證），沿用 model_setup.py 模式。
"""
import json

from . import _VIEWER_DIR  # noqa: F401  (side effect: sys.path 打平)
from config import DATA_DIR
from .model_setup import _download, _sha256, _verify

BASE_URL = ("https://github.com/onnx/models/raw/main/validated/vision/"
            "body_analysis/emotion_ferplus/model/")
FER_MODEL_DIR = DATA_DIR / "models" / "emotion-ferplus"

# sha256 為 2026-07-16 首次下載後的實測值（sha256sum）
FER_MODEL_FILES = {
    "emotion-ferplus-8.onnx": {
        "size": 35040571,
        "sha256": "a2a2ba6a335a3b29c21acb6272f962bd3d47f84952aaffa03b60986e04efa61c",
    },
}

FER_INPUT_SIZE  = 64       # 灰階輸入邊長
FER_MODEL_NAME  = "emotion-ferplus-8"

# 類別（訓練固定順序 ↔ 繁體中文標籤，一一對映）
EXPR_LABELS_EN = ("neutral", "happiness", "surprise", "sadness",
                  "anger", "disgust", "fear", "contempt")
EXPR_LABELS_ZH = ("中性", "開心", "驚訝", "難過", "生氣", "厭惡", "害怕", "輕蔑")


def ensure_fer_model(verbose: bool = True, check_hash: bool = True) -> dict:
    """確保表情模型檔齊備且通過驗證。回傳各檔絕對路徑 dict。

    Raises:
        RuntimeError: 下載後仍驗證失敗（網路截斷 / 來源異動）。
    """
    paths = {}
    for fname, spec in FER_MODEL_FILES.items():
        fpath = FER_MODEL_DIR / fname
        if not _verify(fpath, spec, check_hash=check_hash):
            if verbose:
                print(f"  下載表情模型檔 {fname}（{spec['size'] / (1 << 20):.0f} MB）...",
                      flush=True)
            _download(BASE_URL + fname, fpath, spec["size"], verbose=verbose)
            if not _verify(fpath, spec, check_hash=True):
                actual = _sha256(fpath) if fpath.exists() else "missing"
                raise RuntimeError(
                    f"表情模型檔驗證失敗：{fname}\n"
                    f"  期望 sha256={spec.get('sha256')} size={spec['size']}\n"
                    f"  實際 sha256={actual} size={fpath.stat().st_size if fpath.exists() else 0}\n"
                    f"  請刪除 {fpath} 後重試，或確認來源 {BASE_URL + fname}"
                )
        paths[fname] = fpath
    return paths


def fer_model_info() -> dict:
    """表情模型現況（供 meta / 狀態 API 用）。"""
    files = {}
    for fname, spec in FER_MODEL_FILES.items():
        p = FER_MODEL_DIR / fname
        files[fname] = {
            "present": p.exists(),
            "size": p.stat().st_size if p.exists() else 0,
            "expected_size": spec["size"],
        }
    return {
        "model": FER_MODEL_NAME,
        "license": "MIT（ONNX Model Zoo emotion_ferplus）",
        "source": BASE_URL + "emotion-ferplus-8.onnx",
        "labels": list(EXPR_LABELS_ZH),
        "input_size": FER_INPUT_SIZE,
        "dir": str(FER_MODEL_DIR),
        "files": files,
    }


if __name__ == "__main__":
    print(f"表情模型目錄：{FER_MODEL_DIR}")
    ensure_fer_model(verbose=True)
    print(json.dumps(fer_model_info(), ensure_ascii=False, indent=2))
    print("表情模型就緒 ✓")
