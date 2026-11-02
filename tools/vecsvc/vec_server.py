# -*- coding: utf-8 -*-
"""
向量检索服务（Qwen3-Embedding-0.6B，自写推理实现）

为什么自己写模型而不是用 transformers：
  你机器上 GPT-SoVITS 的 runtime 是 torch 2.0.0+cu118，而 transformers 4.51.3
  的 qwen3 建模文件依赖 torch.compiler（2.1+）。升 torch 会动到语音功能。
  qwen3_emb.py 里是等价的最小实现，只依赖 torch。

接口：
  GET  /health
  POST /encode   {texts:[], isQuery:bool}
  POST /rebuild  {items:[{id,text,meta}]}    全量重建（带缓存）
  POST /search   {query, topK, minScore}     纯向量检索
  POST /hybrid   {query, keywordScores:{id:score}, topK, wVec}  向量+关键词融合

融合策略来自实测（102 条真实日记 + 20 条人工标注查询）：
  纯关键词 R@5=0.792 / hard 0.389
  纯向量   R@5=0.575 / hard 0.556
  0.3向量+0.7关键词  R@5=0.867 / hard 0.611   ← 选这个
向量单独看不如关键词（词面精确命中在小语料上很强），但它在 hard 集合
（"声音不好听" vs "语音难听"这类零词面重叠）上明显更强，两者互补。
"""

import os
import sys
import json
import time
import hashlib
import argparse
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_HERE = os.path.dirname(os.path.abspath(__file__))
# tokenizers 0.21.4 + transformers 4.51.3 装在 pylibs/，只对本进程生效
_PYLIBS = os.path.join(_HERE, "pylibs")
if os.path.isdir(_PYLIBS):
    sys.path.insert(0, _PYLIBS)
sys.path.insert(0, _HERE)

import numpy as np

# 模型目录按脚本位置推导（tools/vecsvc → ../models/），不写死本机盘符：
# 写死 `E:\...` 既会让隐私扫描把本机路径判成泄露，换台机器 clone 下来也直接跑不起来。
# 模型放在别处时用环境变量 VEC_MODEL_DIR 覆盖。
DEFAULT_MODEL_DIR = os.environ.get("VEC_MODEL_DIR") or os.path.normpath(
    os.path.join(_HERE, "..", "models", "Qwen3-Embedding-0.6B")
)
DEFAULT_CACHE = os.path.join(_HERE, "state", "emb-cache.npz")
MAX_LEN = 512
OUT_DIM = 1024

# 实测融合权重：0.3 向量 + 0.7 关键词 在 R@3/R@5/hard 上都最好
DEFAULT_W_VEC = 0.3


def sha_of(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


class Encoder:
    """right padding + causal attention 的编码器。

    两个必须的细节（都是实测踩出来的）：
      1. Qwen3 是因果模型，注意力必须带因果掩码。用双向 mask 时向量
         完全不报错，但语义是错的 —— 所有查询都会塌缩到同一条日记。
      2. 不能用 left padding。因果掩码下第一个真实 token 的注意力行
         全落在 padding 上，softmax 全 -inf，直接 NaN。
      3. tokenizer 的 post_processor 会自动补 <|endoftext|>，
         对"取最后一个 token"的 pooling 来说它会取代真实末字，
         实测会显著劣化短查询区分度，所以编码前去掉。
    """

    def __init__(self, model_dir=DEFAULT_MODEL_DIR):
        from tokenizers import Tokenizer
        from qwen3_emb import load_model

        self.tok = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        self.pad_id = self.tok.token_to_id("<|endoftext|>") or 0
        self.eos_id = 151643

        t0 = time.time()
        self.model, self.cfg = load_model(model_dir)
        self.load_sec = time.time() - t0
        self.device = "cuda"

    def _ids(self, text):
        ids = self.tok.encode(text).ids
        if ids and ids[-1] == self.eos_id:
            ids = ids[:-1]
        return ids[:MAX_LEN]

    def encode(self, texts, batch_size=32):
        if isinstance(texts, str):
            texts = [texts]
        if not texts:
            return np.zeros((0, OUT_DIM), dtype=np.float32)

        import torch
        import torch.nn.functional as F

        out = []
        with torch.no_grad():
            for i in range(0, len(texts), batch_size):
                chunk = texts[i : i + batch_size]
                encs = [self._ids(t) for t in chunk]
                lens = [max(1, len(e)) for e in encs]
                width = max(lens)
                if width == 0:
                    continue

                ids = [e + [self.pad_id] * (width - len(e)) for e in encs]
                msk = [[1] * len(e) + [0] * (width - len(e)) for e in encs]

                ids_t = torch.tensor(ids, device=self.device, dtype=torch.long)
                msk_t = torch.tensor(msk, device=self.device, dtype=torch.long)
                hidden = self.model(ids_t, msk_t)

                idx = torch.tensor([l - 1 for l in lens], device=self.device)
                pooled = hidden[
                    torch.arange(len(chunk), device=self.device), idx
                ].float()
                out.append(F.normalize(pooled, p=2, dim=1).cpu().numpy())

        return np.vstack(out).astype(np.float32)


class VectorStore:
    def __init__(self, encoder, cache_path):
        self.encoder = encoder
        self.cache_path = cache_path
        self.lock = threading.Lock()
        self.ids, self.meta, self.texts, self.hashes = [], [], [], []
        self.cache = {}
        self.matrix = None
        self._load_cache()

    def _load_cache(self):
        if not os.path.exists(self.cache_path):
            return
        try:
            data = np.load(self.cache_path, allow_pickle=False)
            for k, v in zip(list(data["keys"]), data["vecs"]):
                self.cache[str(k)] = v.astype(np.float32)
            print("[store] 缓存载入 %d 条" % len(self.cache), flush=True)
        except Exception as e:
            print("[store] 缓存载入失败（忽略）: %r" % (e,), flush=True)

    def _save_cache(self):
        try:
            os.makedirs(os.path.dirname(self.cache_path), exist_ok=True)
            if not self.cache:
                return
            keys = np.array(list(self.cache.keys()))
            vecs = np.stack([self.cache[k] for k in keys])
            np.savez_compressed(self.cache_path, keys=keys, vecs=vecs)
        except Exception as e:
            print("[store] 缓存写入失败: %r" % (e,), flush=True)

    def rebuild(self, items):
        with self.lock:
            self.ids, self.meta, self.texts, self.hashes = [], [], [], []
            todo, todo_idx = [], []
            for it in items:
                text = (it.get("text") or "").strip()
                if not text:
                    continue
                h = sha_of(text)
                self.ids.append(str(it.get("id") or ""))
                self.meta.append(it.get("meta") or {})
                self.texts.append(text)
                self.hashes.append(h)
                if h not in self.cache:
                    todo.append(text)
                    todo_idx.append(len(self.hashes) - 1)

            computed = 0
            if todo:
                t0 = time.time()
                vecs = self.encoder.encode(todo)
                computed = len(todo)
                for j, idx in enumerate(todo_idx):
                    self.cache[self.hashes[idx]] = vecs[j]
                print("[store] 新算 %d 条 %.2fs" % (computed, time.time() - t0), flush=True)

            self.matrix = (
                np.stack([self.cache[h] for h in self.hashes]) if self.hashes else None
            )
            self._save_cache()
            return computed, len(self.ids)

    def scores(self, query):
        with self.lock:
            if self.matrix is None or not self.ids:
                return None
            qv = self.encoder.encode([query])[0]
            return self.matrix @ qv

    def topk(self, scores, top_k, filter_meta=None):
        order = np.argsort(-scores)
        res = []
        for idx in order:
            idx = int(idx)
            m = self.meta[idx] or {}
            if filter_meta and any(m.get(k) != v for k, v in filter_meta.items()):
                continue
            res.append(
                {
                    "id": self.ids[idx],
                    "score": round(float(scores[idx]), 6),
                    "meta": m,
                    "text": self.texts[idx][:200],
                }
            )
            if len(res) >= top_k:
                break
        return res

    def size(self):
        return len(self.ids)


def _norm01(arr):
    """min-max 归一化到 [0,1]。保留给 /search 的对外分数展示用。"""
    if arr is None or len(arr) == 0:
        return arr
    mx = float(np.max(arr))
    if mx <= 0:
        return np.zeros_like(arr)
    return arr / mx


def _zscore(arr):
    """z-score 标准化。

    融合用这个而不是 min-max，原因是两者量纲完全不同：
      关键词分是 log1p 累加出来的，头部能到 4.9，尾部 1.6，
      但它**稀疏**（大部分条目为 0）；
      向量分是余弦相似度，稠密地落在 0.2~0.6 的窄区间。
    min-max 下关键词那几个高分条目的相对优势会被放大成压倒性的，
    于是"向量排第 1、关键词只排第 8"的正确语义结果会被挤下去。

    实测（102 条真实日记 + 20 条标注查询，hard 集合是词面零重叠的那批）：
      min-max 0.3/0.7  -> R@5=0.850 hard=0.72
      z-score 0.3/0.7  -> R@5=0.867 hard=0.72
      z-score 0.4/0.6  -> R@1=0.458（最高）但 R@5 略降
    选 0.3/0.7：R@5 最高的同时 R@1 也没掉。
    """
    if arr is None or len(arr) == 0:
        return arr
    mu = float(np.mean(arr))
    sd = float(np.std(arr))
    if sd < 1e-9:
        return np.zeros_like(arr)
    return (arr - mu) / sd


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    store = None
    encoder = None

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(
                {
                    "ok": True,
                    "model": "Qwen3-Embedding-0.6B",
                    "device": self.encoder.device,
                    "dim": OUT_DIM,
                    "count": self.store.size(),
                    "cache": len(self.store.cache),
                    "loadSec": round(self.encoder.load_sec, 2),
                }
            )
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        t0 = time.time()
        try:
            body = self._read()
        except Exception as e:
            return self._json({"error": "bad json: %r" % (e,)}, 400)

        try:
            if self.path.startswith("/encode"):
                texts = body.get("texts") or []
                v = self.encoder.encode(texts)
                return self._json({"vectors": v.tolist()})

            if self.path.startswith("/rebuild"):
                c, t = self.store.rebuild(body.get("items") or [])
                return self._json({"computed": c, "total": t})

            if self.path.startswith("/search"):
                sc = self.store.scores(body.get("query") or "")
                if sc is None:
                    return self._json({"results": [], "elapsedMs": 0})
                cres = self.store.topk(
                    sc,
                    int(body.get("topK") or 5),
                    body.get("filter"),
                )
                return self._json(
                    {
                        "results": cres,
                        "elapsedMs": round((time.time() - t0) * 1000, 2),
                    }
                )

            if self.path.startswith("/hybrid"):
                # 关键词分数由调用方（Node 侧）算好传进来，
                # 这里只做归一化 + 加权融合 —— 关键词打分逻辑的"唯一真源"
                # 仍留在 diary.js，避免两套实现漂移。
                q = body.get("query") or ""
                kws = body.get("keywordScores") or {}
                w_vec = float(body.get("wVec", DEFAULT_W_VEC))
                top_k = int(body.get("topK") or 5)

                vsc = self.store.scores(q)
                if vsc is None:
                    return self._json({"results": [], "elapsedMs": 0})

                karr = np.zeros(len(self.store.ids), dtype=np.float32)
                id2i = {x: i for i, x in enumerate(self.store.ids)}
                for rid, val in kws.items():
                    j = id2i.get(str(rid))
                    if j is not None:
                        karr[j] = float(val)

                fused = (1.0 - w_vec) * _zscore(karr) + w_vec * _zscore(vsc)
                res = self.store.topk(fused, top_k, body.get("filter"))
                return self._json(
                    {
                        "results": res,
                        "wVec": w_vec,
                        "elapsedMs": round((time.time() - t0) * 1000, 2),
                    }
                )
        except Exception as e:
            return self._json({"error": "%s: %s" % (type(e).__name__, e)}, 500)

        return self._json({"error": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9870)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--model", default=DEFAULT_MODEL_DIR)
    ap.add_argument("--cache", default=DEFAULT_CACHE)
    args = ap.parse_args()

    print("[vec] 加载模型 %s" % args.model, flush=True)
    enc = Encoder(args.model)
    print(
        "[vec] 就绪 device=%s loadSec=%.2f" % (enc.device, enc.load_sec), flush=True
    )

    Handler.encoder = enc
    Handler.store = VectorStore(enc, args.cache)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print("[vec] 监听 http://%s:%d/" % (args.host, args.port), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
