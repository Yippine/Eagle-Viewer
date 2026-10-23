"""Eagle Viewer AI 語意搜尋 package（P6-I1：CLIP 語意索引器）。

模組佈局：
    model_setup.py  模型下載/驗證（Chinese-CLIP ViT-B/16 ONNX）
    tokenizer.py    BERT WordPiece tokenizer（純 Python，零依賴）
    clip_engine.py  onnxruntime 推論封裝（encode_image / encode_text）
    indexer.py      批次索引器（斷點續跑 + 增量）
    search.py       cosine top-k 查詢（單庫 / 跨庫）
    cli.py          命令列入口（python3 -m viewer.ai.cli ...）

P6-I3 人臉 pipeline：
    face_setup.py   人臉模型下載/驗證（InsightFace buffalo_l：SCRFD + ArcFace）
    face_engine.py  SCRFD 偵測 + 5 點對齊 + ArcFace 512d embedding（純 numpy/PIL）
    face_indexer.py 人臉批次索引（faces.npy + faces_meta.json，斷點續跑）
    face_cluster.py DBSCAN 人物聚類 → persons.json（重跑不重算 embedding）
    face_search.py  以臉找臉（單庫 / 跨庫 top-k）

viewer/ 既有模組（config.py / excire.py …）採平面 import 風格（serve.py 於
viewer/ 目錄內執行）。本 package 可能從專案根目錄以 `python3 -m viewer.ai.cli`
執行，此時 viewer/ 不在 sys.path 上——故於此打平，讓 `import config` 等
平面 import 在兩種執行情境下都成立。
"""
import sys
from pathlib import Path

_VIEWER_DIR = str(Path(__file__).resolve().parent.parent)
if _VIEWER_DIR not in sys.path:
    sys.path.insert(0, _VIEWER_DIR)
