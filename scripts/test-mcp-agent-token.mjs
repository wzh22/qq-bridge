// 静态审计：所有会打到 /api/socialV2/* 的 MCP 工具，必须**同时**做到两件事——
//   ① schema 里声明 `token` 参数（否则模型根本没有这个入参，必然漏传）
//   ② 请求时把 `x-agent-token` 头带上（桥接只认这个头，body 里的 token 不作数）
//
// 为什么值得单独一个测试：
//   2026-10 实际出现过一次线上故障——`qq_send_qzone` 的 schema 没有 token，
//   agentApi 也没带 x-agent-token。而 `agentHeaders()` 一定会加 `x-agent-call: 1`，
//   桥接的集中关卡（bridge.js 的 startConsoleServer）看到「声明是智能体调用 + 没带令牌
//   + 路径不在无令牌白名单」就一律 403。于是 AI 一让发说说就回「会话令牌无效」，
//   而模型手里其实**拿不到**那个令牌——它压根没有这个参数。
//   端点本身的测试（test-send-qzone.mjs）全绿，因为它直接带 header 打桥接，
//   根本没走 MCP 这一层。所以故障在两侧测试之间漏了过去。
//
// 判据故意做成静态扫描：运行时要 mock 太多（fetch、令牌、模式），
// 而「schema 有 token ⇔ 代码里有 x-agent-token」是纯文本事实，扫得准、跑得快。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const SOURCE_PATH = new URL('../src/mcp-snowluma-safe.js', import.meta.url);
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

/**
 * 从源码里切出每个 `server.tool(...)` 调用的完整片段。
 *
 * 不用正则硬匹配整块（工具描述里含括号、引号、换行，正则很容易切歪），
 * 而是按括号配数扫描：从 `server.tool(` 起，数到第 0 层闭合为止。
 * 字符串字面量里的括号会干扰配数，所以先做一个**保留长度的掩码**，
 * 把字符串内部替换成空格（引号本身保留），再在掩码上数括号。
 */
function maskStringContents(text) {
  const out = text.split('');
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) { quote = null; continue; }
      out[i] = ' ';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    // 注释整段掩掉，避免注释里的括号/关键字干扰
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out[i] = ' '; i += 1; }
      if (i < text.length) { out[i] = ' '; out[i + 1] = ' '; i += 1; }
      continue;
    }
  }
  return out.join('');
}

function sliceToolBlocks(text) {
  const masked = maskStringContents(text);
  const blocks = [];
  const marker = 'server.tool(';
  let from = 0;
  for (;;) {
    const start = masked.indexOf(marker, from);
    if (start === -1) break;
    let depth = 0;
    let i = start + marker.length - 1; // 指向 `(`
    let end = -1;
    for (; i < masked.length; i += 1) {
      const ch = masked[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) break;
    blocks.push({ start, end, text: text.slice(start, end) });
    from = end;
  }
  return blocks;
}

function toolNameOf(block) {
  const m = /server\.tool\(\s*['"]([^'"]+)['"]/.exec(block);
  return m ? m[1] : null;
}

const blocks = sliceToolBlocks(source)
  .map((b) => ({ name: toolNameOf(b.text), text: b.text }))
  .filter((b) => b.name);

test('扫描到的工具数量合理（防止切片逻辑失效导致空跑通过）', () => {
  assert.ok(blocks.length >= 30, `只切出 ${blocks.length} 个工具，切片逻辑可能坏了`);
});

test('凡是调用 /api/socialV2/* 的工具，都必须声明 token 且带上 x-agent-token 头', () => {
  const offenders = [];
  for (const { name, text } of blocks) {
    if (!text.includes('/api/socialV2/')) continue;
    const declaresToken = /\btoken:\s*z\.string\(\)/.test(text);
    const sendsHeader = /['"]x-agent-token['"]\s*:/.test(text);
    if (!declaresToken || !sendsHeader) {
      offenders.push({
        name,
        declaresToken,
        sendsHeader,
        why: !declaresToken
          ? 'schema 没有 token 参数（模型无法传令牌）'
          : '请求未带 x-agent-token 头（桥接会判 403）'
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下工具在 reserved2 下必然被桥接拒绝：\n${offenders.map((o) => `  - ${o.name}: ${o.why}`).join('\n')}`
  );
});

test('qq_send_qzone 明确具备令牌入参与请求头（回归 2026-10 的「会话令牌无效」故障）', () => {
  const block = blocks.find((b) => b.name === 'qq_send_qzone');
  assert.ok(block, '找不到 qq_send_qzone 工具定义');
  assert.match(block.text, /\btoken:\s*z\.string\(\)/, 'qq_send_qzone 必须声明 token 参数');
  assert.match(block.text, /['"]x-agent-token['"]\s*:\s*token/, 'qq_send_qzone 必须把 token 放进 x-agent-token 头');
  assert.match(block.text, /headers:\s*\{/, 'qq_send_qzone 必须带 headers 传给 agentApi');
});

test('qq_set_self_avatar / qq_set_self_nickname 同样具备令牌（同类漏传已修）', () => {
  for (const name of ['qq_set_self_avatar', 'qq_set_self_nickname']) {
    const block = blocks.find((b) => b.name === name);
    assert.ok(block, `找不到 ${name} 工具定义`);
    assert.match(block.text, /\btoken:\s*z\.string\(\)/, `${name} 必须声明 token 参数`);
    assert.match(block.text, /['"]x-agent-token['"]\s*:\s*token/, `${name} 必须带 x-agent-token 头`);
  }
});
