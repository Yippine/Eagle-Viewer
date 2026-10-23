"""人物偵測（服裝辨識前置）：YOLOX-Tiny ONNX 對整張影像偵測 person bbox。

前處理（YOLOX 官方 ONNXRuntime demo 慣例）：letterbox 等比縮放 + 114 灰底
填滿至 416×416，**不做 /255 或 mean/std 正規化**（訓練用 cv2 BGR 0–255 原值）；
本模組以 PIL 讀圖（RGB），送入模型前反轉通道為 BGR 以對齊訓練慣例。

後處理：純 numpy 依 grids/strides（8/16/32）解碼 cx,cy,w,h → xyxy，
score = obj_conf × cls_conf[person]，門檻 CONF_THRESH 後純 numpy NMS
（IoU ≥ NMS_IOU 抑制），依面積降冪只取前 MAX_PERSONS 個。

禁 opencv/torch（比照 face_engine 純 numpy 風格）；onnxruntime CPUExecutionProvider。
紅線：僅推論既有影像，不寫回媒體檔；模型/session 皆唯讀本模組自有資產。
"""
import numpy as np
from PIL import Image

from . import _VIEWER_DIR  # noqa: F401
from .person_setup import (PERSON_CLASS_ID, PERSON_INPUT_SIZE, PERSON_MODEL_DIR,
                           PERSON_MODEL_NAME, PERSON_STRIDES, ensure_person_model)

CONF_THRESH  = 0.5     # obj_conf * cls_conf[person] 最低分數
NMS_IOU      = 0.45    # NMS 抑制門檻
MAX_PERSONS  = 6       # 每圖最多取幾個 person bbox（面積降冪）


# ---------------------------------------------------------------------------
# 前處理：letterbox（純 PIL + numpy，不用 opencv）
# ---------------------------------------------------------------------------

def _letterbox(im: Image.Image, size: int = PERSON_INPUT_SIZE):
    """RGB PIL 影像 → (float32 (3,size,size) BGR 0-255, scale_ratio)。

    等比縮放使長邊貼齊 size，短邊以 114 灰底補滿（右/下），與 YOLOX 訓練前處理
    對齊；回傳的 ratio 供還原偵測框座標回原圖尺度。
    """
    w, h = im.size
    r = min(size / h, size / w)
    nw, nh = int(round(w * r)), int(round(h * r))
    resized = im.resize((max(nw, 1), max(nh, 1)), Image.BILINEAR)
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    canvas.paste(resized, (0, 0))
    arr = np.asarray(canvas, dtype=np.float32)          # (H, W, 3) RGB 0-255
    arr = arr[:, :, ::-1]                                # RGB → BGR（訓練慣例）
    arr = arr.transpose(2, 0, 1)                         # (3, H, W)
    return np.ascontiguousarray(arr), r


# ---------------------------------------------------------------------------
# 後處理：grids/strides 解碼 + 純 numpy NMS
# ---------------------------------------------------------------------------

_grids_cache: dict = {}   # (size, strides) → (grids (1,N,2), expanded_strides (1,N,1))


def _build_grids(size: int, strides=PERSON_STRIDES):
    key = (size, strides)
    hit = _grids_cache.get(key)
    if hit is not None:
        return hit
    grids, exp_strides = [], []
    for stride in strides:
        hsize = wsize = size // stride
        xv, yv = np.meshgrid(np.arange(wsize), np.arange(hsize))
        grid = np.stack((xv, yv), axis=2).reshape(1, -1, 2)
        grids.append(grid)
        exp_strides.append(np.full((1, grid.shape[1], 1), stride, dtype=np.float32))
    out = (np.concatenate(grids, axis=1).astype(np.float32),
           np.concatenate(exp_strides, axis=1))
    _grids_cache[key] = out
    return out


def _decode(raw: np.ndarray, size: int = PERSON_INPUT_SIZE) -> np.ndarray:
    """raw (N,85) → (N,85) 就地解碼前 4 欄為輸入影像座標系 xywh（未還原letterbox）。"""
    grids, strides = _build_grids(size)
    out = raw.copy()
    out[..., 0:2] = (out[..., 0:2] + grids[0]) * strides[0]
    out[..., 2:4] = np.exp(out[..., 2:4]) * strides[0]
    return out


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thresh: float) -> list:
    """純 numpy 貪婪 NMS（比照 face_engine 風格）。boxes 為 xyxy。→ 保留 index list。"""
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        union = areas[i] + areas[order[1:]] - inter
        iou = np.where(union > 0, inter / union, 0.0)
        order = order[1:][iou <= iou_thresh]
    return keep


# ---------------------------------------------------------------------------
# 引擎（單一 onnx session；lazy 建構，模式比照 FerEngine）
# ---------------------------------------------------------------------------

class PersonDetector:
    """YOLOX-Tiny onnxruntime session 管理 + 偵測。"""

    def __init__(self, model_dir=None, providers=None):
        self.model_dir = model_dir or PERSON_MODEL_DIR
        self.providers = providers
        self.model_name = PERSON_MODEL_NAME
        self._sess = None
        self._input_name = None

    @property
    def sess(self):
        if self._sess is None:
            from .clip_engine import _import_ort
            ort = _import_ort()
            ensure_person_model(verbose=True, check_hash=False)   # 熱路徑僅驗大小
            opts = ort.SessionOptions()
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            providers = self.providers or ["CPUExecutionProvider"]
            self._sess = ort.InferenceSession(
                str(self.model_dir / "yolox_tiny.onnx"),
                sess_options=opts, providers=providers)
            self._input_name = self._sess.get_inputs()[0].name
        return self._sess

    def detect(self, im: Image.Image, conf_thresh: float = CONF_THRESH,
              nms_iou: float = NMS_IOU, max_persons: int = MAX_PERSONS) -> list:
        """RGB PIL 影像 → [{bbox:[x1,y1,x2,y2], score}, ...]（面積降冪，最多 max_persons 個）。

        bbox 座標為原圖像素座標系（letterbox ratio 已還原）。
        """
        size = PERSON_INPUT_SIZE
        arr, ratio = _letterbox(im, size)
        sess = self.sess
        raw = sess.run(None, {self._input_name: arr[None]})[0][0]   # (3549, 85)
        dec = _decode(raw, size)
        obj = dec[:, 4]
        cls_score = dec[:, 5 + PERSON_CLASS_ID]
        scores = obj * cls_score
        mask = scores >= conf_thresh
        if not np.any(mask):
            return []
        boxes_cxcywh = dec[mask, 0:4]
        scores = scores[mask]
        cx, cy, w, h = (boxes_cxcywh[:, 0], boxes_cxcywh[:, 1],
                        boxes_cxcywh[:, 2], boxes_cxcywh[:, 3])
        x1, y1 = cx - w / 2.0, cy - h / 2.0
        x2, y2 = cx + w / 2.0, cy + h / 2.0
        boxes = np.stack([x1, y1, x2, y2], axis=1) / ratio    # letterbox → 原圖座標

        keep = _nms(boxes, scores, nms_iou)
        boxes, scores = boxes[keep], scores[keep]

        img_w, img_h = im.size
        boxes[:, 0] = np.clip(boxes[:, 0], 0, img_w)
        boxes[:, 1] = np.clip(boxes[:, 1], 0, img_h)
        boxes[:, 2] = np.clip(boxes[:, 2], 0, img_w)
        boxes[:, 3] = np.clip(boxes[:, 3], 0, img_h)

        areas = np.maximum(0.0, boxes[:, 2] - boxes[:, 0]) * \
                np.maximum(0.0, boxes[:, 3] - boxes[:, 1])
        order = areas.argsort()[::-1][:max_persons]
        out = []
        for i in order:
            out.append({"bbox": [round(float(v), 1) for v in boxes[i]],
                        "score": round(float(scores[i]), 4)})
        return out


_default_person_detector = None


def get_person_detector() -> PersonDetector:
    """模組級單例。"""
    global _default_person_detector
    if _default_person_detector is None:
        _default_person_detector = PersonDetector()
    return _default_person_detector
