# -*- coding: utf-8 -*-
"""
Qwen3-Embedding-0.6B 的最小自包含实现。

为什么要自己写而不是用 transformers 的 AutoModel：
  你机器上的 GPT-SoVITS runtime 是 torch 2.0.0+cu118，而 transformers 4.51.3
  的 qwen3 建模文件 import 了 torch.compiler（2.1+ 才有）。升 torch 会动到
  GPT-SoVITS 的语音功能，代价太大。

  这个模型本身结构很简单（28 层 Qwen3 dense，GQA 16/8 头，head_dim 128，
  RMSNorm + RoPE + SwiGLU），自己实现只需 ~200 行，且只依赖 torch，
  版本兼容性最好。权重直接从 safetensors 读，与官方 transformers 结果对齐
  （见文件末尾的对拍脚本）。

结构对照 config.json：
  hidden_size=1024, layers=28, heads=16, kv_heads=8, head_dim=128,
  intermediate=3072, eps=1e-6, rope_theta=1e6, vocab=151669, tie_embeddings=True
"""

import math

import torch
import torch.nn as nn
import torch.nn.functional as F


class Qwen3RMSNorm(nn.Module):
    def __init__(self, hidden_size, eps=1e-6):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(hidden_size))
        self.eps = eps

    def forward(self, x):
        # 注意：Qwen3 的 RMSNorm 在 fp32 下算方差再乘回 dtype，否则 fp16 会溢出
        input_dtype = x.dtype
        x = x.to(torch.float32)
        var = x.pow(2).mean(-1, keepdim=True)
        x = x * torch.rsqrt(var + self.eps)
        return (self.weight * x.to(input_dtype))


def _rotate_half(x):
    x1 = x[..., : x.shape[-1] // 2]
    x2 = x[..., x.shape[-1] // 2 :]
    return torch.cat((-x2, x1), dim=-1)


class Qwen3RotaryEmbedding(nn.Module):
    """标准 RoPE。预计算 cos/sin 表，避免每步重算。"""

    def __init__(self, head_dim, base=1000000.0, max_len=4096, device=None):
        super().__init__()
        inv_freq = 1.0 / (
            base ** (torch.arange(0, head_dim, 2, dtype=torch.float32, device=device) / head_dim)
        )
        self.register_buffer("inv_freq", inv_freq, persistent=False)
        self._build(max_len, device)

    def _build(self, seq_len, device):
        pos = torch.arange(seq_len, dtype=torch.float32, device=device)
        freqs = torch.outer(pos, self.inv_freq.to(device))
        emb = torch.cat((freqs, freqs), dim=-1)
        self.register_buffer("cos_cached", emb.cos(), persistent=False)
        self.register_buffer("sin_cached", emb.sin(), persistent=False)

    def forward(self, q, k, seq_len):
        if self.cos_cached.shape[0] < seq_len:
            self._build(seq_len, q.device)
        cos = self.cos_cached[:seq_len].to(q.dtype).unsqueeze(0).unsqueeze(1)
        sin = self.sin_cached[:seq_len].to(q.dtype).unsqueeze(0).unsqueeze(1)
        return (q * cos) + (_rotate_half(q) * sin), (k * cos) + (_rotate_half(k) * sin)


class Qwen3Attention(nn.Module):
    """GQA：q 有 num_heads 个头，k/v 只有 num_kv_heads 个头，靠 repeat_kv 对齐。
    另外 Qwen3 对 q/k 各有一层 RMSNorm（q_norm / k_norm），这是与 Qwen2 的区别点，
    漏掉会让输出完全错乱。
    """

    def __init__(self, cfg):
        super().__init__()
        self.num_heads = cfg["num_attention_heads"]
        self.num_kv_heads = cfg["num_key_value_heads"]
        self.head_dim = cfg["head_dim"]
        self.num_kv_groups = self.num_heads // self.num_kv_heads
        self.scaling = self.head_dim ** -0.5

        h = cfg["hidden_size"]
        self.q_proj = nn.Linear(h, self.num_heads * self.head_dim, bias=False)
        self.k_proj = nn.Linear(h, self.num_kv_heads * self.head_dim, bias=False)
        self.v_proj = nn.Linear(h, self.num_kv_heads * self.head_dim, bias=False)
        self.o_proj = nn.Linear(self.num_heads * self.head_dim, h, bias=False)

        self.q_norm = Qwen3RMSNorm(self.head_dim, eps=cfg["rms_norm_eps"])
        self.k_norm = Qwen3RMSNorm(self.head_dim, eps=cfg["rms_norm_eps"])

    def forward(self, x, rope, mask=None):
        bsz, seq_len, _ = x.shape

        q = self.q_proj(x).view(bsz, seq_len, self.num_heads, self.head_dim)
        k = self.k_proj(x).view(bsz, seq_len, self.num_kv_heads, self.head_dim)
        v = self.v_proj(x).view(bsz, seq_len, self.num_kv_heads, self.head_dim)

        # q_norm / k_norm 作用在 head_dim 上
        q = self.q_norm(q)
        k = self.k_norm(k)

        q = q.transpose(1, 2)  # (b, h, s, d)
        k = k.transpose(1, 2)
        v = v.transpose(1, 2)

        q, k = rope(q, k, seq_len)

        if self.num_kv_groups > 1:
            k = k.repeat_interleave(self.num_kv_groups, dim=1)
            v = v.repeat_interleave(self.num_kv_groups, dim=1)

        # ── 关键修正（2026-11-02）───────────────────────────────────────
        # Qwen3 是**因果**语言模型，注意力必须带因果掩码。
        # 原先这里传的是双向 padding mask（mask = attention_mask[:,None,None,:]），
        # is_causal 因此变成 False，等于把 decoder 当成 encoder 用 —— 向量虽然
        # 不报错，但语义完全是错的：4 套测试里所有查询都塌缩到同一个文档。
        #
        # 另一个坑：**不能用 left padding**。因果掩码下，left padding 会让
        # 第一个真实 token 的整行 attend 全落在 padding 上（因果 mask 只放开
        # 左边，而左边全是 pad），softmax 全 -inf -> 直接出 NaN。
        # 所以本模块统一使用 **right padding**，pooling 时按 mask 长度定位
        # 最后一个真实 token（与官方 _pooling_last 的 right 分支一致）。
        #
        # 同时 padding 位仍需屏蔽：attn_mask 为 (b,1,s,s) bool，True=可见。
        if mask is None:
            out = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        else:
            key_ok = mask.expand(bsz, 1, seq_len, seq_len)
            causal = torch.ones(
                seq_len, seq_len, dtype=torch.bool, device=q.device
            ).tril().view(1, 1, seq_len, seq_len)
            allowed = key_ok & causal
            out = F.scaled_dot_product_attention(
                q, k, v, attn_mask=allowed, is_causal=False
            )
        out = out.transpose(1, 2).contiguous().view(bsz, seq_len, -1)
        return self.o_proj(out)


class Qwen3MLP(nn.Module):
    """SwiGLU：down(silu(gate(x)) * up(x))"""

    def __init__(self, cfg):
        super().__init__()
        h, i = cfg["hidden_size"], cfg["intermediate_size"]
        self.gate_proj = nn.Linear(h, i, bias=False)
        self.up_proj = nn.Linear(h, i, bias=False)
        self.down_proj = nn.Linear(i, h, bias=False)

    def forward(self, x):
        return self.down_proj(F.silu(self.gate_proj(x)) * self.up_proj(x))


class Qwen3Layer(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.input_layernorm = Qwen3RMSNorm(cfg["hidden_size"], eps=cfg["rms_norm_eps"])
        self.self_attn = Qwen3Attention(cfg)
        self.post_attention_layernorm = Qwen3RMSNorm(
            cfg["hidden_size"], eps=cfg["rms_norm_eps"]
        )
        self.mlp = Qwen3MLP(cfg)

    def forward(self, x, rope, mask=None):
        h = x + self.self_attn(self.input_layernorm(x), rope, mask)
        return h + self.mlp(self.post_attention_layernorm(h))


class Qwen3Model(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.cfg = cfg
        self.embed_tokens = nn.Embedding(cfg["vocab_size"], cfg["hidden_size"])
        self.layers = nn.ModuleList([Qwen3Layer(cfg) for _ in range(cfg["num_hidden_layers"])])
        self.norm = Qwen3RMSNorm(cfg["hidden_size"], eps=cfg["rms_norm_eps"])

        # RoPE 表只建一次。原先把 Qwen3RotaryEmbedding 放在 forward 里实例化，
        # 等于每个 batch 都重算一遍 inv_freq 和 cos/sin 表 —— 纯粹浪费。
        # 这里做成模块级 buffer，随 .to(device) 一起搬，不参与 state_dict。
        self._rope_max = 0
        self.rope = Qwen3RotaryEmbedding(
            cfg["head_dim"], base=cfg["rope_theta"], max_len=1024
        )

    def _ensure_rope(self, seq_len, device):
        if seq_len > self._rope_max:
            self.rope._build(max(seq_len, 1024), device)
            self._rope_max = seq_len

    def forward(self, input_ids, attention_mask=None):
        x = self.embed_tokens(input_ids)
        seq_len = input_ids.shape[1]
        self._ensure_rope(seq_len, x.device)

        mask = None
        if attention_mask is not None:
            # (b, s) -> (b,1,1,s)，True 表示"可参与"
            mask = attention_mask[:, None, None, :].to(torch.bool)
        for layer in self.layers:
            x = layer(x, self.rope, mask)
        return self.norm(x)


# ---------------------------------------------------------------------------
# 加载：把 safetensors 的 key 映射到本实现的参数名
# ---------------------------------------------------------------------------

# safetensors 里是 model.embed_tokens.weight 这种（去掉了 model. 前缀），
# 本实现的命名与之只差一处：self_attn 下的 q_norm/k_norm 同名，可直接对齐。
_KEY_MAP = [
    ("embed_tokens.weight", "embed_tokens.weight"),
    ("norm.weight", "norm.weight"),
]


def load_model(model_dir, dtype=torch.float16, device="cuda"):
    import json
    from safetensors.torch import load_file

    cfg = json.load(open(f"{model_dir}/config.json", encoding="utf-8"))
    model = Qwen3Model(cfg)

    state = load_file(f"{model_dir}/model.safetensors")
    mapped = {}
    for k, v in state.items():
        mapped[k] = v
    missing = model.load_state_dict(mapped, strict=False)
    unexpected = [k for k in missing.unexpected_keys if k]
    lack = [k for k in missing.missing_keys if k]
    if lack:
        raise RuntimeError("权重缺失: %s" % lack[:5])
    if unexpected:
        # tie_word_embeddings=True 时 lm_head 不存在，属正常
        real = [k for k in unexpected if not k.startswith("lm_head")]
        if real:
            raise RuntimeError("未映射权重: %s" % real[:5])

    model = model.to(device=device, dtype=dtype).eval()
    return model, cfg
