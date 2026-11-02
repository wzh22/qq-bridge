// 表情包体系自检：
// 1) sticker-lib 纯函数（合并/查找/格式化/笔记/使用统计）
// 2) 配置项与 MCP 工具描述存在性
// 3) 可选 live 模式：QQ_BRIDGE_TEST_LIVE=1 时调用 SnowLuma 拉取收藏表情并验证 safeFetchBuffer 可抓图
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeStickerEntry,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from '../src/sticker-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

console.log('## sticker-lib 纯函数');
{
  const raw = normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'abc', desc: '笑死', localNote: '嘲讽', tags: ['怼人'] });
  ok(raw && raw.id === 'a' && raw.desc === '笑死' && raw.localNote === '嘲讽', 'normalizeStickerEntry 基本字段');
  ok(normalizeStickerEntry({}) === null, '空记录返回 null');
}

{
  const base = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '' }
  ]);
  ok(base.length === 2, 'merge 新增两条');
  const merged = mergeStickerLibrary(base, [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a2', md5: 'ABC', desc: '笑哭' }
  ]);
  ok(merged.length === 1, 'merge 会移除 QQ 端已删除的表情');
  ok(merged[0].id === 'a' && merged[0].url === 'https://x/a2' && merged[0].desc === '笑哭', 'merge 更新 QQ 字段');
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }
  ]);
  ok(findSticker(list, 'a')?.id === 'a', '按 emoji_id 查找');
  ok(findSticker(list, 'abc')?.id === 'a', '按 md5 大小写不敏感查找');
  ok(findSticker(list, 'https://x/b')?.id === 'b', '按 URL 查找');
  ok(findSticker(list, '不存在') === null, '找不到返回 null');
}

{
  const list = [
    normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }),
    normalizeStickerEntry({ emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }),
    normalizeStickerEntry({ emoji_id: 'c', resId: 'c', url: 'https://x/c', md5: 'GHI', desc: '', localNote: '无语' })
  ];
  const all = formatStickerList(list, '', 10);
  ok(all.total === 3 && all.stickers.length === 3, 'formatStickerList 总数');
  const q = formatStickerList(list, '生气', 10);
  ok(q.matched === 1 && q.stickers[0].id === 'b', 'formatStickerList 按备注搜索');
  const q2 = formatStickerList(list, '无语', 10);
  ok(q2.matched === 1 && q2.stickers[0].id === 'c', 'formatStickerList 按本地笔记搜索');
  const ctx = buildStickerContext(list, 8);
  ok(ctx.includes('笑死') && ctx.includes('生气'), 'buildStickerContext 包含备注');
  ok(buildStickerStrategyHint().includes('qq_send_sticker'), '策略提示包含发送工具');
}

// ── 表情摘要的三道体积闸 ───────────────────────────────────────────────
// 背景：主人担心「表情一多，这张表会把每个会话的提示词撑大」。
// 三道闸各管一件事，缺一道都会漏：条目上限挡不住长备注、字符预算挡不住
// 「没备注的表情全列出来」、命名阈值挡不住收藏数慢慢涨。
console.log('## 表情摘要体积闸');
{
  const mk = (i, extra = {}) => normalizeStickerEntry({
    emoji_id: `id${i}`, resId: `id${i}`, url: `https://x/${i}`, md5: `M${i}`,
    ...extra
  });

  // ① 条目上限：只取 max 条，其余不再出现。
  {
    const many = Array.from({ length: 12 }, (_, i) => mk(i, { alias: `别名${i}` }));
    const ctx = buildStickerContext(many, 5);
    ok(!ctx.includes('6. 别名5'), '条目上限：第 6 条起不列');
    ok(ctx.includes('别名0') && ctx.includes('别名4'), '条目上限：前 5 条都在');
    ok(ctx.includes('另有 7 个没列出'), '条目上限：注明省略数量');
  }

  // ② 字符预算：备注很长时按字符截断，不会无限膨胀。
  {
    const longNote = '很长的备注'.repeat(30); // 180 字
    const many = Array.from({ length: 20 }, (_, i) => mk(i, { alias: `A${i}`, localNote: longNote }));
    const ctx = buildStickerContext(many, 20, { maxChars: 400 });
    // 正文（去掉表头/表尾）必须落在预算内
    const body = ctx.split('\n').filter((l) => /^\d+\. /.test(l));
    const bodyLen = body.join('\n').length;
    ok(bodyLen <= 400 + 60, `字符预算：正文 ${bodyLen} 字被压在 400 附近`);
    ok(body.length >= 1 && body.length < 20, `字符预算：实际列了 ${body.length} 条（少于 20）`);
    // 单条备注必须被截短，不能一条占满整张表
    const firstLine = body[0] || '';
    ok(firstLine.length < 120, `单条备注已截短（${firstLine.length} 字）`);
    ok(firstLine.endsWith('…'), '长备注以省略号收尾，提示被截断');
  }

  // ③ 命名阈值：收藏超过阈值后，没备注的不再列进表里。
  {
    // 阈值 40：25 个没备注 + 5 个有备注 = 30 条，总数没超阈值 → 全列
    const under = [...Array.from({ length: 25 }, (_, i) => mk(i)), ...Array.from({ length: 5 }, (_, i) => mk(100 + i, { alias: `有备注${i}` }))];
    const ctxUnder = buildStickerContext(under, 60, { namedOnlyThreshold: 40 });
    ok(ctxUnder.includes('#1') || ctxUnder.includes('#2'), '命名阈值：总数未超时，没备注的也列出');

    // 总数 45 超过阈值 → 只列有备注的 5 条
    const over = [...Array.from({ length: 40 }, (_, i) => mk(i)), ...Array.from({ length: 5 }, (_, i) => mk(200 + i, { alias: `有备注${i}` }))];
    const ctxOver = buildStickerContext(over, 60, { namedOnlyThreshold: 40 });
    ok(ctxOver.includes('有备注0') && ctxOver.includes('有备注4'), '命名阈值：超阈值时保留有备注的');
    ok(!/(^|\n)\d+\. #\d+/m.test(ctxOver), '命名阈值：超阈值时不再列「#序号」这种无名条目');
    ok(ctxOver.includes('还没起备注'), '命名阈值：提示有多少个没起备注');

    // 全库都没备注时必须退回全列，否则表会空掉
    const allUnnamed = Array.from({ length: 45 }, (_, i) => mk(i));
    const ctxBare = buildStickerContext(allUnnamed, 60, { namedOnlyThreshold: 40 });
    ok(/(^|\n)\d+\. #\d+/m.test(ctxBare), '命名阈值：全都没备注时退回全列（不留空表）');
  }

  // 参数容错：坏值不能把表变成空串或直接抛错。
  {
    const one = [mk(0, { alias: '唯一' })];
    ok(buildStickerContext(one, 0).includes('唯一'), 'max=0 时退回默认值而不是空表');
    ok(buildStickerContext(one, 'abc').includes('唯一'), 'max 非数字时退回默认值');
    ok(buildStickerContext(one, 8, { maxChars: 'x' }).includes('唯一'), 'maxChars 非数字时退回默认值');
    ok(buildStickerContext([], 8) === '', '空库返回空串');
  }
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }
  ]);
  const noted = applyStickerNote(list, 'a', { note: '嘲讽用', tags: ['怼人'], usage: '别人犯蠢时' });
  ok(noted.entry.localNote === '嘲讽用' && noted.entry.tags.includes('怼人'), 'applyStickerNote 写入本地认知');
  const used = markStickerUsed(noted.entries, 'a', '接梗');
  ok(used.entry.useCount === 1 && used.entry.lastContext === '接梗', 'markStickerUsed 记录使用');
}

console.log('## 配置文件');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const tools = cfg.socialV2?.tools ?? {};
  ok(tools.listStickers === true, 'config listStickers=true');
  ok(tools.getStickerImage === true, 'config getStickerImage=true');
  ok(tools.sendSticker === true, 'config sendSticker=true');
  ok(tools.stickerNote === true, 'config stickerNote=true');
  ok(cfg.socialV2?.sticker?.enabled === true, 'config sticker.enabled=true');
  ok(!('sendCaptionMaxChars' in (cfg.socialV2?.sticker ?? {})), 'config sticker 不再包含 sendCaptionMaxChars');

  // setStickerRemark 这里**不能**断言 config.json 的值。
  // 它是「默认关闭的高风险开关」，但**开不开由主人/控制台决定**，属于运行期配置，
  // 会随运维操作变化（本机就已被打开）。早期这条写成
  //   ok(tools.setStickerRemark === false, 'config setStickerRemark=false（默认禁用）')
  // 于是在主人自己打开它就变红，而红的原因跟「表情功能是否正常」毫无关系 ——
  // 把运维决定当代码契约，测试就会替主人做决定。
  //
  // 该守的是**代码里的默认值**：新装一份（config 里没写这一项）时必须是关的，
  // 否则「一次控制台保存就把风险操作静默打开」那个老坑会回来。
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const defaultHits = [...bridgeSrc.matchAll(/setStickerRemark:\s*(true|false)/g)].map((m) => m[1]);
  ok(defaultHits.length >= 2, `代码里应有两处默认值定义（实际 ${defaultHits.length}）`);
  ok(defaultHits.every((v) => v === 'false'), `setStickerRemark 代码默认必须是 false，实际 ${defaultHits.join('/')}`);
  // 归一化兜底那段的关键不变量：文件里没写该键时，不得被写成 true。
  ok(/current\.tools\?\.\[k\]\s*!==\s*false/.test(bridgeSrc),
    '工具开关归一化应以「当前生效配置」兜底，而不是默认 true');
}

console.log('## 表情单气泡约束');
{
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const sendStickerBlock = mcp.slice(mcp.indexOf("'qq_send_sticker'"), mcp.indexOf("'qq_sticker_note'"));
  ok(!sendStickerBlock.includes('message: z.string()'), 'qq_send_sticker MCP 不再接受 message 参数');
  ok(sendStickerBlock.includes('不能在同一气泡里附带文字'), 'qq_send_sticker 描述强调单气泡');
  const hint = buildStickerStrategyHint();
  ok(hint.includes('不能在同一气泡里附带文字'), '策略提示禁止同气泡混文字');
  ok(!hint.includes('先发一句话再发一张'), '策略提示不再引导“先发一句话再发一张”');
}

console.log('## MCP 工具描述存在性');
{
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  for (const name of ['qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker', 'qq_sticker_note', 'qq_set_sticker_remark']) {
    ok(mcp.includes(`'${name}'`) || mcp.includes(`"${name}"`), `MCP 工具 ${name} 已注册`);
  }
}

console.log('## bridge 路由/函数存在性');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  for (const s of ['/api/socialV2/sticker-list', '/api/socialV2/sticker-image', '/api/socialV2/sticker-note', '/api/socialV2/send-sticker', '/api/socialV2/sticker-remark', '/api/stickers', 'syncStickerLibrary', 'sendStickerV2']) {
    ok(bridge.includes(s), `bridge 包含 ${s}`);
  }
}

if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
  console.log('## live：SnowLuma 收藏表情链路');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) };
    const res = await fetch(`${base}/fetch_custom_face_detail`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ count: 5 }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json();
    ok(res.ok && body.status === 'ok' && body.retcode === 0, 'fetch_custom_face_detail 调用成功');
    const items = Array.isArray(body.data) ? body.data : [];
    ok(items.length > 0, `返回 ${items.length} 个收藏表情`);
    if (items.length > 0) {
      const { safeFetchBuffer } = await import('../src/safe-fetch.js');
      try {
        const img = await safeFetchBuffer(items[0].url, 4 * 1024 * 1024);
        ok(img.buffer.length > 0, `可抓取表情图片字节（${img.buffer.length} bytes）`);
      } catch (e) {
        ok(false, `safeFetchBuffer 抓取表情失败: ${e.message}`);
      }
    }
  } catch (e) {
    ok(false, `live 链路异常: ${e.message}`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
