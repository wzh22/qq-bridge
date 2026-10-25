#!/usr/bin/env node
// B 站扫码登录（可选）。
//
// 作用：拿一个 B 站账号的 SESSDATA 写进 config.json，让机器人能取「逐字字幕」。
// 不登录也能用，只是拿不到字幕（详见 docs/guides/BILIBILI.md）。
//
// 用法：
//   node scripts/bili-login.mjs
//
// 两种完成方式：
//   ① 扫码：脚本会输出二维码图片路径（state/tmp/bili-qr.png），用 B 站 App 扫。
//      注意二维码约 3 分钟过期；过期后重跑本脚本即可。
//   ② 手动填：直接编辑 config.json 的 socialV2.bilibili.sessdata。
//
// 安全：
//   - 只调 passport 的 qrcode 接口，不碰任何写操作；
//   - 拿到的 SESSDATA **不打印**，只写进 config.json；
//   - 只想撤销时把 sessdata 清空即可。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://passport.bilibili.com';
const TMP = path.join(ROOT, 'state', 'tmp');

async function getJson(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com' },
    signal: AbortSignal.timeout(15000)
  });
  const json = await r.json();
  // ⚠️ 关键：新版 B 站登录成功后**响应体里没有 cookie_info**，
  // 凭据只出现在响应的 Set-Cookie 头里（旧版才有 data.cookie_info.cookies）。
  // 2026-10-25 实测踩坑：只读 body 会得到「登录成功但没解析到 SESSDATA」，
  // 而此时 ticket 已被消耗，只能重新扫码。所以必须同时取响应头。
  const setCookie = typeof r.headers.getSetCookie === 'function'
    ? r.headers.getSetCookie()
    : [r.headers.get('set-cookie')].filter(Boolean);
  return { json, setCookie };
}

/** 从 Set-Cookie 头里抽出需要的凭据。 */
function cookiesFromHeaders(setCookieList) {
  const map = {};
  for (const line of setCookieList) {
    const [pair] = String(line).split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name && value) map[name] = value;
  }
  return map;
}

function saveCredentials(data, headerCookies = {}) {
  const cookies = data?.cookie_info?.cookies || [];
  const map = { ...headerCookies };
  for (const c of cookies) map[c.name] = c.value;

  // 有时凭据只在返回 url 的 query 里
  const url = String(data?.url || '');
  if (url) {
    try {
      const q = new URL(url).searchParams;
      if (!map.SESSDATA && q.get('SESSDATA')) map.SESSDATA = q.get('SESSDATA');
      if (!map.bili_jct && q.get('bili_jct')) map.bili_jct = q.get('bili_jct');
      if (!map.DedeUserID && q.get('DedeUserID')) map.DedeUserID = q.get('DedeUserID');
    } catch {}
  }
  if (!map.SESSDATA) return null;

  const cfgPath = path.join(ROOT, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!cfg.socialV2) cfg.socialV2 = {};
  if (!cfg.socialV2.bilibili) cfg.socialV2.bilibili = {};
  cfg.socialV2.bilibili.sessdata = map.SESSDATA;
  if (map.bili_jct) cfg.socialV2.bilibili.bili_jct = map.bili_jct;
  if (map.DedeUserID) cfg.socialV2.bilibili.dedeUserId = map.DedeUserID;
  if (data?.refresh_token) cfg.socialV2.bilibili.refreshToken = data.refresh_token;
  cfg.socialV2.bilibili.savedAt = new Date().toISOString();
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { uid: map.DedeUserID, sessdataLength: map.SESSDATA.length };
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const gen = await getJson(`${BASE}/x/passport-login/web/qrcode/generate`);
const genData = gen.json;
if (genData.code !== 0 || !genData.data?.url) {
  console.error('生成二维码失败：', JSON.stringify(genData).slice(0, 200));
  process.exit(1);
}
const { url, qrcode_key: key } = genData.data;

fs.mkdirSync(TMP, { recursive: true });
const pngPath = path.join(TMP, 'bili-qr.png');
try {
  const img = await fetch(
    `https://api.qrserver.com/v1/create-qr-code/?size=520x520&margin=12&data=${encodeURIComponent(url)}`,
    { signal: AbortSignal.timeout(25000) }
  );
  const buf = Buffer.from(await img.arrayBuffer());
  // 校验 PNG 魔数，避免把一段错误页当成图片存下来
  if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {
    fs.writeFileSync(pngPath, buf);
    console.log(`二维码图片：${pngPath}`);
  } else {
    console.log('二维码图片下载失败，请直接用这个链接生成：');
    console.log(url);
  }
} catch {
  console.log('二维码图片下载失败，请直接用这个链接生成：');
  console.log(url);
}

console.log('请用 B 站 App 扫码；二维码约 3 分钟过期。');
console.log('等待扫码…');

const started = Date.now();
let last = '';
while (Date.now() - started < 180000) {
  let polled;
  try {
    polled = await getJson(`${BASE}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`);
  } catch (e) {
    console.log('轮询出错，重试：', e.message);
    await new Promise((r) => setTimeout(r, 2000));
    continue;
  }
  const json = polled.json;
  const code = json?.data?.code;
  if (code === 0) {
    // 凭据优先从 Set-Cookie 头取（新版接口），再看响应体（旧版兼容）
    const headerCookies = cookiesFromHeaders(polled.setCookie);
    const saved = saveCredentials(json.data, headerCookies);
    if (!saved) {
      console.error('登录成功但没拿到 SESSDATA。');
      console.error('  Set-Cookie 条数:', polled.setCookie.length);
      console.error('  响应体:', JSON.stringify(json.data).slice(0, 300));
      process.exit(1);
    }
    console.log(`✅ 已登录，凭据已写入 config.json（uid=${saved.uid || '?'}，SESSDATA 长度 ${saved.sessdataLength}）`);
    console.log('重启桥接后生效。');
    process.exit(0);
  }
  if (code === 86038) {
    console.log('❌ 二维码已过期，重跑本脚本即可。');
    process.exit(2);
  }
  const label = code === 86090 ? '📱 已扫码，请在手机上确认' : '⏳ 等待扫码…';
  if (label !== last) { console.log(label); last = label; }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('⏱ 超时（3 分钟），二维码已过期，重跑本脚本即可。');
process.exit(3);
