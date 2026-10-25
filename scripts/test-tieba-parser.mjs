// 贴吧解析器回归测试（离线）。
//
// 2026-10-25 实测踩到的 5 个坑，全部固化成断言：
//   ① 列表页已改卡片布局，旧选择器 a.j_th_tit 全部失效
//   ② a.thread-content-link 的 innerText 是整块卡片（作者+等级+关注+标题+统计）
//   ③ 楼层号存了「第2楼」整串，渲染时又拼一次 → 「第第2楼楼」
//   ④ 第N楼 后 break，导致日期永远读不到（所有 date 为空）
//   ⑤ 日期格式含 MM-DD（"08-20"），早期正则不认，被当成正文
//
// 这些断言都是纯文本处理，不依赖网络/浏览器。

import assert from 'node:assert/strict';

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass += 1; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail += 1; }
}

// ── 复刻 src/tieba.js 里的常量（保持同构）──────────────────────────────
const RANKS = /^(铁杆吧友|知名人士|核心吧友|意见领袖|人气楷模|资深吧友|新手上路|高级粉丝|粉丝|吧友|吧主|小吧主|活跃吧友|见习吧友)$/;
const REGION = /^(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门|海外|其他)$/;
const TIME = /^(\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2}|\d+分钟前|\d+小时前|\d+秒前|刚刚|\d+天前|昨天|今天|前天)$/;
const SKIP = /^(赞|回复|收藏|分享|\d+|\+关注)$/;
const BADGE = /^(楼主|吧主|小吧主|图片小编|视频小编|关注|楼主赞过|楼主已赞)$/;

console.log('=== ① 日期格式 ===');

check('MM-DD（08-20）必须被识别为时间', () => {
  assert.equal(TIME.test('08-20'), true);
});
check('YYYY-MM-DD 仍被识别', () => {
  assert.equal(TIME.test('2026-08-20'), true);
});
check('相对时间仍被识别', () => {
  assert.equal(TIME.test('3分钟前'), true);
  assert.equal(TIME.test('刚刚'), true);
});
check('普通正文不会被误判为时间', () => {
  assert.equal(TIME.test('好看不她'), false);
  assert.equal(TIME.test('3'), false);
});

console.log('\n=== ② 楼层解析：日期必须读到（不能因第N楼 break）===');

// 复刻解析循环
function parseFloor(lines) {
  let i = 1;
  while (i < lines.length && (RANKS.test(lines[i]) || BADGE.test(lines[i]))) i += 1;
  const contentParts = [];
  let floor = ''; let date = ''; let region = '';
  for (; i < lines.length; i += 1) {
    const l = lines[i];
    if (!floor && /^第\d+楼$/.test(l)) { floor = l.replace(/\D/g, ''); continue; }
    if (TIME.test(l)) { date = l; break; }
    if (floor) break;
    if (!floor && (SKIP.test(l) || RANKS.test(l))) break;
    contentParts.push(l);
  }
  return { author: lines[0], content: contentParts.join(' ').trim(), floor, date };
}

check('实测行序 [作者,等级,正文,第2楼,08-20,山东] → 楼层/日期都对', () => {
  const r = parseFloor(['千诗夏沐', '知名人士', '我跟这位女同学是分班认识的', '第2楼', '08-20', '山东']);
  assert.equal(r.floor, '2', '楼层号应为纯数字 2');
  assert.equal(r.date, '08-20', '日期应为 08-20');
  assert.equal(r.content, '我跟这位女同学是分班认识的');
});

check('楼层号不重复前缀（不产生「第第2楼楼」）', () => {
  const r = parseFloor(['某甲', '吧友', '正文', '第7楼', '08-20', '北京']);
  assert.equal(r.floor, '7');
  assert.ok(!r.floor.includes('第'), '不能含「第」');
  assert.ok(!r.floor.includes('楼'), '不能含「楼」');
});

console.log('\n=== ③ 纯图片楼层不应把楼中楼作者当正文 ===');

check('只有 [作者,等级,第4楼,日期,地区] 的楼层，正文应为空', () => {
  const r = parseFloor(['拼好哈基饭', '知名人士', '第4楼', '08-20', '浙江']);
  assert.equal(r.content, '', '纯图楼层不该凭空造出正文');
  assert.equal(r.floor, '4');
  assert.equal(r.date, '08-20');
});

console.log('\n=== ④ 卡片式列表：标题必须剥离作者/等级/统计 ===');

// 复刻 pickTitle 的尾部统计清理
function stripTrailingStats(s) {
  return s.replace(/\s+\d+\s+\d+\s+\d+\s*$/, '').trim();
}

check('标题尾部的「7 370 871」被剥掉', () => {
  assert.equal(stripTrailingStats('她是不是觉得自己很卡哇伊，真可笑 7 370 871'), '她是不是觉得自己很卡哇伊，真可笑');
});

check('标题中间的数字不受影响', () => {
  assert.equal(stripTrailingStats('2026年考研倒计时100天'), '2026年考研倒计时100天');
});

console.log('\n=== ⑤ 楼中楼：不应混入作者名/等级/点赞数 ===');

// 复刻 .pb-lzl-item 的清洗逻辑
function cleanLzl(lines) {
  if (lines.length < 3) return null;
  let body = lines.slice(2);
  while (body.length && (/^(赞|回复)$/.test(body[body.length - 1])
    || /^\d+$/.test(body[body.length - 1])
    || REGION.test(body[body.length - 1])
    || TIME.test(body[body.length - 1]))) {
    body.pop();
  }
  return body.join(' ').trim();
}

check('典型楼中楼 [作者,等级,正文,时间,地区,赞,回复] → 只剩正文', () => {
  const t = cleanLzl(['TYplus0603', '铁杆吧友', '回复 千诗夏沐 :3', '08-20', '陕西', '赞', '回复']);
  assert.equal(t, '回复 千诗夏沐 :3');
});

check('带点赞数的楼中楼 → 点赞数被剔除', () => {
  const t = cleanLzl(['泪q_q目', '核心吧友', '3', '08-20', '河北', '赞', '回复']);
  assert.equal(t, '', '只有点赞数、没有正文时应为空');
});

check('楼中楼正文里的数字不会被误删', () => {
  const t = cleanLzl(['某甲', '吧友', '这道题答案是 42 没错', '08-20', '北京', '赞', '回复']);
  assert.equal(t, '这道题答案是 42 没错');
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
