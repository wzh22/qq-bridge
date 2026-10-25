// 发 QQ 空间说说端点（/api/socialV2/send-qzone）的端到端测试。
// 这是影响面最大的能力（公开发布），重点验证拒绝路径与默认关闭。
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
  config: { consoleToken: CONSOLE_TOKEN, socialV2: { tools: { sendQzone: true } } },
});
h.setMode('reserved2');
const ROOT = h.temp;
const agentToken = h.getSocialV2State('private:123').agentToken;

h.cfg.consolePort = 3197;
const server = h.startConsoleServer();
await new Promise((r) => setTimeout(r, 300));
const port = server.address().port;

const imgDir = path.join(ROOT, 'state', 'qzone');
fs.mkdirSync(imgDir, { recursive: true });
fs.writeFileSync(path.join(imgDir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
fs.writeFileSync(path.join(imgDir, 'evil.js'), 'x');
const outside = path.join(path.dirname(ROOT), 'outside.png');
fs.writeFileSync(outside, 'x');

const post = (body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port, path: '/api/socialV2/send-qzone', method: 'POST',
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

console.log('\n=== 功能 ===');
await tap('纯文字说说调 send_qzone_msg', async () => {
  const r = await post({ content: '今天天气不错' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const up = h.calls.http.find((c) => String(c.url).endsWith('/send_qzone_msg'));
  assert.ok(up, '未调用 send_qzone_msg');
  assert.equal(up.body.content, '今天天气不错');
  assert.equal(up.body.ugc_right, 1);
});
await tap('带图说说转成 file:// 且限制在目录内', async () => {
  const r = await post({ content: '配图', images: ['state/qzone/pic.png'], ugcRight: 64 });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const ups = h.calls.http.filter((c) => String(c.url).endsWith('/send_qzone_msg'));
  const last = ups[ups.length - 1];
  assert.ok(Array.isArray(last.body.images) && last.body.images.length === 1);
  assert.match(last.body.images[0], /^file:\/\//);
  assert.equal(last.body.ugc_right, 64);
});

console.log('\n=== 拒绝路径 ===');
await tap('拒绝空正文', async () => {
  const r = await post({ content: '  ' });
  assert.equal(r.body.ok, false);
});
await tap('拒绝超长正文', async () => {
  const r = await post({ content: 'x'.repeat(2001) });
  assert.equal(r.body.ok, false);
});
await tap('拒绝非法 ugcRight', async () => {
  const r = await post({ content: 'x', ugcRight: 999 });
  assert.equal(r.body.ok, false);
});
await tap('拒绝非图片扩展名', async () => {
  const r = await post({ content: 'x', images: ['state/qzone/evil.js'] });
  assert.equal(r.body.ok, false);
});
await tap('拒绝 http:// 让网关代抓', async () => {
  const r = await post({ content: 'x', images: ['https://evil.invalid/a.png'] });
  assert.equal(r.body.ok, false);
});
await tap('拒绝 .. 穿越图片', async () => {
  const r = await post({ content: 'x', images: ['../outside.png'] });
  assert.equal(r.body.ok, false);
});
await tap('拒绝绝对路径图片', async () => {
  const r = await post({ content: 'x', images: ['C:/Windows/x.png'] });
  assert.equal(r.body.ok, false);
});

console.log('\n=== 出站内容审计（说说=公开发布，比私聊更严）===');
await tap('正文含本机绝对路径 → 拦截', async () => {
  const r = await post({ content: '我的文件在 C:\\Users\\wzh24\\secret.txt' });
  assert.equal(r.body.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /敏感|阻止/);
});
await tap('正文含令牌赋值 → 拦截', async () => {
  const r = await post({ content: 'config: token=abcdef123456' });
  assert.equal(r.body.ok, false);
  assert.equal(r.status, 403);
});
await tap('拦截后没有真的调用网关', async () => {
  const before = h.calls.http.filter((c) => String(c.url).endsWith('/send_qzone_msg')).length;
  await post({ content: '见 C:\\Users\\wzh24\\a.txt' });
  const after = h.calls.http.filter((c) => String(c.url).endsWith('/send_qzone_msg')).length;
  assert.equal(after, before, '被拦截的内容不应发出');
});

console.log('\n=== 默认关闭 ===');
await tap('源码里 sendQzone 默认 false', async () => {
  const src = fs.readFileSync('E:/dsh/qq-bridge/src/bridge.js', 'utf8');
  assert.match(src, /sendQzone:\s*false/);
});

console.log(`\n结果: pass ${pass} / fail ${fail}`);
server.close();
try { fs.unlinkSync(outside); } catch {}
await h.close?.();
process.exit(fail ? 1 : 0);
