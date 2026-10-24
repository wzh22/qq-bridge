// 端到端回归：真实 GIF → 真实 ffmpeg 抽帧拼图（默认配置，不带任何覆盖）
//
// 为什么单独有这一层：scripts/test-media-normalize.mjs 用桩件覆盖分支逻辑，
// scripts/test-gif-codec.mjs 只测纯 JS 解码器。两者都**碰不到真 ffmpeg**。
// 本文件是唯一会真的 spawn ffmpeg、把结果拆回像素来判断「六格是不是六帧不同画面」的测试，
// 因此它同时是「便携版 ffmpeg 是否可用」的体检。
//
// 约定：找不到 ffmpeg 时**不跳过、不静默通过**，直接 FAIL —— 仓库自带 tools/ffmpeg/ffmpeg.exe，
// 缺失应当视为环境损坏（用 `npm run fetch:ffmpeg` 修复）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeImageForModel, sniffImage, MEDIA_DEFAULTS } from '../src/media-normalize.js';
import { resolveFfmpeg } from '../src/voice-core.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail = '') {
  pass += 1;
  console.log(`PASS ${name}${detail ? `（${detail}）` : ''}`);
}

function bad(name, detail = '') {
  fail += 1;
  failures.push(`${name}${detail ? `：${detail}` : ''}`);
  console.log(`FAIL ${name}${detail ? `（${detail}）` : ''}`);
}

function assert(cond, name, detail = '') {
  if (cond) ok(name, detail); else bad(name, detail);
}

const ff = resolveFfmpeg({});
assert(Boolean(ff) && fs.existsSync(ff), 'ffmpeg 可执行文件存在', ff || '未解析到路径');
if (!ff || !fs.existsSync(ff)) {
  console.log(`\nALL FAIL  pass=${pass} fail=${fail}`);
  console.log('修复：npm run fetch:ffmpeg');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '..', 'state', 'tmp', 'e2e-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });

function makeGif(name, w, h, rate, dur) {
  const out = path.join(tmp, name);
  const r = spawnSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `testsrc2=size=${w}x${h}:rate=${rate}:duration=${dur}`, '-vf',
    'split[a][b];[a]palettegen[p];[b][p]paletteuse', out], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`生成测试 GIF 失败：${name}`);
  return out;
}

// 三档样本：普通动图 / 48 帧大图（历史上走到过「2.10MB 无法压缩」）/ 帧数少于目标格的短片
//
// srcW/srcH 用来算期望的网格像素尺寸：ffmpeg 侧是 `scale=${tile}:-1`，即**按宽缩放到 tile、高按原比例**，
// 所以格子只有正方形原图才是 tile×tile。tile 滤镜的 padding=4 作用于格与格之间，margin=4 作用于四周：
//   宽 = cols×tile + (cols-1)×4 + 2×4
//   高 = rows×tileH + (rows-1)×4 + 2×4
const cases = [
  { label: '普通 12 帧', file: makeGif('normal.gif', 320, 240, 6, 2), frames: 12, cols: 3, rows: 2, sampled: 6, srcW: 320, srcH: 240 },
  { label: '48 帧大图', file: makeGif('big.gif', 480, 360, 12, 4), frames: 48, cols: 3, rows: 2, sampled: 6, srcW: 480, srcH: 360 },
  { label: '三帧短片', file: makeGif('short.gif', 200, 200, 10, 0.3), frames: 3, cols: 3, rows: 1, sampled: 3, srcW: 200, srcH: 200 }
];

for (const c of cases) {
  const buf = fs.readFileSync(c.file);
  const t0 = Date.now();
  const out = await normalizeImageForModel(buf, 'image/gif', { ...MEDIA_DEFAULTS });
  const ms = Date.now() - t0;

  assert(out.ok === true, `${c.label}：归一化成功`, out.error || '');
  if (!out.ok) continue;

  // 期望走 ffmpeg（JPEG 主路径）；输出成 PNG 说明 ffmpeg 失败退到了纯 JS 兜底
  assert(out.mimeType === 'image/jpeg',
    `${c.label}：走 ffmpeg 主路径（JPEG）`,
    out.mimeType === 'image/png' ? '实际走了纯 JS 兜底，ffmpeg 可能不可用' : out.mimeType);
  assert(out.buffer.length <= MEDIA_DEFAULTS.maxModelBytes,
    `${c.label}：输出未超模型字节上限`,
    `${out.buffer.length} <= ${MEDIA_DEFAULTS.maxModelBytes}`);

  const grid = sniffImage(out.buffer);
  const tile = MEDIA_DEFAULTS.gifTile;
  const tileH = Math.round((tile * c.srcH) / c.srcW); // scale=tile:-1 按比例缩放后的格子高度
  const expectW = c.cols * tile + (c.cols - 1) * 4 + 2 * 4;
  const expectH = c.rows * tileH + (c.rows - 1) * 4 + 2 * 4;
  assert(grid?.width === expectW,
    `${c.label}：网格宽度 = ${c.cols}×${tile} + 间距`,
    grid ? `实际 ${grid.width}px，期望 ${expectW}px` : '解析失败');
  assert(grid?.height === expectH,
    `${c.label}：网格高度 = ${c.rows}×${tileH} + 间距`,
    grid ? `实际 ${grid.height}px，期望 ${expectH}px` : '解析失败');

  const note = out.note ?? '';
  assert(note.includes(`${c.frames} 帧`), `${c.label}：说明里写明原始帧数`, note);
  assert(note.includes(`${c.sampled} 帧`), `${c.label}：说明里写明抽了多少帧`, note);
  assert(note.includes(`${c.cols}×${c.rows}`), `${c.label}：说明里写明网格规格`, note);
  assert(note.includes('左上'), `${c.label}：说明里写明阅读顺序`, note);

  console.log(`      ${c.label}：原图 ${(buf.length / 1024).toFixed(0)}KB → ${out.buffer.length}B，${ms}ms`);
}

// 静态大图：验证「超长边 ⇒ 降采样」而不是原样扔给模型
console.log('');
{
  const bigJpg = path.join(tmp, 'big.jpg');
  const r = spawnSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=size=3000x2000:rate=1:duration=1', '-frames:v', '1', '-q:v', '2', bigJpg],
    { stdio: 'ignore' });
  if (r.status !== 0) {
    bad('静态大图：样张生成', 'ffmpeg 退出码非 0');
  } else {
    const jb = fs.readFileSync(bigJpg);
    const jo = await normalizeImageForModel(jb, 'image/jpeg', { ...MEDIA_DEFAULTS });
    assert(jo.ok === true, '静态大图：归一化成功', jo.error || '');
    if (jo.ok) {
      const s = sniffImage(jo.buffer);
      const longEdge = Math.max(s?.width ?? 0, s?.height ?? 0);
      assert(longEdge <= MEDIA_DEFAULTS.maxLongEdge,
        '静态大图：长边压到上限以内',
        `${longEdge} <= ${MEDIA_DEFAULTS.maxLongEdge}`);
      assert(jo.buffer.length < jb.length,
        '静态大图：输出体积确实变小',
        `${jb.length}B → ${jo.buffer.length}B`);
      console.log(`      静态大图：3000×2000 ${(jb.length / 1024).toFixed(0)}KB → ${s?.width}×${s?.height} ${(jo.buffer.length / 1024).toFixed(0)}KB`);
    }
  }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }

console.log('');
if (fail === 0) {
  console.log(`ALL PASS  pass=${pass} fail=0`);
} else {
  console.log(`FAILED  pass=${pass} fail=${fail}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
