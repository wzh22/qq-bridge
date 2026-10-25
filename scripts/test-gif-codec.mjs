// 纯 JS GIF 解码/拼图组件（src/gif-codec.js）的离线回归。
//
// 背景（2026-10-24）：
//   本机 `where ffmpeg` 为空，于是 media-normalize 的动图链路全部走失败分支，
//   state/bridge.log 里连续出现：
//       [media] 图片1: 动图 12 帧（抽帧拼图失败：找不到 ffmpeg…，只提供首帧）
//       [media] 图片1 不提供：动图 2.10MB 无法压缩（找不到 ffmpeg…）
//   即「QQ 上别人发的 GIF，模型要么只看到第一帧，要么根本看不到」。
//   修法有两层：① 仓库自带便携版 ffmpeg；② 补一条**零外部依赖**的纯 JS 解码兜底。
//   本文件测的是第 ② 层 —— 它必须在没有 ffmpeg 的机器上也能独立工作。
//
// 全部夹具由本文件的 makeGif() 现场合成（自带最小 LZW 编码器），不读图片素材、不跑 ffmpeg，
// 因此这个测试在任何环境下都应当 PASS 而不是 SKIP。
import assert from 'node:assert/strict';
import { decodeGif, encodePng, gifToGrid, lzwDecode, pickFrameIndices, scanGif } from '../src/gif-codec.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// ── 夹具：最小 GIF 编码器（只为测试服务，不追求压缩率） ──────────────────
//
// LZW 用「清空码 + 纯字面量」的经典写法：发出 clear(256)，然后最多 250 个字面量码，
// 再发一次 clear。这样解码端的字典永远涨不到需要加码长的地方，9 位定长即可。
function lzwEncodeLiterals(indices, minCodeSize = 8) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const codeSize = minCodeSize + 1;
  const out = [];
  let bitBuf = 0;
  let bitCount = 0;
  const push = (code) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCount -= 8;
    }
  };
  push(clear);
  let sinceClear = 0;
  for (const idx of indices) {
    push(idx);
    sinceClear += 1;
    if (sinceClear >= 250) { push(clear); sinceClear = 0; }
  }
  push(eoi);
  if (bitCount > 0) out.push(bitBuf & 0xff);
  return Buffer.from(out);
}

/** 子块链打包（每块 ≤255 字节，末尾 0 终结）。 */
function subBlocks(data) {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/**
 * 合成 GIF。
 * @param {{width:number,height:number,frames:Array<{color:[number,number,number],delayMs:number}>}} spec
 */
function makeGif({ width, height, frames }) {
  // 全局色表：256 色，第 0 号是黑，第 1 号开始依次放每帧的颜色
  const gct = Buffer.alloc(256 * 3);
  frames.forEach((f, i) => {
    const p = (i + 1) * 3;
    gct[p] = f.color[0];
    gct[p + 1] = f.color[1];
    gct[p + 2] = f.color[2];
  });
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'ascii');
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  head[10] = 0xf7; // GCT 存在 + 8 位色深 + 256 项
  head[11] = 0;    // 背景色索引
  head[12] = 0;

  const chunks = [head, gct];
  // NETSCAPE 循环扩展（无限循环）
  chunks.push(Buffer.from([
    0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, 0x00, 0x00, 0x00
  ]));

  frames.forEach((f, i) => {
    // GCE：disposal=1（保留）、无透明
    const delayCs = Math.max(1, Math.round(f.delayMs / 10));
    const gce = Buffer.alloc(8);
    gce[0] = 0x21; gce[1] = 0xf9; gce[2] = 0x04; gce[3] = 0x04;
    gce.writeUInt16LE(delayCs, 4);
    gce[6] = 0; gce[7] = 0;
    chunks.push(gce);

    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(0, 1);
    desc.writeUInt16LE(0, 3);
    desc.writeUInt16LE(width, 5);
    desc.writeUInt16LE(height, 7);
    desc[9] = 0x00; // 无局部色表、非 interlace
    chunks.push(desc);

    const pixels = Buffer.alloc(width * height, i + 1);
    chunks.push(Buffer.from([8])); // LZW minCodeSize
    chunks.push(subBlocks(lzwEncodeLiterals(pixels, 8)));
  });

  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}

const GIF_3F = makeGif({
  width: 32, height: 24,
  frames: [
    { color: [255, 0, 0], delayMs: 100 },
    { color: [0, 255, 0], delayMs: 100 },
    { color: [0, 0, 255], delayMs: 100 }
  ]
});

// ── 解码 ──────────────────────────────────────────────────────────────────
await test('decodeGif 读出逻辑尺寸、帧数与每帧延时', async () => {
  const gif = decodeGif(GIF_3F);
  assert.equal(gif.width, 32);
  assert.equal(gif.height, 24);
  assert.equal(gif.frames.length, 3, '必须解出 3 帧，而不是只解第一帧');
  assert.deepEqual(gif.frames.map((f) => f.delayMs), [100, 100, 100]);
});

await test('decodeGif 每帧颜色正确（不是「所有帧都一样」的假解码）', async () => {
  const gif = decodeGif(GIF_3F);
  const center = (rgba, w, h) => {
    const o = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
    return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
  };
  assert.deepEqual(center(gif.frames[0].rgba, 32, 24), [255, 0, 0, 255]);
  assert.deepEqual(center(gif.frames[1].rgba, 32, 24), [0, 255, 0, 255]);
  assert.deepEqual(center(gif.frames[2].rgba, 32, 24), [0, 0, 255, 255]);
});

await test('decodeGif 拒绝非 GIF 字节（不静默返回空图）', async () => {
  assert.throws(() => decodeGif(Buffer.from('this is definitely not a gif file')), /不是 GIF|太短/);
  assert.throws(() => decodeGif(Buffer.alloc(4)), /太短/);
});

await test('decodeGif 能啃下跨多个子块的大帧（250 像素上限以上的数据）', async () => {
  // 64×64 = 4096 像素 → LZW 数据必然超过单个 255 字节子块，验证子块链拼接
  const big = decodeGif(makeGif({
    width: 64, height: 64,
    frames: [{ color: [10, 200, 30], delayMs: 100 }, { color: [200, 10, 30], delayMs: 100 }]
  }));
  assert.equal(big.frames.length, 2);
  const o = (32 * 64 + 32) * 4;
  assert.deepEqual([...big.frames[0].rgba.subarray(o, o + 4)], [10, 200, 30, 255]);
  assert.deepEqual([...big.frames[1].rgba.subarray(o, o + 4)], [200, 10, 30, 255]);
});

// ── 抽帧策略 ──────────────────────────────────────────────────────────────
await test('pickFrameIndices 均匀取样、首尾都取到、不重复', async () => {
  assert.deepEqual(pickFrameIndices(12, 6), [0, 2, 4, 7, 9, 11]);
  assert.deepEqual(pickFrameIndices(2, 6), [0, 1], '帧数少于目标时全放进去，不重复填格');
  assert.deepEqual(pickFrameIndices(1, 6), [0]);
  assert.deepEqual(pickFrameIndices(0, 6), []);
  for (const n of [5, 9, 30, 100]) {
    const picked = pickFrameIndices(n, 6);
    assert.equal(new Set(picked).size, picked.length, `${n} 帧取样不应重复`);
    assert.ok(picked.every((i) => i >= 0 && i < n));
  }
});

// ── 大动图：内存必须与总帧数脱钩（2026-10-24 回归） ────────────────────────
//
// 事故现场：decodeGif 早期实现把**每一帧**都合成成完整 RGBA 画布存进数组。
// 600×600、1200 帧的动图因此要 1200 × 600 × 600 × 4 ≈ 1.6 GB —— 桥接进程被 V8 堆顶死，
// 用户看到的是「大一点的动图发过去没反应 / 图看不了」，日志里连一句像样的错误都没有。
// 而实际上我们只抽 6 帧。修法是 scanGif() 先数帧、只保留抽中的帧（keepFrames）。
/** 造 n 帧的夹具（颜色循环取几种，够区分即可）。 */
function makeNFrames({ width, height, n }) {
  const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]];
  return makeGif({
    width,
    height,
    frames: Array.from({ length: n }, (_, i) => ({ color: palette[i % palette.length], delayMs: 50 }))
  });
}

await test('scanGif 只数帧不解码（与 decodeGif 结果一致、但不占内存）', async () => {
  const many = makeNFrames({ width: 40, height: 30, n: 60 });
  const scanned = scanGif(many);
  assert.equal(scanned.frameCount, 60);
  assert.equal(scanned.width, 40);
  assert.equal(scanned.height, 30);
  assert.ok(scanned.durationMs > 0, '应能算出总时长');
});

await test('decodeGif 的 keepFrames 只留指定帧，且下标是原始帧序', async () => {
  const many = makeNFrames({ width: 40, height: 30, n: 60 });
  const got = decodeGif(many, { keepFrames: [0, 29, 59] });
  assert.equal(got.totalFrames, 60, '总帧数仍要是真实值');
  assert.equal(got.frames.length, 3, '只保留 3 帧');
  assert.deepEqual(got.frames.map((f) => f.index), [0, 29, 59]);
  // 不传 keepFrames 时保持旧行为（全解），兼容已有调用方
  const all = decodeGif(many);
  assert.equal(all.frames.length, 60);
});

await test('大动图拼图：只把抽中的帧留在内存里（行为断言，不测字节数）', async () => {
  // 200 帧 × 200×200。若仍「全帧留存」，堆上要留 200×200×200×4 ≈ 30.5MB。
  //
  // 这里**不做内存测量**：heapUsed 在同一进程里被夹具、GC 时机、堆扩容一起污染，
  // 实测同一份代码在独立进程里是 2.19MB、在测试进程里能读到 16MB 以上；
  // RSS 更糟（能差出 40MB）。拿它做阈值断言只会得到跟实现无关的假失败。
  // 改成断言**可观察的行为契约**：keepFrames 生效后只回 6 帧，totalFrames 仍如实。
  const big = makeNFrames({ width: 200, height: 200, n: 200 });
  const grid = gifToGrid(big, { cols: 3, rows: 2, sampleFrames: 6, tileWidth: 240, maxBytes: 1024 * 1024 });
  assert.equal(grid.totalFrames, 200, '总帧数必须如实反映原始文件');
  assert.equal(grid.sampleFrames, 6, '只抽 6 帧');

  // 直接验证根因：keepFrames 生效后底层只保留 6 帧（而不是 200 帧）。
  const kept = decodeGif(big, { keepFrames: pickFrameIndices(200, 6) });
  assert.equal(kept.frames.length, 6, 'keepFrames 必须真的只留 6 帧');
  assert.equal(kept.totalFrames, 200);
  assert.ok(grid.buffer.length > 0);
});

await test('gifToGrid 的总时长来自整段动画，而不是抽中的那几帧', async () => {
  const many = makeNFrames({ width: 40, height: 30, n: 60 });
  const scanned = scanGif(many);
  const grid = gifToGrid(many, { cols: 3, rows: 2, sampleFrames: 6, tileWidth: 120 });
  // 旧实现在只保留抽中帧之后会退化成「6 帧的时长」，说明里的秒数就不对了。
  assert.equal(grid.durationMs, scanned.durationMs, '总时长必须是整段动画的');
});

// ── 拼图 ──────────────────────────────────────────────────────────────────
await test('gifToGrid 产出单帧 PNG，尺寸按 cols/rows/tileWidth 算', async () => {
  const grid = gifToGrid(GIF_3F, { cols: 3, rows: 1, sampleFrames: 3, tileWidth: 120, gap: 4, margin: 4 });
  assert.equal(grid.mimeType, 'image/png');
  // 32×24 的比例 → 120×90；宽 = 4*2 + 3*120 + 2*4 = 376，高 = 4*2 + 90 = 98
  assert.equal(grid.width, 376);
  assert.equal(grid.height, 98);
  assert.equal(grid.sampleFrames, 3);
  assert.equal(grid.totalFrames, 3);
  assert.equal(grid.buffer.subarray(1, 4).toString('ascii'), 'PNG');
});

await test('gifToGrid 的网格里确实有内容（三格颜色各不相同）', async () => {
  const grid = gifToGrid(GIF_3F, { cols: 3, rows: 1, sampleFrames: 3, tileWidth: 120, gap: 0, margin: 0 });
  // 手工解码 PNG（filter 全是 0，直接取 IDAT）
  const png = grid.buffer;
  let off = 8;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const zlib = await import('node:zlib');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = grid.width * 4 + 1;
  const pixel = (x, y) => {
    const o = y * stride + 1 + x * 4;
    return [raw[o], raw[o + 1], raw[o + 2]];
  };
  // 三格中心（每格 120 宽、90 高）
  assert.deepEqual(pixel(60, 45), [255, 0, 0], '第 1 格应是红');
  assert.deepEqual(pixel(180, 45), [0, 255, 0], '第 2 格应是绿');
  assert.deepEqual(pixel(300, 45), [0, 0, 255], '第 3 格应是蓝');
});

await test('gifToGrid 在 maxBytes 收紧时自动降采样（而不是直接失败）', async () => {
  const full = gifToGrid(GIF_3F, { cols: 3, rows: 1, sampleFrames: 3, tileWidth: 240 });
  const shrunk = gifToGrid(GIF_3F, { cols: 3, rows: 1, sampleFrames: 3, tileWidth: 240, maxBytes: Math.floor(full.buffer.length * 0.6) });
  assert.ok(shrunk.scale < 1, `应当发生降采样，实际 scale=${shrunk.scale}`);
  assert.ok(shrunk.buffer.length < full.buffer.length, '降采样后必须更小');
  assert.ok(shrunk.buffer.length <= Math.floor(full.buffer.length * 0.6), '应当压到目标以内');
  assert.ok(shrunk.width < full.width && shrunk.height < full.height);
});

await test('gifToGrid 目标小到不可能达到时，返回超限 buffer 由调用方拒绝（不假装成功）', async () => {
  // PNG 有固定结构开销，几百字节的目标对任何有内容的图都不可能满足。
  // 这里的契约是：gifToGrid 尽力降采样后照实返回，由 normalizeImageForModel 判断超限并降级。
  const grid = gifToGrid(GIF_3F, { cols: 3, rows: 1, sampleFrames: 3, tileWidth: 240, maxBytes: 200 });
  assert.ok(grid.buffer.length > 200, '不可能压到 200B，应如实返回');
  assert.ok(grid.scale <= 0.26, `应当已压到下限，实际 ${grid.scale}`);
});

await test('gifToGrid 对没有帧的坏 GIF 抛错（调用方据此降级）', async () => {
  const broken = Buffer.from(GIF_3F);
  // 把第一个图像描述符改成未知块，解码器会安全停下并得到 0 帧
  assert.throws(() => gifToGrid(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(7)])), /GIF|帧/);
});

// ── 底层组件 ──────────────────────────────────────────────────────────────
await test('lzwDecode：单一字面量流能正确还原', async () => {
  const pixels = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const encoded = lzwEncodeLiterals(pixels, 8);
  const { pixels: decoded, written } = lzwDecode(encoded, 8, pixels.length);
  assert.equal(written, pixels.length);
  assert.deepEqual([...decoded], [...pixels]);
});

await test('lzwDecode：数据被截断时返回已解出的部分而不是崩掉', async () => {
  const pixels = Buffer.alloc(1000, 7);
  const encoded = lzwEncodeLiterals(pixels, 8);
  const { pixels: decoded, written } = lzwDecode(encoded.subarray(0, 10), 8, 1000);
  assert.ok(written < 1000);
  assert.ok(decoded.length === 1000, '返回缓冲区仍然按请求的尺寸分配');
});

await test('encodePng：签名/尺寸/可被解码器接受', async () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const png = encodePng(rgba, 2, 2);
  assert.deepEqual([...png.subarray(1, 4)], [...Buffer.from('PNG')]);
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 2);
  const zlib = await import('node:zlib');
  let off = 8;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, 2 * (2 * 4 + 1));
  assert.deepEqual([...raw.subarray(1, 5)], [255, 0, 0, 255]);
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  failures=${failures}`);
if (failures) process.exit(1);
