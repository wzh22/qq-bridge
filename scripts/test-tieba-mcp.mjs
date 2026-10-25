// 通过 stdio 真实启动 tieba-safe MCP server，跑一次握手 + 调用全部工具。
// 这是端到端验证：模拟 DSH 作为 MCP 客户端的行为，确认工具真的能用。
import { spawn } from 'node:child_process';
import path from 'node:path';

const REPO = 'E:/dsh/qq-bridge';
const script = path.join(REPO, 'src', 'mcp-tieba-safe.js');

const child = spawn(process.execPath, [script], {
  cwd: REPO,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env }
});

let buf = '';
const pending = new Map();
let nextId = 1;

function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 180000);
  });
}

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg);
    }
  }
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

const textOf = (res) => (res?.result?.content || []).map((c) => c.text || '').join('\n');
const isErr = (res) => res?.result?.isError === true;

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`); }
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' }
  });
  console.log(`initialize: ${init.result?.serverInfo?.name} (${init.result?.protocolVersion})`);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  console.log('\n工具清单:');
  for (const t of list.result.tools) console.log(`  · ${t.name} — ${String(t.description).slice(0, 44)}`);

  console.log('\n=== 工具注册检查 ===');
  for (const n of ['tieba_status', 'tieba_read_forum', 'tieba_read_thread', 'tieba_learn_style']) {
    check(`注册了 ${n}`, names.includes(n));
  }

  console.log('\n=== tieba_status ===');
  const st = await rpc('tools/call', { name: 'tieba_status', arguments: {} });
  const stText = textOf(st);
  console.log(stText.split('\n').map((l) => '  | ' + l).join('\n'));
  check('状态可读', stText.length > 0);
  check('报告端口可用', /可用/.test(stText));

  console.log('\n=== tieba_read_forum（孙笑川吧，3 条）===');
  const fm = await rpc('tools/call', { name: 'tieba_read_forum', arguments: { forum: '孙笑川', max: 3 } });
  const fmText = textOf(fm);
  console.log(fmText.split('\n').slice(0, 14).map((l) => '  | ' + l).join('\n'));
  check('未报错', !isErr(fm));
  check('拿到帖子列表', /📋/.test(fmText));
  check('含贴吧链接', /tieba\.baidu\.com\/p\//.test(fmText));

  console.log('\n=== tieba_read_thread（8240361306，5 层）===');
  const th = await rpc('tools/call', { name: 'tieba_read_thread', arguments: { thread: '8240361306', maxFloors: 5 } });
  const thText = textOf(th);
  console.log(thText.split('\n').slice(0, 16).map((l) => '  | ' + l).join('\n'));
  check('未报错', !isErr(th));
  check('有标题', /《.+》/.test(thText));
  check('有楼层', /楼层：\d+/.test(thText));

  console.log('\n=== tieba_read_thread（传完整链接）===');
  const th2 = await rpc('tools/call', {
    name: 'tieba_read_thread',
    arguments: { thread: 'https://tieba.baidu.com/p/11133815523', maxFloors: 3 }
  });
  check('链接形式也能解析', !isErr(th2));

  console.log('\n=== 错误处理：不存在的帖子 ===');
  const bad = await rpc('tools/call', { name: 'tieba_read_thread', arguments: { thread: 'abc' } });
  check('无效 id 被拒绝', isErr(bad));

  console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
  if (stderr.trim()) console.log('\nstderr:', stderr.slice(0, 600));
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.log('❌ 测试异常:', e.message);
  if (stderr) console.log('stderr:', stderr.slice(0, 800));
  process.exitCode = 1;
} finally {
  child.kill();
}
