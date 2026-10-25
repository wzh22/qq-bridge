// 百度贴吧只读 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// ── 为什么只读 ────────────────────────────────────────────────────────
//   与 mcp-bilibili-safe 同一条理由：QQ 机器人会在群聊里自主决定「我想看点
//   什么」，把发帖/回帖/点赞/关注交给概率模型去操作真账号 = 把不可逆副作用
//   外包给随机性。所以这里只有「读」，一个写接口都不给（src/tieba.js 里也没有）。
//
// ── 为什么必须走 CDP ─────────────────────────────────────────────────
//   实测（2026-10-25）：tieba.baidu.com 对普通 HTTP 客户端一律 403 + 百度
//   BIOC 人机验证。换 UA / 完整浏览器头 / 移动端 UA / 先拿 BAIDUID cookie /
//   curl / Invoke-WebRequest / node fetch / Edge headless —— 全部失败。
//   真实浏览器能正常访问。所以唯一不涉及「破解反爬」的正当路径是复用主人
//   **自己**已经通过验证的浏览器会话；CDP 是 Chrome/Edge 官方调试接口，
//   读的是渲染后的 DOM，验证由主人的浏览器正常完成。
//
//   代价：**必须有一个开着调试端口的浏览器**，否则工具会明确报错并告诉你怎么开，
//   而不是静默失败或绕路去爬。
//
// ── 工具面 ───────────────────────────────────────────────────────────
//   tieba_status       自检：CDP 通不通、有没有开着的浏览器
//   tieba_read_forum   读某个吧的帖子列表（轻量，用于「看看大家在聊什么」）
//   tieba_read_thread  读一个具体帖子的楼层与楼中楼
//   tieba_learn_style  采样若干吧的语料，返回**已压缩的语料文本**给模型做风格分析
//
//   注意 tieba_learn_style 只「取语料」，不自己调模型、不自己写文件 ——
//   MCP server 里没有模型。由机器人自己分析后再决定是否落盘
//   （风格档案的读写函数在 src/tieba.js 里，供桥接侧使用）。
//
//   采集是**慢操作**（每次导航间隔 1.4s 限速，防触发验证码），所以工具描述里
//   写明了耗时，避免人设把它当廉价工具反复调用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  fetchForumThreads, fetchThread, connectCdp,
  collectCorpus, renderCorpusForLearning, corpusStats
} from './tieba.js';

/**
 * 项目根目录。
 * 与 mcp-bilibili-safe.js 同样的坑与同样的解法：不能用 process.argv[1]
 *（DSH 以绝对路径 spawn，推断会失效），改用本文件的 __dirname。
 */
function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}
function fail(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// 查询词清洗：去 CQ 码、控制字符、超长截断
function sanitize(input, max = 40) {
  return String(input ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const DEFAULT_PORT = 9222;

/** 把连不上浏览器的错误翻译成可操作的提示。 */
function browserHint(error) {
  const msg = String(error?.message ?? error);
  if (/连不上浏览器调试端口|ECONNREFUSED|fetch failed/i.test(msg)) {
    return [
      '❌ 连不上浏览器调试端口 9222。',
      '',
      '贴吧对普通 HTTP 请求一律返回 403 + 人机验证，只能用真实浏览器读，',
      '所以需要主人先启动一个**开着调试端口**的浏览器。',
      '',
      '启动方式（任选其一）：',
      '  1. 运行项目里的脚本：scripts\\start-tieba-browser.ps1',
      '  2. 手动启动 Edge：',
      '     msedge.exe --remote-debugging-port=9222 --user-data-dir="<项目目录>\\state\\edge-cdp-profile"',
      '',
      '然后把「贴吧」网址打开一下、过掉可能的验证，再重试本工具。',
      '',
      `原始错误：${msg}`
    ].join('\n');
  }
  return `❌ 贴吧读取失败：${msg}`;
}

const server = new McpServer({ name: 'tieba-safe', version: '1.0.0' });

// ── 状态自检 ──────────────────────────────────────────────────────────────
server.tool(
  'tieba_status',
  '只读检查贴吧能力是否可用：浏览器调试端口（CDP）通不通。贴吧必须借助真实浏览器才能读。',
  {
    port: z.number().optional().describe('浏览器调试端口，默认 9222')
  },
  async ({ port }) => {
    const p = Number(port) || DEFAULT_PORT;
    try {
      const cdp = await connectCdp(p);
      const ver = cdp.version || {};
      const tabs = await cdp.tabs();
      const tiebaTabs = tabs.filter((t) => /tieba\.baidu\.com/i.test(String(t.url || '')));
      const lines = [
        `✅ 浏览器调试端口 ${p} 可用`,
        `   浏览器：${ver.Browser || '(未知)'}`,
        `   当前标签页：${tabs.length} 个${tiebaTabs.length ? `（其中 ${tiebaTabs.length} 个是贴吧页）` : ''}`,
        '',
        '→ 可以读取贴吧'
      ];
      if (!tiebaTabs.length) {
        lines.push('💡 建议先用这个浏览器打开一次 tieba.baidu.com，过掉可能的人机验证，再读会稳一些。');
      }
      return ok(lines.join('\n'));
    } catch (error) {
      return fail(browserHint(error));
    }
  }
);

// ── 读一个吧的帖子列表 ────────────────────────────────────────────────────
server.tool(
  'tieba_read_forum',
  [
    '只读某个贴吧的帖子列表（标题/作者/回复数/点赞数）。约 5~10 秒。',
    '用于「看看这个吧最近在聊什么」。要读帖子正文请用 tieba_read_thread。',
    '不登录、不发帖、不回帖。'
  ].join(''),
  {
    forum: z.string().describe('吧名，如「孙笑川」「考研」；带不带「吧」字都行'),
    max: z.number().optional().default(15).describe('最多返回几个帖子，1~30，默认 15'),
    port: z.number().optional().describe('浏览器调试端口，默认 9222')
  },
  async ({ forum, max, port }) => {
    const kw = sanitize(forum);
    if (!kw) return fail('吧名为空，已拒绝。');
    const n = Math.max(1, Math.min(30, Number(max) || 15));
    try {
      const r = await fetchForumThreads(kw, { max: n, port: Number(port) || DEFAULT_PORT });
      // ⚠️ 返回结构是 { ok, reason, forumName, threads }，没有 challenge 字段。
      //    早期这里读 r.challenge（永远是 undefined）→ 验证页被当成「没取到帖子」，
      //    用户看到的提示是「吧名可能不存在」，诊断方向被带偏。必须按 reason 判断。
      if (!r.ok && r.reason === 'challenge') {
        return fail('⚠️ 贴吧要求人机验证。请在浏览器里手动打开 tieba.baidu.com 过一次验证，然后重试。');
      }
      if (!r.threads?.length) {
        return ok(`「${kw}吧」没有取到帖子（吧名可能不存在，或页面结构变了）。`);
      }
      // 列表项字段：{ id, title, author, reply, like, url }。
      // ⚠️ 2026-10-25：这里一度写着「只有 id/title/summary/url，没有 author」——
      //    那是列表提取器重写**之前**的事实。重写后已能结构化拿到作者与统计，
      //    而 summary 字段已被删除（旧实现抓到的 summary 是整页文本的复制品）。
      //    只渲染有值的部分，避免老布局兜底路径输出一排「💬0 👍0」。
      const lines = r.threads.map((t, i) => {
        const meta = [
          t.author || '',
          Number(t.reply) ? `💬${t.reply}` : '',
          Number(t.like) ? `👍${t.like}` : ''
        ].filter(Boolean).join('　');
        return `${i + 1}. ${t.title}${meta ? `\n   ${meta}` : ''}\n   ${t.url}`;
      });
      return ok(`📋 ${r.forumName || `${kw}吧`}（${r.threads.length} 条）\n\n${lines.join('\n\n')}`);
    } catch (error) {
      return fail(browserHint(error));
    }
  }
);

// ── 读一个帖子 ────────────────────────────────────────────────────────────
server.tool(
  'tieba_read_thread',
  [
    '只读一个贴吧帖子的楼层与楼中楼。约 5~10 秒。',
    '需要帖子 id（网址里 /p/ 后面那串数字），或直接给完整网址。',
    '不登录、不发帖、不回帖。'
  ].join(''),
  {
    thread: z.string().describe('帖子 id（如 10957573781）或完整网址 https://tieba.baidu.com/p/xxx'),
    maxFloors: z.number().optional().default(20).describe('最多读几层，1~60，默认 20'),
    port: z.number().optional().describe('浏览器调试端口，默认 9222')
  },
  async ({ thread, maxFloors, port }) => {
    const raw = String(thread ?? '');
    const id = raw.match(/(\d{5,})/)?.[1];
    if (!id) return fail(`无法识别帖子 id：${raw.slice(0, 60)}`);
    const n = Math.max(1, Math.min(60, Number(maxFloors) || 20));
    try {
      const r = await fetchThread(id, { maxFloors: n, port: Number(port) || DEFAULT_PORT });
      if (!r.ok) {
        if (r.reason === 'challenge') {
          return fail('⚠️ 贴吧要求人机验证。请在浏览器里手动打开 tieba.baidu.com 过一次验证，然后重试。');
        }
        return fail(`读取失败：${r.detail || r.reason || '未知原因'}`);
      }
      if (!r.floors?.length) {
        return ok(`《${r.title}》没有取到楼层（可能是纯图片帖或页面结构变了）。\n${r.url || ''}`);
      }
      const body = r.floors.map((f, i) => {
        const head = `${i + 1}. ${f.author || '?'}${f.floor ? `（${f.floor}楼）` : ''}${f.date ? ` ${f.date}` : ''}${f.region ? ` ${f.region}` : ''}`;
        const lines = [head, `   ${f.content}`];
        for (const rep of (f.replies || []).slice(0, 6)) lines.push(`   ↳ ${rep}`);
        if ((f.replies || []).length > 6) lines.push(`   ↳ …还有 ${f.replies.length - 6} 条楼中楼`);
        return lines.join('\n');
      });
      return ok([
        `《${r.title}》`,
        r.forumName ? `吧：${r.forumName}` : '',
        `楼层：${r.floors.length}${r.total ? ` / 页面共 ${r.total} 层` : ''}`,
        '',
        body.join('\n\n'),
        '',
        `🔗 ${r.url || `https://tieba.baidu.com/p/${id}`}`
      ].filter(Boolean).join('\n'));
    } catch (error) {
      return fail(browserHint(error));
    }
  }
);

// ── 采样语料（供风格学习）──────────────────────────────────────────────────
server.tool(
  'tieba_learn_style',
  [
    '只读采集贴吧语料，用于学习「贴吧网友怎么说话」。**较慢**：要串行翻若干吧和帖子，',
    '按吧数×帖子数估算，通常 30 秒~3 分钟（内部限速 1.4 秒/次导航，防止触发验证码）。',
    '返回的是压缩后的语料纯文本，交给**你**去分析风格；本工具自己不调模型、不写文件。',
    '不登录、不发帖、不回帖。采集到的内容只在本次返回里，不会存到别处。'
  ].join(''),
  {
    forums: z.array(z.string()).optional().describe('要采样的吧名列表，如 ["孙笑川","考研"]。默认 ["孙笑川"]'),
    threadsPerForum: z.number().optional().default(3).describe('每个吧取几个帖子，1~10，默认 3'),
    floorsPerThread: z.number().optional().default(15).describe('每帖取几层，1~60，默认 15'),
    maxThreads: z.number().optional().default(10).describe('总共最多取几个帖子（硬上限，控制耗时），1~30，默认 10'),
    port: z.number().optional().describe('浏览器调试端口，默认 9222')
  },
  async ({ forums, threadsPerForum, floorsPerThread, maxThreads, port }) => {
    const list = (Array.isArray(forums) ? forums : [])
      .map((f) => sanitize(f, 20).replace(/吧$/, ''))
      .filter(Boolean)
      .slice(0, 6);
    if (!list.length) list.push('孙笑川');

    try {
      const corpus = await collectCorpus({
        forums: list,
        threadsPerForum: Math.max(1, Math.min(10, Number(threadsPerForum) || 3)),
        floorsPerThread: Math.max(1, Math.min(60, Number(floorsPerThread) || 15)),
        maxThreads: Math.max(1, Math.min(30, Number(maxThreads) || 10)),
        port: Number(port) || DEFAULT_PORT
      });

      if (corpus.challenge) {
        return fail('⚠️ 采集中途触发人机验证，已停止（不重试、不绕过）。请在浏览器里手动过验证后重试。');
      }
      if (!corpus.ok) {
        const detail = (corpus.errors || []).slice(0, 5).map((e) => `- ${e.stage} ${e.forum || ''} ${e.error || ''}`).join('\n');
        return fail(`没采到可用语料。\n${detail || '（无更多信息）'}`);
      }

      const stats = corpusStats(corpus);
      const text = renderCorpusForLearning(corpus, { maxChars: 12000 });
      const errLines = (corpus.errors || []).slice(0, 6).map((e) => `  · ${e.stage} ${e.forum || ''} ${e.error || ''}`);
      return ok([
        `📚 语料已采集：${list.join('、')}吧`,
        `规模：${stats.threads} 帖 / ${stats.floors} 层 / ${stats.replies} 条楼中楼 / ${stats.chars} 字`,
        errLines.length ? `\n部分失败（已跳过）：\n${errLines.join('\n')}` : '',
        '',
        '──── 以下是语料正文（供你分析说话风格）────',
        text || '(空)',
        '',
        '💡 分析时注意：这批文本只用来提炼「语感/常用说法」，不要整段照抄。',
        '   贴吧里大量地域黑、人身攻击、擦边内容，属于**不该学**的部分，要明确排除。'
      ].filter(Boolean).join('\n'));
    } catch (error) {
      return fail(browserHint(error));
    }
  }
);

await server.connect(new StdioServerTransport());
