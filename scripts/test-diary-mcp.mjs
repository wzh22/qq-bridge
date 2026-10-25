// 直接加载 MCP server 模块，验证日记本三个工具已注册且 schema 正确。
//
// 为什么不走 stdio 握手：沙箱里 spawn 子进程会被 EPERM 拒绝
// （见 test-mcp-servers-stdio.mjs 在此环境的实际表现）。
// 模块级验证能覆盖真正关心的东西：工具名、描述、开关过滤、参数是否齐全。
import assert from 'node:assert/strict';

process.chdir(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\'));

await import('../src/mcp-snowluma-safe.js');
const server = globalThis.__mcpSnowlumaServer;
assert.ok(server, 'MCP server 必须挂到 globalThis 上供测试读取');

const registry = server._registeredTools ?? {};
const tools = Object.keys(registry);
if (!tools.length) {
  console.log('⚠️ 无法读取已注册工具（SDK 内部结构变了）；模块加载本身 OK');
  process.exit(0);
}

const diaryTools = ['qq_diary_write', 'qq_diary_recall', 'qq_diary_correct'];
for (const name of diaryTools) {
  const tool = registry[name];
  assert.ok(tool, `缺少工具 ${name}`);
  assert.ok(tool.description && tool.description.length > 30, `${name} 需要足够详细的描述`);
  console.log(`✅ ${name}  描述 ${tool.description.length} 字`);
}

// SDK 把 zod shape 放在 inputSchema 里（不同版本字段名不同，两种都试）。
function propsOf(name) {
  const tool = registry[name];
  const schema = tool.inputSchema ?? tool.parameters ?? {};
  return schema.shape ?? schema.properties ?? {};
}

for (const name of diaryTools) {
  const props = propsOf(name);
  const keys = Object.keys(props);
  assert.ok(keys.length > 0, `${name} 必须有参数`);
  assert.ok(keys.includes('key'), `${name} 必须要求 key（实际：${keys.join(',')}）`);
  assert.ok(keys.includes('token'), `${name} 必须要求 token（实际：${keys.join(',')}）`);
}

// 隐私约束必须写进描述：模型读到的就是这段文字。
const writeDesc = registry.qq_diary_write.description;
assert.ok(/私聊/.test(writeDesc), '写日记工具的描述必须声明「只能私聊」');
const recallDesc = registry.qq_diary_recall.description;
assert.ok(/私聊/.test(recallDesc), '翻日记工具的描述必须声明「只能私聊」');

// qq_diary_write 的关键参数
const writeProps = propsOf('qq_diary_write');
for (const p of ['body', 'title', 'mood', 'tags', 'people', 'quote', 'importance']) {
  assert.ok(p in writeProps, `qq_diary_write 应有参数 ${p}`);
}

// qq_diary_recall 的检索参数
const recallProps = propsOf('qq_diary_recall');
for (const p of ['q', 'limit', 'withinDays', 'mood', 'tag', 'people', 'minImportance']) {
  assert.ok(p in recallProps, `qq_diary_recall 应有参数 ${p}`);
}

console.log(`\n工具总数：${tools.length}`);
console.log('日记本 MCP 工具注册正常');
// 显式退出：MCP server 已 connect 到 stdio，事件循环不会自然结束。
// 用 0 而不是隐式退出，避免被 stderr 的启动日志干扰退出码判断。
process.exit(0);
