"""Chinese-CLIP 文字端 tokenizer——BERT WordPiece 純 Python 實作（零依賴）。

Chinese-CLIP 的 text encoder 為 chinese-roberta-wwm 系 BERT，詞表 vocab.txt
（21,128 tokens）隨模型下載。行為對齊 BertTokenizer(do_lower_case=True)：
    BasicTokenizer（lowercase + NFD 去重音 + CJK 逐字切 + 標點切分）
    → WordPiece（greedy longest-match-first，## 續接）
輸出對齊 ONNX text encoder 輸入：input_ids / attention_mask / token_type_ids，
固定長度 context_length=52（[CLS] … [SEP] + [PAD] 補齊）。
"""
import unicodedata
from pathlib import Path

from .model_setup import CONTEXT_LENGTH


def _is_whitespace(ch: str) -> bool:
    if ch in (" ", "\t", "\n", "\r"):
        return True
    return unicodedata.category(ch) == "Zs"


def _is_control(ch: str) -> bool:
    if ch in ("\t", "\n", "\r"):
        return False
    return unicodedata.category(ch).startswith("C")


def _is_punctuation(ch: str) -> bool:
    cp = ord(ch)
    # ASCII 非字母數字一律視為標點（與 BERT 一致，含 $ ` ~ 等）
    if 33 <= cp <= 47 or 58 <= cp <= 64 or 91 <= cp <= 96 or 123 <= cp <= 126:
        return True
    return unicodedata.category(ch).startswith("P")


def _is_cjk(cp: int) -> bool:
    return (
        0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF
        or 0x20000 <= cp <= 0x2A6DF or 0x2A700 <= cp <= 0x2B73F
        or 0x2B740 <= cp <= 0x2B81F or 0x2B820 <= cp <= 0x2CEAF
        or 0xF900 <= cp <= 0xFAFF or 0x2F800 <= cp <= 0x2FA1F
    )


class BertWordPieceTokenizer:
    """對齊 HuggingFace BertTokenizer（do_lower_case=True）的最小實作。"""

    def __init__(self, vocab_path: Path, context_length: int = CONTEXT_LENGTH):
        self.vocab: dict = {}
        with open(vocab_path, encoding="utf-8") as f:
            for i, line in enumerate(f):
                token = line.rstrip("\n")
                if token:
                    self.vocab[token] = i
        self.context_length = context_length
        self.cls_id = self.vocab["[CLS]"]
        self.sep_id = self.vocab["[SEP]"]
        self.pad_id = self.vocab.get("[PAD]", 0)
        self.unk_token = "[UNK]"
        self.max_chars_per_word = 100

    # ── BasicTokenizer ──────────────────────────────────────────────────────
    def _clean(self, text: str) -> str:
        out = []
        for ch in text:
            cp = ord(ch)
            if cp == 0 or cp == 0xFFFD or _is_control(ch):
                continue
            out.append(" " if _is_whitespace(ch) else ch)
        return "".join(out)

    def _spread_cjk(self, text: str) -> str:
        out = []
        for ch in text:
            if _is_cjk(ord(ch)):
                out.append(f" {ch} ")
            else:
                out.append(ch)
        return "".join(out)

    def _strip_accents(self, text: str) -> str:
        return "".join(ch for ch in unicodedata.normalize("NFD", text)
                       if unicodedata.category(ch) != "Mn")

    def _split_punct(self, token: str) -> list:
        pieces, cur = [], []
        for ch in token:
            if _is_punctuation(ch):
                if cur:
                    pieces.append("".join(cur))
                    cur = []
                pieces.append(ch)
            else:
                cur.append(ch)
        if cur:
            pieces.append("".join(cur))
        return pieces

    def _basic_tokenize(self, text: str) -> list:
        text = self._spread_cjk(self._clean(text))
        tokens = []
        for tok in text.split():
            tok = self._strip_accents(tok.lower())
            tokens.extend(self._split_punct(tok))
        return [t for t in tokens if t]

    # ── WordPiece ───────────────────────────────────────────────────────────
    def _wordpiece(self, token: str) -> list:
        if len(token) > self.max_chars_per_word:
            return [self.unk_token]
        out, start = [], 0
        while start < len(token):
            end, cur = len(token), None
            while start < end:
                sub = token[start:end]
                if start > 0:
                    sub = "##" + sub
                if sub in self.vocab:
                    cur = sub
                    break
                end -= 1
            if cur is None:
                return [self.unk_token]
            out.append(cur)
            start = end
        return out

    # ── 公開 API ────────────────────────────────────────────────────────────
    def tokenize(self, text: str) -> list:
        out = []
        for tok in self._basic_tokenize(text):
            out.extend(self._wordpiece(tok))
        return out

    def encode(self, text: str) -> dict:
        """→ {input_ids, attention_mask, token_type_ids}，各為長度 context_length 的 list[int]。"""
        L = self.context_length
        ids = [self.vocab.get(t, self.vocab[self.unk_token]) for t in self.tokenize(text)]
        ids = [self.cls_id] + ids[: L - 2] + [self.sep_id]
        n = len(ids)
        ids += [self.pad_id] * (L - n)
        return {
            "input_ids": ids,
            "attention_mask": [1] * n + [0] * (L - n),
            "token_type_ids": [0] * L,
        }
