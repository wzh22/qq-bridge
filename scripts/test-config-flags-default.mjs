// 控制台保存配置时，**默认关闭的工具开关不能被静默打开**。
//
// 背景：/api/socialV2/config 的 tools 归一化用
//   if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
// 兜底。若新增开关没有登记进 toolFlags，那么"提交里没带这个 key"时
// undefined !== false → true，保存一次就把默认关闭的能力（发文件/改头像/改昵称/
// 发空间）悄悄打开了。这是**失败开放**，必须锁死。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from 'file:///E:/dsh/qq-bridge/scripts/audit-bridge-harness.mjs';

let pass = 0, fail = 0;
const tap = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' :: ' + (e?.message ?? e)); fail++; }
};

const CONSOLE_TOKEN = 'fixture-console-token';
const h = await bridgeHarness({ mode: 'reserved2', config: { consoleToken: CONSOLE_TOKEN } });
h.setMode('reserved2');
h.cfg.consolePort = 3196;
const server = h.startConsoleServer();
await new Promise((r) => setTimeout(r, 300));
const port = server.address().port;

const post = (p, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port, path: p, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-console-token': CONSOLE_TOKEN },
  }, (res) => {
    let buf = '';
    res.on('data', (c) => (buf += c));
    res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
  });
  req.on('error', reject);
  req.end(data);
});

const RISKY = ['sendDocument', 'setAvatar', 'setNickname', 'sendQzone'];

console.log('\n=== 新开关必须是默认关闭且保存后仍关闭 ===');
await tap('源码默认表里四个新开关都是 false', async () => {
  const src = fs.readFileSync('E:/dsh/qq-bridge/src/bridge.js', 'utf8');
  for (const k of RISKY) assert.match(src, new RegExp(`${k}:\\s*false`), `${k} 默认值不是 false`);
});
await tap('登录 toolFlags 白名单（否则保存一次就会被打开）', async () => {
  const src = fs.readFileSync('E:/dsh/qq-bridge/src/bridge.js', 'utf8');
  const m = src.match(/const toolFlags = \[([\s\S]*?)\];/);
  assert.ok(m, '找不到 toolFlags');
  for (const k of RISKY) assert.ok(m[1].includes(`'${k}'`), `${k} 未登记进 toolFlags`);
});
await tap('提交不含新开关的配置后，文件里不会出现 true', async () => {
  const r = await post('/api/socialV2/config', { tools: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cfg = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
  for (const k of RISKY) {
    assert.notEqual(cfg.socialV2?.tools?.[k], true, `${k} 被静默打开`);
  }
});

console.log(`\n结果: pass ${pass} / fail ${fail}`);
server.close();
await h.close?.();
process.exit(fail ? 1 : 0);
