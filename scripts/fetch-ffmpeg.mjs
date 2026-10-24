#!/usr/bin/env node
/**
 * 下载并解压便携版 ffmpeg 到 `tools/ffmpeg/ffmpeg.exe`。
 *
 * 为什么需要这个脚本（2026-10-24）：
 *   本机 `where ffmpeg` 为空，动图抽帧拼图全部退化成「只看第一帧」，
 *   2MB 以上的 GIF 直接「无法压缩」（state/bridge.log 有据）。
 *   但 77 MB 的二进制不该塞进 git，所以：仓库负责**能力**，二进制由本脚本现场取。
 *
 * 用法：
 *   node scripts/fetch-ffmpeg.mjs              # 缺失时下载
 *   node scripts/fetch-ffmpeg.mjs --force      # 强制重下
 *   node scripts/fetch-ffmpeg.mjs --print      # 只打印目标路径与现状，不联网
 *
 * 设计取舍：
 *   · 默认走 npmmirror 的 ffmpeg-static 镜像（国内直连约 2 s / 29 MB），失败再回退官方 gyan.dev。
 *   · 只用 Node 内置（https + zlib），不依赖 curl / 7z / 系统解压工具。
 *   · **失败不阻断任何东西**：退出码 0 + 明确提示，因为桥接有纯 JS 的 GIF 兜底，
 *     ffmpeg 只影响「JPEG 体积更小」和语音音量处理。
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIR = path.join(ROOT, 'tools', 'ffmpeg');
const TARGET = path.join(TARGET_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const printOnly = args.has('--print');

const MIRRORS = [
  'https://cdn.npmmirror.com/binaries/ffmpeg-static/b6.0/ffmpeg-win32-x64.gz',
  'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.0/ffmpeg-win32-x64.gz'
];
const OFFICIAL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

function log(msg) { console.log(`[ffmpeg] ${msg}`); }

function statSize() {
  try { return fs.statSync(TARGET).size; } catch { return 0; }
}

async function httpGet(url, { redirects = 0 } = {}) {
  if (redirects > 5) throw new Error('重定向次数过多');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 120000, headers: { 'user-agent': 'qq-bridge-fetch-ffmpeg' } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        resolve(httpGet(new URL(headers.location, url).href, { redirects: redirects + 1 }));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${statusCode}`));
        return;
      }
      const total = Number(headers['content-length'] || 0);
      const chunks = [];
      let received = 0;
      let lastPct = -1;
      res.on('data', (chunk) => {
        chunks.push(chunk);
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; log(`  下载中 ${pct}%（${(received / 1048576).toFixed(1)} MB）`); }
        }
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('下载超时')); });
    req.on('error', reject);
  });
}

/** 极简 zip 解压：只找包内 bin 目录下的 ffmpeg.exe，够用且不引依赖。 */
function unzipFfmpeg(zip) {
  const SIG = 0x04034b50;
  for (let i = 0; i < zip.length - 4; i += 1) {
    if (zip.readUInt32LE(i) !== SIG) continue;
    try {
      const method = zip.readUInt16LE(i + 8);
      const compSize = zip.readUInt32LE(i + 18);
      const nameLen = zip.readUInt16LE(i + 26);
      const extraLen = zip.readUInt16LE(i + 28);
      const name = zip.toString('utf8', i + 30, i + 30 + nameLen);
      if (!/ffmpeg\.exe$/i.test(name) || compSize === 0) continue;
      const dataStart = i + 30 + nameLen + extraLen;
      const data = zip.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
    } catch {
      // 不是合法文件头：继续往后找
    }
  }
  throw new Error('zip 里没找到 ffmpeg.exe');
}

async function main() {
  const current = statSize();
  log(`目标：${TARGET}`);
  if (printOnly) {
    log(current ? `已存在（${(current / 1048576).toFixed(1)} MB）` : '尚未安装（桥接会退回纯 JS 的 GIF 兜底）');
    return;
  }
  if (current && !force) {
    log(`已存在（${(current / 1048576).toFixed(1)} MB），跳过。要重下请加 --force`);
    return;
  }
  if (process.platform !== 'win32') {
    log('本脚本只处理 Windows 版 ffmpeg；其它平台请用系统包管理器安装');
    return;
  }

  fs.mkdirSync(TARGET_DIR, { recursive: true });
  let bin = null;
  for (const url of MIRRORS) {
    try {
      log(`尝试镜像：${url}`);
      const gz = await httpGet(url);
      const raw = zlib.gunzipSync(gz);
      if (raw.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('解出来的不是 exe');
      bin = raw;
      break;
    } catch (error) {
      log(`  失败：${error?.message ?? error}`);
    }
  }
  if (!bin) {
    try {
      log(`回退官方源（较慢）：${OFFICIAL}`);
      bin = unzipFfmpeg(await httpGet(OFFICIAL));
    } catch (error) {
      log(`  失败：${error?.message ?? error}`);
    }
  }
  if (!bin) {
    log('❌ 下载失败。这不影响 GIF：桥接会自动改用纯 JS 解码兜底；仅语音音量处理需要 ffmpeg。');
    log('   手动装好后把路径写进 config.json 的 socialV2.voice.ffmpegPath 即可。');
    return;
  }

  const tmp = `${TARGET}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, bin);
  fs.rmSync(TARGET, { force: true });
  fs.renameSync(tmp, TARGET);
  log(`✅ 已安装 ${TARGET}（${(bin.length / 1048576).toFixed(1)} MB）`);
}

await main();
