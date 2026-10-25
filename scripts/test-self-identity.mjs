// 头像 / 昵称端点（/api/socialV2/set-avatar、set-nickname）的端到端测试。
// 重点仍是**拒绝路径**：这两个接口能改账号对外身份并读本地图片。
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
const h = await bridgeHarness({
  mode: 'reserved2',
  config: { consoleToken: CONSOLE_TOKEN, socialV2: { tools: { setAvatar: true, setNickname: true } } },
});
h.setMode('reserved2');
const ROOT = h.temp;
const st = h.getSocialV2State('private:123');
const agentToken = st.agentToken;

h.cfg.consolePort = 3198;
const server = h.startConsoleServer();
await new Promise((r) => setTimeout(r, 300));
const port = server.address().port;

// 夹具
const imgDir = path.join(ROOT, 'state', 'avatar');
fs.mkdirSync(imgDir, { recursive: true });
fs.writeFileSync(path.join(imgDir, 'me.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
fs.writeFileSync(path.join(imgDir, 'evil.js'), 'console.log(1)');
const outside = path.join(path.dirname(ROOT), 'outside.png');
fs.writeFileSync(outside, 'outside');

const post = (p, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port, path: p, method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data),
      'x-console-token': CONSOLE_TOKEN,
      'x-agent-token': agentToken,
    },
  }, (res) => {
    let buf = '';
    res.on('data', (c) => (buf += c));
    res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
  });
  req.on('error', reject);
  req.end(data);
});

console.log('\n=== 头像 ===');
await tap('合法 png 调 set_qq_avatar', async () => {
  const r = await post('/api/socialV2/set-avatar', { path: 'state/avatar/me.png' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const up = h.calls.http.find((c) => String(c.url).endsWith('/set_qq_avatar'));
  assert.ok(up, '未调用 set_qq_avatar');
  assert.ok(String(up.body.file).includes('me.png'));
});
await tap('拒绝非图片扩展名', async () => {
  const r = await post('/api/socialV2/set-avatar', { path: 'state/avatar/evil.js' });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /只支持|图片/);
});
await tap('拒绝 .. 穿越', async () => {
  const r = await post('/api/socialV2/set-avatar', { path: '../outside.png' });
  assert.equal(r.body.ok, false);
});
await tap('拒绝绝对路径', async () => {
  const r = await post('/api/socialV2/set-avatar', { path: 'C:/Windows/win.ini' });
  assert.equal(r.body.ok, false);
});
await tap('拒绝不存在的图片', async () => {
  const r = await post('/api/socialV2/set-avatar', { path: 'state/avatar/nope.png' });
  assert.equal(r.body.ok, false);
});

console.log('\n=== 昵称 ===');
await tap('合法昵称调 set_self_longnick', async () => {
  const r = await post('/api/socialV2/set-nickname', { name: '鱏鯉' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const up = h.calls.http.find((c) => String(c.url).endsWith('/set_self_longnick'));
  assert.ok(up, '未调用 set_self_longnick');
  assert.equal(up.body.longNick, '鱏鯉');
});
await tap('拒绝空昵称', async () => {
  const r = await post('/api/socialV2/set-nickname', { name: '   ' });
  assert.equal(r.body.ok, false);
});
await tap('拒绝超长昵称', async () => {
  const r = await post('/api/socialV2/set-nickname', { name: 'x'.repeat(41) });
  assert.equal(r.body.ok, false);
});

console.log('\n=== 开关默认关闭 ===');
await tap('源码里 setAvatar/setNickname 默认 false', async () => {
  const src = fs.readFileSync('E:/dsh/qq-bridge/src/bridge.js', 'utf8');
  assert.match(src, /setAvatar:\s*false/);
  assert.match(src, /setNickname:\s*false/);
});

console.log(`\n结果: pass ${pass} / fail ${fail}`);
server.close();
try { fs.unlinkSync(outside); } catch {}
await h.close?.();
process.exit(fail ? 1 : 0);
