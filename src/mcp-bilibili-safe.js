// B 站只读 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 为什么单独做一个 server，而不是直接装 npm 上的 bilibili-mcp-server：
//
//   那个包有 31 个工具，其中这些是**真账号上的写操作**：
//     bilibili_send_danmaku（发弹幕）、bilibili_reply（发评论）、
//     bilibili_delete_comment（删评论）、bilibili_like_comment（点赞）、
//     bilibili_user_follow / unfollow（关注/取关）、bilibili_video_download（下载）、
//     bilibili_login（扫码登录）
//   QQ 机器人会在群聊里自主决定「我想学点什么」，把写操作交给它等于让一个概率模型
//   去操作真实 B 站账号 —— 发错弹幕、误关人、被风控封号都是不可逆的。
//   所以这里只暴露**只读**工具，一个写操作都不给。
//
//   代价是要自己维护（WBI 签名、protobuf 弹幕解析等，见 src/bilibili.js），
//   但换来的是「机器人怎么折腾都不会污染主人的 B 站账号」。
//
//   依赖（@modelcontextprotocol/sdk、zod）本项目已有，不新增任何依赖。
import path from 'node:path';
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  searchVideos, collectVideoMaterial, renderMaterial, extractVideoId, isShortLink
} from './bilibili.js';

/**
 * 项目根目录。
 *
 * ⚠️ 2026-10-25 实测踩坑：原来用 `process.argv[1]`（入口脚本）定位仓库根，
 * 逻辑是「argv[1] 的父目录名是 src 就取上一级」。但 DSH 是以
 * `node <绝对路径>/mcp-bilibili-safe.js` 启动的，这条**本该成立**；
 * 真正翻车的是离线测试/被别处 require 时 argv[1] 指向测试脚本，
 * 于是回退到 process.cwd()——而桥接重启后的 cwd 未必是仓库根，
 * 结果就是「明明写了 sessdata 却报未配置」。
 *
 * 现在优先按**本文件自身位置**推导（`__dirname` 的上一级），
 * 这条在 node 直跑、被 require、被 DSH spawn 三种情况下都成立；
 * `import.meta.url` 不用的原因是离线测试会把本文件塞进 vm 上下文（那里没有 import.meta）。
 * argv[1] 与 cwd 只作为最后兜底。
 */
function projectRoot() {
  // 1) 首选：本文件所在目录 = <repo>/src ⇒ 上一级就是仓库根
  try {
    const here = typeof __dirname === 'string' ? __dirname : '';
    if (here && path.basename(here) === 'src') return path.dirname(here);
  } catch {}
  // 2) 兜底：入口脚本在 src/ 下
  try {
    const entry = String(process.argv[1] ?? '');
    if (entry) {
      const dir = path.dirname(path.resolve(entry));
      if (path.basename(dir) === 'src') return path.dirname(dir);
    }
  } catch {}
  return process.cwd();
}

/**
 * 读取 B 站登录 Cookie（可选）。
 *
 * 优先级：环境变量 BILIBILI_SESSDATA → config.json 的 socialV2.bilibili.sessdata。
 * 没配置时返回空串：此时字幕取不到，其余能力（搜索/详情/分P大纲/评论/弹幕）照常。
 *
 * 只读这里，不做任何登录动作 —— 扫码登录属于写操作，不放进这个 server。
 */
function readBiliCookie(root = projectRoot()) {
  const env = String(process.env.BILIBILI_SESSDATA || '').trim();
  if (env) return { sessdata: env, source: 'env' };
  try {
    const cfgPath = path.join(root, 'config.json');
    if (!fs.existsSync(cfgPath)) return { sessdata: '', source: 'none' };
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const s = String(cfg?.socialV2?.bilibili?.sessdata || '').trim();
    return { sessdata: s, source: s ? 'config' : 'none' };
  } catch {
    return { sessdata: '', source: 'none' };
  }
}

/** 组装 Cookie 头。只要 SESSDATA 就够看字幕了。 */
function cookieHeader(root = projectRoot()) {
  const { sessdata } = readBiliCookie(root);
  return sessdata ? `SESSDATA=${sessdata}` : '';
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// 查询词清洗：去 CQ 码、控制字符、超长截断
function sanitize(input, max = 80) {
  return String(input ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const server = new McpServer({ name: 'bilibili-safe', version: '1.0.0' });

// ── 搜索 ──────────────────────────────────────────────────────────────────
server.tool(
  'bilibili_search',
  '只读搜索 B 站视频，返回标题/UP主/播放量/时长/BV号。用于找学习素材。不执行任何写操作，不需要登录。',
  {
    keyword: z.string().describe('搜索关键词，例如「线性代数的本质」「考研数学 复习」'),
    order: z.enum(['totalrank', 'click', 'pubdate', 'dm', 'stow', 'scores'])
      .optional().default('totalrank')
      .describe('排序：totalrank=综合、click=播放最多、pubdate=最新、dm=弹幕最多、stow=收藏最多、scores=评论最多'),
    page: z.number().optional().default(1).describe('页码')
  },
  async ({ keyword, order, page }) => {
    const kw = sanitize(keyword);
    if (!kw) return fail('关键词为空，已拒绝。');
    try {
      const r = await searchVideos(kw, { order, page, cookie: cookieHeader() });
      if (!r.list.length) return ok(`没有搜到与「${kw}」相关的视频。`);
      const lines = r.list.map((v, i) => {
        return `${i + 1}. ${v.title}\n   ${v.bvid}　UP主：${v.author}\n   ▶${v.play}　💬${v.danmaku}　👍${v.like}　⏱${v.durationText}　${v.typename}`;
      });
      return ok(`🔍 「${kw}」共 ${r.total} 条（第 ${r.page} 页）\n\n${lines.join('\n\n')}\n\n💡 想了解某个视频的具体内容，用 bilibili_video_learn 传 BV 号。`);
    } catch (error) {
      return fail(`搜索失败：${error?.message ?? error}`);
    }
  }
);

// ── 学习一个视频 ──────────────────────────────────────────────────────────
server.tool(
  'bilibili_video_learn',
  [
    '只读抓取一个 B 站视频的「可学习材料」：标题/简介/分P大纲/章节看点/高赞评论/弹幕抽样/高频词。',
    '若配置了 B 站登录 Cookie 还会附带逐字字幕（字幕必须登录才下发）。',
    '返回文本会明确标注哪部分是视频真实内容（字幕）、哪部分只是二手信号（评论/弹幕），请勿把二手信号当成视频内容。',
    '不下载视频、不发弹幕、不评论、不关注。'
  ].join(''),
  {
    video: z.string().describe('BV 号、av 号、视频链接或 b23.tv 短链'),
    maxComments: z.number().optional().default(15).describe('最多取几条高赞评论（默认 15，上限 30）'),
    danmakuSegments: z.number().optional().default(1).describe('取几段弹幕（每段 6 分钟，默认 1，上限 3）')
  },
  async ({ video, maxComments, danmakuSegments }) => {
    const raw = String(video ?? '').trim();
    if (!raw) return fail('视频参数为空。');
    if (!extractVideoId(raw) && !isShortLink(raw)) {
      return fail(`无法从「${raw.slice(0, 60)}」识别出 BV 号。请传 BV 号（如 BV1xx411c7mD）、av 号或完整视频链接。`);
    }
    try {
      const material = await collectVideoMaterial(raw, {
        cookie: cookieHeader(),
        maxComments: Math.min(Number(maxComments) || 15, 30),
        danmakuSegments: Math.min(Number(danmakuSegments) || 1, 3)
      });
      const text = renderMaterial(material, { maxChars: 12000 });
      return ok(text);
    } catch (error) {
      return fail(`获取视频材料失败：${error?.message ?? error}`);
    }
  }
);

// ── 热度榜 / 搜索热词 ─────────────────────────────────────────────────────
server.tool(
  'bilibili_hot',
  '只读获取 B 站当前热门视频列表，返回标题/UP主/播放量/BV号。可用于了解当下流行内容。不需要登录。',
  {
    max: z.number().optional().default(10).describe('返回几条（默认 10，上限 20）')
  },
  async ({ max }) => {
    try {
      const limit = Math.min(Math.max(Number(max) || 10, 1), 20);
      const res = await fetch('https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1', {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          referer: 'https://www.bilibili.com'
        },
        signal: AbortSignal.timeout(15000)
      });
      const json = await res.json();
      if (json.code !== 0) return fail(`B站接口返回 code=${json.code} ${json.message || ''}`);
      const list = (json.data?.list || []).slice(0, limit);
      const lines = list.map((v, i) =>
        `${i + 1}. ${v.title}\n   ${v.bvid}　UP主：${v.owner?.name}　▶${v.stat?.view ?? '?'}`);
      return ok(`🔥 当前热门（${list.length} 条）\n\n${lines.join('\n\n')}`);
    } catch (error) {
      return fail(`获取热门失败：${error?.message ?? error}`);
    }
  }
);

// ── 状态自检 ──────────────────────────────────────────────────────────────
server.tool(
  'bilibili_status',
  '只读检查 B 站能力状态：是否已配置登录 Cookie（决定能否取字幕），以及接口是否连通。',
  {},
  async () => {
    const { sessdata, source } = readBiliCookie();
    let reachable = false;
    let note = '';
    try {
      // ⚠️ 必须带上 Cookie 才能检测登录态。
      // 2026-10-25 踩坑：这里原来没发 Cookie，于是 nav 永远返回 isLogin=false，
      // 状态自检恒显示「未登录态」——明明登录成功了看着像没登录，误导排查。
      const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          referer: 'https://www.bilibili.com',
          ...(sessdata ? { cookie: `SESSDATA=${sessdata}` } : {})
        },
        signal: AbortSignal.timeout(10000)
      });
      const j = await r.json();
      reachable = true;
      if (!sessdata) {
        note = '接口正常（未配置 Cookie）';
      } else if (j?.data?.isLogin) {
        note = `接口正常，已登录（${j.data.uname || '?'}）`;
      } else {
        note = '接口正常，但该 Cookie 已失效（需要重新扫码登录）';
      }
    } catch (error) {
      note = `接口不可达：${error?.message ?? error}`;
    }
    const lines = [
      `接口连通：${reachable ? '是' : '否'}（${note}）`,
      `登录 Cookie：${sessdata ? `已配置（来源：${source}）` : '未配置'}`,
      sessdata
        ? '→ 字幕可尝试获取（是否真有字幕还取决于该视频本身）'
        : '→ 未配置 Cookie 时 B 站不下发字幕。其余能力（搜索/详情/分P大纲/评论/弹幕）正常，但拿不到逐字内容。'
    ];
    return ok(lines.join('\n'));
  }
);

await server.connect(new StdioServerTransport());
