// 纯 JS 的 GIF 解码 / 多帧拼图组件 —— 不依赖 ffmpeg，也不依赖任何 native 模块。
//
// 为什么要有这一份（2026-10-24）：
//   media-normalize.js 的动图链路原本只有 ffmpeg 一条路。本机实测（state/bridge.log）：
//       [media] 图片1: 动图 12 帧（抽帧拼图失败：找不到 ffmpeg…，只提供首帧）
//       [media] 图片1 不提供：动图 2.10MB 无法压缩（找不到 ffmpeg…）
//   也就是说：**没装 ffmpeg 的机器上，QQ 发来的 GIF 表情，模型要么只看第一帧，要么压根看不到。**
//   装一个 ffmpeg 只是「这台机器」的解法；换台机器 / 被 PATH 弄丢 / 二进制被杀软拦掉，
//   同一个坑会再踩一次。所以这里补一条**零外部依赖**的解码路径。
//
// 它做的事：GIF 字节 → 逐帧还原（含透明、局部帧、interlace、disposal）→ 抽 N 帧
//           → 缩到统一格宽 → 拼成一张网格 → 编码成 PNG。模型拿到的就是一张「能看懂动画过程」的静图。
//
// 取舍：
//   · 只在 ffmpeg 不可用 / 抽帧失败时兜底，正常路径仍然走 ffmpeg（JPEG 体积更小）。
//   · 纯 JS 只能产 PNG（照片类的体积会偏大），所以拼图超限时会自动降采样再试一次。
//   · 只做 GIF。动图 WebP 的解码远比 GIF 复杂，那边继续交给 ffmpeg。
//
// 对外只用两个入口：decodeGif()（可单测）与 gifToGrid()（给 media-normalize 用）。

import zlib from 'node:zlib';

// ── 调色板 ────────────────────────────────────────────────────────────────

/** 读一个调色板：n 个 3 字节 RGB 三元组，展开成 n 个 [r,g,b] 。 */
function readPalette(buf, offset, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = offset + i * 3;
    out[i] = [buf[p], buf[p + 1], buf[p + 2]];
  }
  return out;
}

/** 跳过 GIF 子块链（每块首字节是长度，0 结束）。越界返回 -1。 */
function skipSubBlocks(buf, pos) {
  let p = pos;
  while (p < buf.length) {
    const size = buf[p];
    p += 1;
    if (size === 0) return p;
    p += size;
  }
  return -1;
}

/** 读子块链并拼成一段连续字节（LZW 数据就在这里）。 */
function readSubBlocks(buf, pos) {
  const chunks = [];
  let total = 0;
  let p = pos;
  while (p < buf.length) {
    const size = buf[p];
    p += 1;
    if (size === 0) return { data: Buffer.concat(chunks, total), next: p };
    if (p + size > buf.length) break;
    chunks.push(buf.subarray(p, p + size));
    total += size;
    p += size;
  }
  return { data: Buffer.concat(chunks, total), next: -1 };
}

// ── LZW ───────────────────────────────────────────────────────────────────

/**
 * GIF 的 LZW 解码。
 *
 * 标准实现：clear code 重置字典，EOI 结束，码长从 minCodeSize+1 起、
 * 每填满 2^codeSize 个表项涨 1 位（上限 12 位）。字典项用「数字数组」存，
 * 新项 = 上一项 + 当前项的首字节 —— 这就是 LZW 的经典自引用扩张。
 *
 * @param data       压缩数据（已去掉子块长度字节）
 * @param minCodeSize LZW 最小码长（1..11，正常是 2..8）
 * @param pixelCount 期望解出的索引字节数（帧宽 × 帧高）
 */
export function lzwDecode(data, minCodeSize, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const out = Buffer.alloc(pixelCount);
  let outPos = 0;

  let dict = [];
  let nextCode = 0;
  let codeSize = 0;
  const reset = () => {
    dict = new Array(4096);
    for (let i = 0; i < clearCode; i += 1) dict[i] = [i];
    dict[clearCode] = null;
    dict[eoiCode] = null;
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  };
  reset();

  let bitBuf = 0;
  let bitCount = 0;
  let pos = 0;
  let prev = null;
  const mask = (n) => (1 << n) - 1;

  while (outPos < pixelCount) {
    while (bitCount < codeSize) {
      if (pos >= data.length) return { pixels: out, written: outPos };
      bitBuf |= data[pos] << bitCount;
      pos += 1;
      bitCount += 8;
    }
    const code = bitBuf & mask(codeSize);
    bitBuf >>= codeSize;
    bitCount -= codeSize;

    if (code === clearCode) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoiCode) break;

    let entry;
    if (dict[code]) entry = dict[code];
    else if (code === nextCode && prev) {
      entry = prev.slice();
      entry.push(prev[0]);
    } else {
      // 数据坏了：返回已经解出来的部分，别把整张图丢掉
      break;
    }

    for (let i = 0; i < entry.length && outPos < pixelCount; i += 1) out[outPos++] = entry[i];

    if (prev) {
      if (nextCode < 4096) {
        const extended = prev.slice();
        extended.push(entry[0]);
        dict[nextCode] = extended;
        nextCode += 1;
        if (nextCode === (1 << codeSize) && codeSize < 12) codeSize += 1;
      }
    }
    prev = entry;
  }

  return { pixels: out, written: outPos };
}

// ── 帧解码 ────────────────────────────────────────────────────────────────

/** interlace 行序还原：4 个 pass（0/8, 4/8, 2/4, 1/2）。 */
function deinterlace(src, w, h) {
  const dst = Buffer.alloc(w * h);
  const passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
  let srcRow = 0;
  for (const [start, step] of passes) {
    for (let y = start; y < h && srcRow < h; y += step) {
      dst.set(src.subarray(srcRow * w, (srcRow + 1) * w), y * w);
      srcRow += 1;
    }
  }
  return dst;
}

/**
 * 解码整个 GIF。
 *
 * @returns {{
 *   width:number, height:number, loopCount:number,
 *   frames: Array<{ rgba: Buffer, delayMs:number }>
 * }}
 *   rgba 是**已经按 disposal 合成过的整幅画面**（width×height×4，非预乘）。
 *   直接逐帧拿去拼图即可，不需要调用方再理解 disposal。
 */
export function decodeGif(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 13) throw new Error('GIF 太短（不足 13 字节头）');
  const sig = buf.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error(`不是 GIF（签名 ${JSON.stringify(sig)}）`);

  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (!width || !height) throw new Error('GIF 逻辑屏幕尺寸为 0');
  if (width * height > 64_000_000) throw new Error(`GIF 尺寸过大（${width}×${height}）`);

  const packed = buf[10];
  const bgIndex = buf[11];
  let pos = 13;
  let gct = null;
  if (packed & 0x80) {
    const n = 2 << (packed & 0x07);
    gct = readPalette(buf, pos, n);
    pos += 3 * n;
  }
  // 背景色：GIF 规定 disposal=2 时还原成逻辑屏幕背景色。没有 GCT 就用透明。
  const bg = gct && gct[bgIndex] ? [...gct[bgIndex], 255] : [0, 0, 0, 0];

  let canvas = Buffer.alloc(width * height * 4);
  const frames = [];
  let loopCount = 0;
  let gce = { delayMs: 0, transparentIndex: -1, disposal: 0 };
  let guard = 0;

  while (pos > 0 && pos < buf.length) {
    if (++guard > 1_000_000) break;
    const block = buf[pos];

    // ── Trailer ──
    if (block === 0x3b) break;

    // ── 扩展块 ──
    if (block === 0x21) {
      if (pos + 1 >= buf.length) break;
      const label = buf[pos + 1];
      const afterLabel = pos + 2;
      if (label === 0xf9) {
        // Graphic Control Extension：块长 4 + 打包位 1 + delay 2 + 透明索引 1 + 终结符
        if (afterLabel + 5 > buf.length) break;
        const size = buf[afterLabel];
        if (size >= 4) {
          const gp = buf[afterLabel + 1];
          gce = {
            disposal: (gp >> 2) & 0x07,
            transparentIndex: gp & 0x01 ? buf[afterLabel + 4] : -1,
            delayMs: buf.readUInt16LE(afterLabel + 2) * 10
          };
        }
      } else if (label === 0xff) {
        // Application Extension：NETSCAPE2.0 的循环次数在子块里
        if (afterLabel + 1 < buf.length) {
          const size = buf[afterLabel];
          const appId = buf.toString('ascii', afterLabel + 1, afterLabel + 1 + Math.min(11, size));
          if (/^NETSCAPE2\.0|^ANIMEXTS1\.0/.test(appId)) {
            const sub = readSubBlocks(buf, afterLabel + 1 + size);
            if (sub.data.length >= 3 && sub.data[0] === 0x01) loopCount = sub.data.readUInt16LE(1);
          }
        }
      }
      pos = skipSubBlocks(buf, afterLabel);
      continue;
    }

    // ── 图像描述符 ──
    if (block === 0x2c) {
      if (pos + 10 > buf.length) break;
      const left = buf.readUInt16LE(pos + 1);
      const top = buf.readUInt16LE(pos + 3);
      const fw = buf.readUInt16LE(pos + 5);
      const fh = buf.readUInt16LE(pos + 7);
      const dp = buf[pos + 9];
      let p = pos + 10;
      let lct = null;
      if (dp & 0x80) {
        const n = 2 << (dp & 0x07);
        lct = readPalette(buf, p, n);
        p += 3 * n;
      }
      const interlaced = (dp & 0x40) !== 0;
      if (p >= buf.length) break;
      const minCodeSize = buf[p];
      const sub = readSubBlocks(buf, p + 1);
      if (sub.next < 0) break;

      const palette = lct || gct;
      const { pixels, written } = lzwDecode(sub.data, minCodeSize, fw * fh);
      const indices = interlaced ? deinterlace(pixels, fw, fh) : pixels;

      // disposal=3 需要「画这一帧之前的画面」
      const saved = gce.disposal === 3 ? Buffer.from(canvas) : null;

      // 把这一帧贴到 canvas 上（尊重透明索引与越界裁剪）
      if (palette && written > 0) {
        const ti = gce.transparentIndex;
        for (let y = 0; y < fh; y += 1) {
          const cy = top + y;
          if (cy < 0 || cy >= height) continue;
          const srcRow = y * fw;
          const dstRow = cy * width * 4;
          for (let x = 0; x < fw; x += 1) {
            const cx = left + x;
            if (cx < 0 || cx >= width) continue;
            const idx = indices[srcRow + x];
            if (idx === ti) continue;
            const color = palette[idx];
            if (!color) continue;
            const o = dstRow + cx * 4;
            canvas[o] = color[0];
            canvas[o + 1] = color[1];
            canvas[o + 2] = color[2];
            canvas[o + 3] = 255;
          }
        }
      }

      frames.push({ rgba: Buffer.from(canvas), delayMs: gce.delayMs });

      // 这一帧显示完之后按 disposal 收拾画布
      if (gce.disposal === 2) {
        for (let y = top; y < Math.min(height, top + fh); y += 1) {
          const rowOff = y * width * 4;
          for (let x = left; x < Math.min(width, left + fw); x += 1) {
            const o = rowOff + x * 4;
            canvas[o] = bg[0];
            canvas[o + 1] = bg[1];
            canvas[o + 2] = bg[2];
            canvas[o + 3] = bg[3];
          }
        }
      } else if (gce.disposal === 3 && saved) {
        canvas = saved;
      }

      gce = { delayMs: 0, transparentIndex: -1, disposal: 0 };
      pos = sub.next;
      continue;
    }

    break; // 认不出的块：停下，别硬猜
  }

  return { width, height, loopCount, frames };
}

// ── 缩放 / 拼图 ───────────────────────────────────────────────────────────

/**
 * RGBA 区域平均缩放（带 alpha 加权）。
 *
 * 为什么用区域平均而不是最近邻：QQ 表情动图缩到 240px 一格，
 * 最近邻会把细线抖成锯齿，模型对「动作」的判断会受影响。箱式滤波便宜且稳。
 */
function resizeRGBA(src, sw, sh, dw, dh) {
  if (dw === sw && dh === sh) return Buffer.from(src);
  const out = Buffer.alloc(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let dy = 0; dy < dh; dy += 1) {
    const sy0 = Math.floor(dy * yRatio);
    const sy1 = Math.min(sh, Math.max(sy0 + 1, Math.ceil((dy + 1) * yRatio)));
    for (let dx = 0; dx < dw; dx += 1) {
      const sx0 = Math.floor(dx * xRatio);
      const sx1 = Math.min(sw, Math.max(sx0 + 1, Math.ceil((dx + 1) * xRatio)));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        const rowOff = sy * sw * 4;
        for (let sx = sx0; sx < sx1; sx += 1) {
          const o = rowOff + sx * 4;
          const al = src[o + 3] / 255;
          r += src[o] * al;
          g += src[o + 1] * al;
          b += src[o + 2] * al;
          a += src[o + 3];
          n += 1;
        }
      }
      const o = (dy * dw + dx) * 4;
      if (n > 0) {
        const alphaSum = a / 255;
        // 预乘还原：颜色按 alpha 加权平均，alpha 自己取算术平均
        out[o] = alphaSum > 0 ? Math.round(r / alphaSum) : 0;
        out[o + 1] = alphaSum > 0 ? Math.round(g / alphaSum) : 0;
        out[o + 2] = alphaSum > 0 ? Math.round(b / alphaSum) : 0;
        out[o + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}

/** 把一张 RGBA 图贴到目标画布的 (dx,dy)（源是半透明时与底色混合）。 */
function blit(dst, dstW, dstH, src, sw, sh, dx, dy, bg) {
  for (let y = 0; y < sh; y += 1) {
    const ty = dy + y;
    if (ty < 0 || ty >= dstH) continue;
    for (let x = 0; x < sw; x += 1) {
      const tx = dx + x;
      if (tx < 0 || tx >= dstW) continue;
      const so = (y * sw + x) * 4;
      const to = (ty * dstW + tx) * 4;
      const sa = src[so + 3] / 255;
      if (sa <= 0) {
        dst[to] = bg[0]; dst[to + 1] = bg[1]; dst[to + 2] = bg[2]; dst[to + 3] = 255;
        continue;
      }
      dst[to] = Math.round(src[so] * sa + bg[0] * (1 - sa));
      dst[to + 1] = Math.round(src[so + 1] * sa + bg[1] * (1 - sa));
      dst[to + 2] = Math.round(src[so + 2] * sa + bg[2] * (1 - sa));
      dst[to + 3] = 255;
    }
  }
}

/** 均匀抽帧：从 n 帧里挑 k 帧，首尾都取到。 */
export function pickFrameIndices(n, k) {
  if (n <= 0) return [];
  const want = Math.max(1, Math.min(k, n));
  if (want === 1) return [0];
  const out = [];
  for (let i = 0; i < want; i += 1) out.push(Math.round((i * (n - 1)) / (want - 1)));
  return [...new Set(out)];
}

// ── PNG 编码 ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** RGBA → PNG（8-bit truecolor + alpha，无滤波）。 */
export function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ── 对外主入口 ────────────────────────────────────────────────────────────

/**
 * GIF → 一张多格拼图（PNG）。
 *
 * @param buf   GIF 原始字节
 * @param opts  { cols, rows, sampleFrames, tileWidth, gap, margin, background, maxBytes }
 * @returns {{
 *   buffer: Buffer, mimeType: string, width:number, height:number,
 *   cols:number, rows:number, sampleFrames:number, totalFrames:number,
 *   durationMs:number, scale:number
 * }}
 *   抛异常表示「这个 GIF 我解不了」，调用方据此退回别的路径。
 */
export function gifToGrid(buf, opts = {}) {
  const decoded = decodeGif(buf);
  const { width, height, frames } = decoded;
  if (!frames.length) throw new Error('GIF 里没有可解码的帧');

  const cols = Math.max(1, Math.round(Number(opts.cols) || 3));
  const rows = Math.max(1, Math.round(Number(opts.rows) || 2));
  const cells = cols * rows;
  const tileWidth = Math.max(24, Math.round(Number(opts.tileWidth) || 240));
  const gap = Math.max(0, Math.round(Number(opts.gap ?? 4)));
  const margin = Math.max(0, Math.round(Number(opts.margin ?? 4)));
  const bg = Array.isArray(opts.background) ? opts.background : [255, 255, 255];

  const indices = pickFrameIndices(frames.length, Math.min(cells, opts.sampleFrames || cells));

  // 格子高度按源图长宽比算；拼图整体尺寸由此固定
  const ratio = height / width;
  const tileHeight = Math.max(1, Math.round(tileWidth * ratio));
  const gridW = margin * 2 + cols * tileWidth + (cols - 1) * gap;
  const gridH = margin * 2 + rows * tileHeight + (rows - 1) * gap;

  const paint = (scale) => {
    const tw = Math.max(1, Math.round(tileWidth * scale));
    const th = Math.max(1, Math.round(tileHeight * scale));
    const w = margin * 2 + cols * tw + (cols - 1) * gap;
    const h = margin * 2 + rows * th + (rows - 1) * gap;
    const out = Buffer.alloc(w * h * 4);
    // 底色（含格子间隙）
    for (let i = 0; i < out.length; i += 4) {
      out[i] = bg[0]; out[i + 1] = bg[1]; out[i + 2] = bg[2]; out[i + 3] = 255;
    }
    indices.forEach((frameIndex, cell) => {
      const cx = cell % cols;
      const cy = Math.floor(cell / cols);
      if (cy >= rows) return;
      const scaled = resizeRGBA(frames[frameIndex].rgba, width, height, tw, th);
      blit(out, w, h, scaled, tw, th, margin + cx * (tw + gap), margin + cy * (th + gap), bg);
    });
    return { rgba: out, width: w, height: h };
  };

  let scale = 1;
  let painted = paint(scale);
  let png = encodePng(painted.rgba, painted.width, painted.height);
  const maxBytes = Number(opts.maxBytes) || 0;
  // 纯 JS 只能出 PNG；照片类 GIF 拼图可能偏大 → 逐步降采样再编码。
  // 下限 0.25：再小就只剩色块，模型反而看不清动作，不如直接交给调用方降级。
  // 注意 PNG 有固定开销（签名 + 3 个块 + 每行 1 字节 filter），极小目标本身不可能达到。
  let attempts = 0;
  while (maxBytes > 0 && png.length > maxBytes && attempts < 6 && scale > 0.25) {
    scale *= 0.75;
    painted = paint(scale);
    png = encodePng(painted.rgba, painted.width, painted.height);
    attempts += 1;
  }

  const durationMs = frames.reduce((sum, f) => sum + (f.delayMs || 0), 0);
  return {
    buffer: png,
    mimeType: 'image/png',
    width: painted.width,
    height: painted.height,
    cols,
    rows,
    sampleFrames: indices.length,
    totalFrames: frames.length,
    durationMs,
    scale: Number(scale.toFixed(3)),
    gridWidth: gridW,
    gridHeight: gridH,
    tileWidth: Math.round(tileWidth * scale)
  };
}
