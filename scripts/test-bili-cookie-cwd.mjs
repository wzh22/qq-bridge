// 验证 MCP server 在不同 cwd 下都能读到 config.json 里的 SESSDATA。
// 这是一个真实踩过的坑：projectRoot() 曾用 process.argv[1] + cwd 推导，
// 桥接重启后 cwd 不是仓库根，于是「写了 sessdata 却报未配置」。
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SCRIPT = 'E:/dsh/qq-bridge/src/mcp-bilibili-safe.js';
const NODE = process.execPath;

// 故意用几个**不是仓库根**的 cwd 来启动
const CWDS = ['C:\\', 'C:\\Windows', process.env.TEMP || 'C:\\Temp'];

let failures = 0;
for (const cwd of CWDS) {
  const transport = new StdioClientTransport({
    command: NODE,
    args: [SCRIPT],
    cwd,
    stderr: 'ignore'
  });
  const client = new Client({ name: 'cookie-cwd-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const res = await client.callTool({ name: 'bilibili_status', arguments: {} });
    const text = (res.content || []).map((c) => c.text || '').join('\n');
    const configured = /已配置/.test(text);
    console.log(`${configured ? '✅' : '❌'} cwd=${cwd}  ${configured ? '读到 Cookie' : '未读到 Cookie'}`);
    if (!configured) {
      failures += 1;
      console.log('   ' + text.split('\n').filter(Boolean).join('\n   '));
    }
    await client.close();
  } catch (error) {
    failures += 1;
    console.log(`❌ cwd=${cwd} 出错: ${error.message}`);
    try { await client.close(); } catch {}
  }
}

console.log(failures === 0
  ? '\n✅ 所有 cwd 都能读到 Cookie（projectRoot 修复有效）'
  : `\n❌ ${failures} 个 cwd 读不到 Cookie`);
if (failures) process.exit(1);
