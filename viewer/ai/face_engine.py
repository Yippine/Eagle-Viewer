"""人臉引擎：SCRFD 偵測 → 5 點對齊 → ArcFace 512d embedding。

純 onnxruntime + numpy + PIL（不引入 opencv）：
    偵測前處理   等比縮放 + 黑邊 pad 至 640×640，(img-127.5)/128，RGB NCHW
    anchor 解碼  stride {8,16,32} × 2 anchors，distance2bbox / distance2kps（純 numpy）
    NMS          hard-NMS（IoU 0.4，純 numpy）
    對齊         Umeyama similarity transform → PIL Image.transform(AFFINE) warp 至 112×112
    embedding    ArcFace w600k_r50，(img-127.5)/127.5，輸出 L2-normalized 512d

對齊 insightface 官方 scrfd.py / arcface_onnx.py 的數值行為。
"""
import numpy as np
from PIL import Image

from .clip_engine import _import_ort, _l2_normalize
from .face_setup import (ALIGN_SIZE, DET_INPUT_SIZE, FACE_EMBED_DIM,
                         FACE_MODEL_DIR, FACE_MODEL_NAME, ensure_face_model)

# ArcFace 112×112 標準 5 點模板（insightface face_align.py arcface_dst）
_ARCFACE_DST = np.array([
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
], dtype=np.float32)

_STRIDES     = (8, 16, 32)
_NUM_ANCHORS = 2


# ---------------------------------------------------------------------------
# 純 numpy 幾何工具
# ---------------------------------------------------------------------------

def _distance2bbox(points: np.ndarray, distance: np.ndarray) -> np.ndarray:
    """anchor 中心 + 四向距離 → (x1, y1, x2, y2)。"""
    return np.stack([
        points[:, 0] - distance[:, 0],
        points[:, 1] - distance[:, 1],
        points[:, 0] + distance[:, 2],
        points[:, 1] + distance[:, 3],
    ], axis=-1)


def _distance2kps(points: np.ndarray, distance: np.ndarray) -> np.ndarray:
    """anchor 中心 + 10 維偏移 → (N, 5, 2) landmark。"""
    out = np.empty_like(distance)
    out[:, 0::2] = points[:, 0:1] + distance[:, 0::2]
    out[:, 1::2] = points[:, 1:2] + distance[:, 1::2]
    return out.reshape(-1, 5, 2)


def _nms(dets: np.ndarray, iou_thresh: float = 0.4) -> list:
    """hard-NMS。dets: (N, 5) = x1,y1,x2,y2,score（已按 score 降冪）。"""
    x1, y1, x2, y2, scores = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = np.arange(len(dets))
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1 + 1)
        h = np.maximum(0.0, yy2 - yy1 + 1)
        inter = w * h
        iou = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[1:][iou <= iou_thresh]
    return keep


def _umeyama_similarity(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Umeyama 最小平方 similarity transform（scale+rot+trans，無鏡射）。

    Returns:
        (2, 3) 矩陣 M：dst ≈ M @ [src; 1]
    """
    src = src.astype(np.float64)
    dst = dst.astype(np.float64)
    n = src.shape[0]
    src_mean = src.mean(axis=0)
    dst_mean = dst.mean(axis=0)
    src_d = src - src_mean
    dst_d = dst - dst_mean
    cov = dst_d.T @ src_d / n
    U, S, Vt = np.linalg.svd(cov)
    d = np.ones(2)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        d[1] = -1
    R = U @ np.diag(d) @ Vt
    var_src = (src_d ** 2).sum() / n
    scale = (S * d).sum() / max(var_src, 1e-12)
    t = dst_mean - scale * (R @ src_mean)
    M = np.empty((2, 3), dtype=np.float64)
    M[:, :2] = scale * R
    M[:, 2] = t
    return M


def _warp_align(im: Image.Image, kps: np.ndarray, size: int = ALIGN_SIZE) -> Image.Image:
    """依 5 點 landmark 相似變換對齊至 size×size（PIL AFFINE = 逆變換係數）。"""
    M = _umeyama_similarity(kps, _ARCFACE_DST * (size / 112.0))
    M3 = np.vstack([M, [0.0, 0.0, 1.0]])
    inv = np.linalg.inv(M3)     # 輸出座標 → 輸入座標
    coeffs = (inv[0, 0], inv[0, 1], inv[0, 2], inv[1, 0], inv[1, 1], inv[1, 2])
    return im.transform((size, size), Image.AFFINE, coeffs, resample=Image.BILINEAR)


# ---------------------------------------------------------------------------
# 引擎
# ---------------------------------------------------------------------------

class FaceEngine:
    """SCRFD + ArcFace onnxruntime session 管理。lazy 建構。"""

    def __init__(self, model_dir=None, providers=None,
                 det_thresh: float = 0.5, nms_thresh: float = 0.4):
        self.model_dir = model_dir or FACE_MODEL_DIR
        self.providers = providers
        self.model_name = FACE_MODEL_NAME
        self.embed_dim = FACE_EMBED_DIM
        self.det_thresh = det_thresh
        self.nms_thresh = nms_thresh
        self._ort = None
        self._det = None
        self._rec = None
        self._center_cache = {}

    def _session(self, onnx_name: str):
        ort = self._ort or _import_ort()
        self._ort = ort
        ensure_face_model(verbose=True, check_hash=False)   # 熱路徑僅驗大小
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        providers = self.providers or ["CPUExecutionProvider"]
        return ort.InferenceSession(str(self.model_dir / onnx_name),
                                    sess_options=opts, providers=providers)

    @property
    def det(self):
        if self._det is None:
            self._det = self._session("det_10g.onnx")
        return self._det

    @property
    def rec(self):
        if self._rec is None:
            self._rec = self._session("w600k_r50.onnx")
        return self._rec

    # ── 偵測 ────────────────────────────────────────────────────────────────
    def _anchor_centers(self, stride: int, h: int, w: int) -> np.ndarray:
        key = (stride, h, w)
        if key not in self._center_cache:
            grid = np.stack(np.mgrid[:h, :w][::-1], axis=-1).astype(np.float32)  # (h,w,2) x,y
            centers = (grid * stride).reshape(-1, 2)
            centers = np.stack([centers] * _NUM_ANCHORS, axis=1).reshape(-1, 2)
            self._center_cache[key] = centers
        return self._center_cache[key]

    def detect(self, im: Image.Image, max_faces: int = None) -> list:
        """偵測人臉。

        Args:
            im: PIL Image（任意尺寸，內部等比縮放至 640×640）

        Returns:
            [{bbox: [x1,y1,x2,y2], kps: (5,2) ndarray, det_score: float}, ...]
            依 det_score 降冪；座標為原圖像素座標。
        """
        im = im.convert("RGB")
        w0, h0 = im.size
        size = DET_INPUT_SIZE
        if h0 >= w0:
            nh, nw = size, max(1, int(round(size * w0 / h0)))
        else:
            nw, nh = size, max(1, int(round(size * h0 / w0)))
        det_scale = nh / h0
        canvas = Image.new("RGB", (size, size), (0, 0, 0))
        canvas.paste(im.resize((nw, nh), Image.BILINEAR), (0, 0))

        arr = np.asarray(canvas, dtype=np.float32)               # (H, W, 3) RGB
        blob = ((arr - 127.5) / 128.0).transpose(2, 0, 1)[None]  # (1, 3, H, W)

        sess = self.det
        input_name = sess.get_inputs()[0].name
        outs = sess.run(None, {input_name: blob})

        fmc = len(_STRIDES)
        scores_all, bboxes_all, kps_all = [], [], []
        for i, stride in enumerate(_STRIDES):
            scores = np.squeeze(outs[i])                     # (N,)
            bbox   = outs[i + fmc]
            kps    = outs[i + fmc * 2]
            bbox = bbox.reshape(-1, 4) * stride
            kps  = kps.reshape(-1, 10) * stride
            centers = self._anchor_centers(stride, size // stride, size // stride)
            idx = np.where(scores >= self.det_thresh)[0]
            if len(idx) == 0:
                continue
            scores_all.append(scores[idx])
            bboxes_all.append(_distance2bbox(centers, bbox)[idx])
            kps_all.append(_distance2kps(centers, kps)[idx])

        if not scores_all:
            return []
        scores = np.concatenate(scores_all)
        bboxes = np.concatenate(bboxes_all) / det_scale
        kpss   = np.concatenate(kps_all) / det_scale

        order = scores.argsort()[::-1]
        dets = np.hstack([bboxes[order], scores[order, None]]).astype(np.float32)
        keep = _nms(dets, self.nms_thresh)
        kpss = kpss[order][keep]

        faces = []
        for j, k in enumerate(keep):
            faces.append({
                "bbox": dets[k, :4].tolist(),
                "kps": kpss[j],
                "det_score": float(dets[k, 4]),
            })
        if max_faces is not None:
            faces = faces[:max_faces]
        return faces

    # ── embedding ───────────────────────────────────────────────────────────
    def embed(self, im: Image.Image, kps_list: list) -> np.ndarray:
        """對齊 + ArcFace 批次編碼。

        Args:
            kps_list: [(5,2) ndarray, ...]（同一張 im 上的多臉 landmark）

        Returns:
            float32 (n_faces, 512)，L2-normalized。
        """
        if not kps_list:
            return np.zeros((0, self.embed_dim), dtype=np.float32)
        im = im.convert("RGB")
        crops = []
        for kps in kps_list:
            aligned = _warp_align(im, np.asarray(kps, dtype=np.float32))
            arr = np.asarray(aligned, dtype=np.float32)
            crops.append(((arr - 127.5) / 127.5).transpose(2, 0, 1))
        blob = np.stack(crops)                                    # (n, 3, 112, 112)
        sess = self.rec
        input_name = sess.get_inputs()[0].name
        out = sess.run(None, {input_name: blob})[0].astype(np.float32)
        return _l2_normalize(out)

    def detect_and_embed(self, path, max_faces: int = 16, min_size: int = 20) -> list:
        """單張影像端到端：開檔 → 偵測 → 對齊 → embedding。

        Args:
            max_faces: 每張圖最多取前 N 張臉（det_score 降冪）
            min_size:  bbox 短邊小於 N px（原圖座標）者捨棄

        Returns:
            [{bbox, kps: [[x,y]×5], det_score, embedding: (512,) float32}, ...]
            開檔/解碼失敗會拋例外（由呼叫端接）。
        """
        with Image.open(path) as raw:
            raw.draft("RGB", (DET_INPUT_SIZE * 2, DET_INPUT_SIZE * 2))  # JPEG 加速解碼
            im = raw.convert("RGB")
        faces = self.detect(im, max_faces=max_faces)
        faces = [f for f in faces
                 if min(f["bbox"][2] - f["bbox"][0], f["bbox"][3] - f["bbox"][1]) >= min_size]
        if not faces:
            return []
        embs = self.embed(im, [f["kps"] for f in faces])
        for f, e in zip(faces, embs):
            f["embedding"] = e
            f["kps"] = np.asarray(f["kps"]).round(2).tolist()
        return faces


_default_face_engine = None


def get_face_engine() -> FaceEngine:
    """模組級單例。"""
    global _default_face_engine
    if _default_face_engine is None:
        _default_face_engine = FaceEngine()
    return _default_face_engine
