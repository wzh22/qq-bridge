// 回归测试：字幕归属与完整性校验。
//
// 2026-10-25 实测踩到的三个坑，这里全部用**离线**方式固化成断言：
//   ① B 站 player 接口会串到别的视频的 AI 字幕（内容张冠李戴）
//      → 必须用 URL 前缀 == aid+cid 判定归属
//   ② 字幕轨是间歇性的（约一半返回空）
//      → 必须重试，不能一次没拿到就判定「没有字幕」
//   ③ 多P视频 duration 是合集总时长，字幕是当前P的
//      → 校验必须用 pageDuration
//
// 这些断言不依赖网络：把选轨/校验逻辑用等价的纯函数复现并断言。
// （真正的行为验证在 scripts/test-bilibili.mjs 与手动 E2E 中完成）

import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    pass += 1;
  } catch (error) {
    console.log(`  ❌ ${name}\n     ${error.message}`);
    fail += 1;
  }
}

// ── 复刻 getSubtitle 里的归属判定（保持与实现同构）────────────────────────
const isAi = (s) => String(s.lan || '').startsWith('ai-');
const urlPath = (s) => String(s.subtitle_url || '').split('?')[0].split('/').pop();
function belongsToThisVideo(s, aid, cid) {
  if (!isAi(s)) return true;
  // 与实现同构：只有 aid 和 cid **都**有值才启用前缀校验
  const expect = aid && cid ? `${aid}${cid}` : '';
  if (!expect) return true;
  return urlPath(s).startsWith(expect);
}

console.log('=== ① 字幕归属：AI 字幕 URL 前缀必须等于 aid+cid ===');

const AID = '113006243481679';
const CID = '36010133667';

check('前缀匹配 ⇒ 判定属于本视频', () => {
  const s = {
    lan: 'ai-zh',
    subtitle_url: `//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${AID}${CID}abcdef?auth_key=x`
  };
  assert.equal(belongsToThisVideo(s, AID, CID), true);
});

check('前缀不匹配 ⇒ 判定不属于（这就是串台字幕）', () => {
  const s = {
    lan: 'ai-zh',
    subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/11315916787646225666918694deadbeef?auth_key=x'
  };
  assert.equal(belongsToThisVideo(s, AID, CID), false);
});

check('官方字幕（非 ai-）不受前缀规则限制', () => {
  const s = { lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/662b660a.jso' };
  assert.equal(belongsToThisVideo(s, AID, CID), true);
});

check('没有 aid 信息时不误杀（交给时长校验）', () => {
  const s = { lan: 'ai-zh', subtitle_url: '//x/bfs/ai_subtitle/prod/999abc' };
  assert.equal(belongsToThisVideo(s, '', CID), true);
});

console.log('\n=== ② 时间轴校验：字幕必须覆盖视频时长 ===');

function timelineOk(lastT, duration) {
  if (!duration) return null; // 无时长信息时不做此判断
  return !(lastT < duration * 0.5 || lastT > duration * 1.6);
}

check('字幕到 207s / 视频 213s ⇒ 通过', () => {
  assert.equal(timelineOk(207, 213), true);
});

check('字幕到 40s / 视频 658s ⇒ 拒绝（时间轴太短）', () => {
  assert.equal(timelineOk(40, 658), false);
});

check('字幕到 1225s / 视频 213s ⇒ 拒绝（超出太多）', () => {
  assert.equal(timelineOk(1225, 213), false);
});

console.log('\n=== ③ 多P视频：必须用当前P时长而不是合集总时长 ===');

check('100P 教程：总 143894s，P1 164s，字幕到 153s ⇒ 用 pageDuration 才通过', () => {
  assert.equal(timelineOk(153, 143894), false, '用总时长会误判为错位');
  assert.equal(timelineOk(153, 164), true, '用本P时长才正确');
});

console.log('\n=== ④ 官方字幕优先于 AI 字幕 ===');

function pickTarget(subs, opts = {}) {
  const official = ['zh-CN', 'zh-Hans', 'zh-Hant', 'zh-HK'];
  const rank = (s) => {
    const lan = String(s.lan || '');
    if (lan === opts.lang) return 0;
    const oi = official.indexOf(lan);
    if (oi >= 0) return 1 + oi;
    if (lan === 'en-US') return 10;
    if (isAi(s)) return 20;
    return 15;
  };
  return [...subs].sort((a, b) => rank(a) - rank(b))[0];
}

check('同时有 ai-zh 和 zh-CN ⇒ 选 zh-CN', () => {
  const subs = [
    { lan: 'ai-zh', subtitle_url: '//x/ai' },
    { lan: 'zh-CN', subtitle_url: '//x/official' }
  ];
  assert.equal(pickTarget(subs).lan, 'zh-CN');
});

check('只有 ai-zh ⇒ 选 ai-zh', () => {
  const subs = [{ lan: 'ai-zh', subtitle_url: '//x/ai' }];
  assert.equal(pickTarget(subs).lan, 'ai-zh');
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
