// 测试用的 DSH 地址解析。
//
// 背景：一批 test-dsh-*.mjs / test-onebot-*.mjs 里写着
//   const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';
// 3080 是**旧版 DSH 的固定端口**。现在 DSH 每次启动挑高位随机端口（当前是 53499），
// guardian 会把它自动同步进 config.json 的 dsh.baseUrl。于是这些测试默认全部
// ECONNREFUSED —— 明明 DSH 活得好好的，只因为测试认死了一个过时不存在的端口。
//
// 这里按可靠性排序解析：
//   1. 显式环境变量 DSH_BASE_URL（想临时指向别处时用）
//   2. config.json 的 dsh.baseUrl（guardian 维护，最贴近实际在跑的那个）
//   3. 回退到旧默认 3080（纯离线/无配置环境下保持原行为）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const LEGACY_DEFAULT = 'http://127.0.0.1:3080';

export function resolveDshBaseUrl() {
  const fromEnv = String(process.env.DSH_BASE_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  try {
    const cfgPath = path.join(ROOT, 'config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '');
    const base = String(JSON.parse(raw)?.dsh?.baseUrl || '').trim();
    if (/^https?:\/\//i.test(base)) return base.replace(/\/+$/, '');
  } catch { /* 配置缺失或损坏时退回默认 */ }
  return LEGACY_DEFAULT;
}

/** 探测 DSH 是否真的可达（避免在没起服务时把「连不上」误报成代码失败）。 */
export async function dshReachable(baseUrl, timeoutMs = 3000) {
  try {
    const res = await fetch(`${baseUrl}/api/settings/describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: {} }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    // 401 也算「在」——服务活着，只是没带鉴权。
    return res.status < 500;
  } catch {
    return false;
  }
}
