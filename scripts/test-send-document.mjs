// 文档发送端点（/api/socialV2/send-document）的端到端测试。
//
// 真值测试：用 harness 起真实控制台服务，打 HTTP 请求。
// 这条能力的风险是"把本机文件外发到 QQ"，所以重点在**拒绝路径**。
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
  config: { consoleToken: CONSOLE_TOKEN, socialV2: { tools: { sendDocument: true } } },
});
// harness 的 mode 选项只影响状态文件；把运行时模式显式切到 reserved2，否则端点一律 403。
h.setMode('reserved2');
const ROOT = h.temp;

// 建一个私聊会话并拿 agentToken
const st = h.getSocialV2State('private:123');
const agentToken = st.agentToken;
assert.ok(agentToken, 'agentToken 未生成');

// 显式端口，避免和运行中的桥接抢 3100
h.cfg.consolePort = 3199;
const server = h.startConsoleServer();
await new Promise((r) => setTimeout(r, 300));
const port = server.address().port;
console.log('测试控制台端口:', port);

// 夹具
const outDir = path.join(ROOT, 'state', 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'report.docx'), 'fake docx content');
fs.writeFileSync(path.join(outDir, 'evil.js'), 'console.log(1)');
fs.writeFileSync(path.join(outDir, 'big.pdf'), Buffer.alloc(31 * 1024 * 1024));
const outside = path.join(path.dirname(ROOT), 'secret-outside.pdf');
fs.writeFileSync(outside, 'outside secret');

const post = (body, token = agentToken) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port, path: '/api/socialV2/send-document', method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data),
      'x-console-token': CONSOLE_TOKEN,
      'x-agent-token': token,
      host: `127.0.0.1:${port}`,
    },
  }, (res) => {
    let buf = '';
    res.on('data', (c) => (buf += c));
    res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
  });
  req.on('error', reject);
  req.end(data);
});

const K = 'private:123';

console.log('\n=== 功能：合法文件应被上传 ===');
await tap('docx 走 upload_private_file', async () => {
  const r = await post({ key: K, path: 'state/out/report.docx' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const up = h.calls.http.find((c) => String(c.url).endsWith('/upload_private_file'));
  assert.ok(up, '未调用 upload_private_file');
  assert.equal(up.body.user_id, 123);
  assert.ok(String(up.body.file).includes('report.docx'));
});

console.log('\n=== 拒绝路径 ===');
await tap('拒绝 .. 穿越', async () => {
  const r = await post({ key: K, path: '../../secret.pdf' });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /\.\.|工作目录内/);
});
await tap('拒绝绝对路径', async () => {
  const r = await post({ key: K, path: 'C:/Windows/win.ini' });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /相对路径|\.\./);
});
await tap('拒绝脚本扩展名 .js', async () => {
  const r = await post({ key: K, path: 'state/out/evil.js' });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /不允许发送/);
});
await tap('拒绝超大文件（>30MB）', async () => {
  const r = await post({ key: K, path: 'state/out/big.pdf' });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /过大/);
});
await tap('拒绝目录', async () => {
  const r = await post({ key: K, path: 'state/out' });
  assert.equal(r.body.ok, false);
});
await tap('拒绝不存在的文件', async () => {
  const r = await post({ key: K, path: 'state/out/nope.pdf' });
  assert.equal(r.body.ok, false);
});
await tap('拒绝工作区外文件（realpath 校验）', async () => {
  const r = await post({ key: K, path: '../secret-outside.pdf' });
  assert.equal(r.body.ok, false);
});
await tap('拒绝错误 agent token', async () => {
  const r = await post({ key: K, path: 'state/out/report.docx' }, 'wrong-token');
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /token/i);
});
await tap('拒绝非白名单会话', async () => {
  const r = await post({ key: 'private:999999', path: 'state/out/report.docx' });
  assert.equal(r.body.ok, false);
});

console.log('\n=== 开关：默认关闭 ===');
await tap('源码默认表里 sendDocument=false', async () => {
  const src = fs.readFileSync('E:/dsh/qq-bridge/src/bridge.js', 'utf8');
  // 默认开关表里应明确写着 sendDocument: false（不加注释匹配）
  assert.match(src, /sendDocument:\s*false/);
});

console.log(`\n结果: pass ${pass} / fail ${fail}`);
server.close();
try { fs.unlinkSync(outside); } catch {}
await h.close?.();
process.exit(fail ? 1 : 0);
