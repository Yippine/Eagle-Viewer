"""onnxruntime 推論封裝：Chinese-CLIP 影像 / 文字編碼。

encode_images(paths)  → float32 (N, 512)，L2-normalized（失敗者回報 index）
encode_text(query)    → float32 (512,)，L2-normalized

前處理對齊 OFA-Sys cn_clip 官方 transform：
    RGB → Resize((224, 224), BICUBIC) 直接壓縮（squash，不裁切）
    → /255 → Normalize(CLIP mean/std) → NCHW float32
onnxruntime 未安裝時 raise RuntimeError（明確安裝指引），不靜默降級。
"""
import numpy as np
from PIL import Image

from .model_setup import EMBED_DIM, IMAGE_SIZE, MODEL_DIR, MODEL_NAME, ensure_model
from .tokenizer import BertWordPieceTokenizer

_CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32).reshape(3, 1, 1)
_CLIP_STD  = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32).reshape(3, 1, 1)


def _import_ort():
    try:
        import onnxruntime as ort
        return ort
    except ImportError as e:
        raise RuntimeError(
            "onnxruntime 未安裝，AI 語意搜尋無法使用。\n"
            "  安裝：pip install --user onnxruntime\n"
            "  （Debian/Ubuntu 遇 PEP 668 時：pip install --user --break-system-packages onnxruntime；\n"
            "    Windows 側可改裝 onnxruntime-directml 啟用 GPU 加速）"
        ) from e


def _l2_normalize(v: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(norm, 1e-12)


def _preprocess_pil(im: Image.Image) -> np.ndarray:
    """已載入的 PIL.Image → float32 (3, 224, 224)（服裝辨識 person crop 記憶體內編碼用）。"""
    im = im.convert("RGB").resize((IMAGE_SIZE, IMAGE_SIZE), Image.BICUBIC)
    arr = np.asarray(im, dtype=np.float32) / 255.0               # (H, W, 3)
    arr = arr.transpose(2, 0, 1)                                  # (3, H, W)
    return (arr - _CLIP_MEAN) / _CLIP_STD


def _preprocess_image(path) -> np.ndarray:
    """單張影像路徑 → float32 (3, 224, 224)。開檔/解碼失敗會拋例外（由呼叫端接）。"""
    with Image.open(path) as im:
        return _preprocess_pil(im)


class ClipEngine:
    """onnxruntime session 管理 + 編碼。lazy 建構（首次使用才載入 .onnx）。"""

    def __init__(self, model_dir=None, providers=None):
        self.model_dir = model_dir or MODEL_DIR
        self.providers = providers        # None → onnxruntime 預設（CPU EP）
        self.model_name = MODEL_NAME
        self.embed_dim = EMBED_DIM
        self._ort = None
        self._visual = None
        self._text = None
        self._tokenizer = None

    # ── lazy loaders ────────────────────────────────────────────────────────
    def _session(self, onnx_name: str):
        ort = self._ort or _import_ort()
        self._ort = ort
        # 熱路徑僅驗檔案大小（快）；完整 sha256 驗證走 `cli setup`
        ensure_model(verbose=True, check_hash=False)
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        providers = self.providers or ["CPUExecutionProvider"]
        return ort.InferenceSession(str(self.model_dir / onnx_name),
                                    sess_options=opts, providers=providers)

    @property
    def visual(self):
        if self._visual is None:
            self._visual = self._session("visual.onnx")
        return self._visual

    @property
    def text(self):
        if self._text is None:
            self._text = self._session("text.onnx")
        return self._text

    @property
    def tokenizer(self) -> BertWordPieceTokenizer:
        if self._tokenizer is None:
            ensure_model(verbose=True, check_hash=False)
            self._tokenizer = BertWordPieceTokenizer(self.model_dir / "vocab.txt")
        return self._tokenizer

    # ── 影像編碼 ────────────────────────────────────────────────────────────
    def encode_images(self, paths: list, batch_size: int = 16):
        """批次編碼影像。

        Returns:
            (vecs, failed): vecs 為 float32 (N_ok, 512) L2-normalized；
            failed 為 paths 中失敗項的 index list（讀檔/解碼錯誤，已跳過）。
        """
        sess = self.visual
        input_name = sess.get_inputs()[0].name
        chunks, failed = [], []
        batch_arr, batch_idx = [], []

        def _flush():
            if not batch_arr:
                return
            x = np.stack(batch_arr)
            out = sess.run(None, {input_name: x})[0].astype(np.float32)
            chunks.append(_l2_normalize(out))
            batch_arr.clear()
            batch_idx.clear()

        for i, p in enumerate(paths):
            try:
                batch_arr.append(_preprocess_image(p))
                batch_idx.append(i)
            except Exception:
                failed.append(i)
                continue
            if len(batch_arr) >= batch_size:
                _flush()
        _flush()

        if chunks:
            vecs = np.concatenate(chunks, axis=0)
        else:
            vecs = np.zeros((0, self.embed_dim), dtype=np.float32)
        return vecs, failed

    def encode_pil_images(self, images: list, batch_size: int = 16):
        """批次編碼記憶體內 PIL.Image list（服裝辨識 person crop 用，禁止落地暫存檔）。

        Returns:
            (vecs, failed): vecs 為 float32 (N_ok, 512) L2-normalized；
            failed 為 images 中失敗項的 index list（轉換錯誤，已跳過）。
        """
        sess = self.visual
        input_name = sess.get_inputs()[0].name
        chunks, failed = [], []
        batch_arr = []

        def _flush():
            if not batch_arr:
                return
            x = np.stack(batch_arr)
            out = sess.run(None, {input_name: x})[0].astype(np.float32)
            chunks.append(_l2_normalize(out))
            batch_arr.clear()

        for i, im in enumerate(images):
            try:
                batch_arr.append(_preprocess_pil(im))
            except Exception:
                failed.append(i)
                continue
            if len(batch_arr) >= batch_size:
                _flush()
        _flush()

        if chunks:
            vecs = np.concatenate(chunks, axis=0)
        else:
            vecs = np.zeros((0, self.embed_dim), dtype=np.float32)
        return vecs, failed

    # ── 文字編碼 ────────────────────────────────────────────────────────────
    def encode_texts(self, queries: list) -> np.ndarray:
        """→ float32 (M, 512)，L2-normalized。"""
        sess = self.text
        enc = [self.tokenizer.encode(q) for q in queries]
        feeds = {
            "input_ids":      np.array([e["input_ids"] for e in enc], dtype=np.int64),
            "attention_mask": np.array([e["attention_mask"] for e in enc], dtype=np.int64),
            "token_type_ids": np.array([e["token_type_ids"] for e in enc], dtype=np.int64),
        }
        # 對齊模型實際輸入名（有些匯出省略 token_type_ids）
        want = {i.name for i in sess.get_inputs()}
        feeds = {k: v for k, v in feeds.items() if k in want}
        out = sess.run(None, feeds)[0].astype(np.float32)
        return _l2_normalize(out)

    def encode_text(self, query: str) -> np.ndarray:
        """單一查詢 → float32 (512,)，L2-normalized。"""
        return self.encode_texts([query])[0]


_default_engine = None


def get_engine() -> ClipEngine:
    """模組級單例（session 載入約需數秒，重複建構浪費）。"""
    global _default_engine
    if _default_engine is None:
        _default_engine = ClipEngine()
    return _default_engine
