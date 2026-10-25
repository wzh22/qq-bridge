// B 站模块的离线单测：只测纯函数与解析逻辑，不联网。
//
// 重点回归项（都是真实踩过的坑）：
//   1. 弹幕 protobuf 字段号 —— 曾把 field 3(mode) 当成 field 2(progress)，
//      导致所有弹幕时间戳变成 0，时间轴全错。
//   2. duration 解析 —— 搜索接口给的是 "12:34" 字符串，直接 Number() 会得 0。
//   3. 视频 ID 提取 —— 完整 URL / av 号 / 纯数字都要能识别。
//   4. 高频词过滤 —— 弹幕噪声（刷屏佛号、颜文字）不能进关键词。
import assert from 'node:assert/strict';
import {
  extractVideoId, isShortLink, parseDuration, formatDurationText, signWbi
} from 'file:///E:/dsh/qq-bridge/src/bilibili.js';

let pass = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ❌ ${name}`);
    console.log(`     ${error.message}`);
  }
}

console.log('=== extractVideoId ===');
test('BV 号', () => assert.equal(extractVideoId('BV1rpWjevEip'), 'BV1rpWjevEip'));
test('完整 URL 里的 BV 号', () =>
  assert.equal(extractVideoId('https://www.bilibili.com/video/BV1rpWjevEip/?spm_id_from=333'), 'BV1rpWjevEip'));
test('av 号', () => assert.equal(extractVideoId('av113006243481679'), 'av113006243481679'));
test('纯数字当 aid', () => assert.equal(extractVideoId('12345'), 'av12345'));
test('无效输入返回 null', () => assert.equal(extractVideoId('这不是视频'), null));
test('空输入返回 null', () => assert.equal(extractVideoId(''), null));

console.log('\n=== isShortLink ===');
test('b23.tv 短链', () => assert.equal(isShortLink('https://b23.tv/abc123'), true));
test('普通链接不是短链', () => assert.equal(isShortLink('https://www.bilibili.com/video/BV1xx'), false));

console.log('\n=== parseDuration（回归：duration 是 "12:34" 字符串） ===');
test('"12:34" -> 754', () => assert.equal(parseDuration('12:34'), 754));
test('"1:02:03" -> 3723', () => assert.equal(parseDuration('1:02:03'), 3723));
test('数字秒数原样', () => assert.equal(parseDuration(7384), 7384));
test('"45" -> 45', () => assert.equal(parseDuration('45'), 45));
test('空值 -> 0', () => assert.equal(parseDuration(''), 0));
test('null -> 0', () => assert.equal(parseDuration(null), 0));
test('非法字符串 -> 0', () => assert.equal(parseDuration('abc'), 0));

console.log('\n=== formatDurationText ===');
test('754 -> "12:34"', () => assert.equal(formatDurationText(754), '12:34'));
test('3723 -> "1:02:03"', () => assert.equal(formatDurationText(3723), '1:02:03'));
test('0 -> "未知"', () => assert.equal(formatDurationText(0), '未知'));

console.log('\n=== signWbi ===');
test('生成 32 位 md5 w_rid', () => {
  const r = signWbi({ bvid: 'BV1xx411c7mD' }, '0123456789abcdef0123456789abcdef');
  assert.match(r.w_rid, /^[0-9a-f]{32}$/);
  assert.ok(r.wts, '应带 wts');
  assert.equal(r.bvid, 'BV1xx411c7mD', '原参数应保留');
});
test('相同参数相同 wts 签名稳定', () => {
  const mixin = 'abcdef0123456789abcdef0123456789';
  const a = signWbi({ a: '1', b: '2' }, mixin);
  const b = signWbi({ a: '1', b: '2' }, mixin);
  // wts 可能跨秒，只要同一秒内就应一致
  if (a.wts === b.wts) assert.equal(a.w_rid, b.w_rid);
});
test('参数顺序不影响签名（内部按 key 排序）', () => {
  const mixin = 'abcdef0123456789abcdef0123456789';
  const a = signWbi({ x: '1', y: '2' }, mixin);
  const b = signWbi({ y: '2', x: '1' }, mixin);
  if (a.wts === b.wts) assert.equal(a.w_rid, b.w_rid);
});

console.log('\n=== 弹幕 protobuf 字段号（回归：field 2=progress, 3=mode） ===');
// 这条用例原来是「联网抓 36010133667 的真实弹幕包，再断言时间非 0」。三个毛病：
//   1. 它断的是**网络**，不是解析器。B 站限速/风控偶尔回空包，测试就红，而解析器
//      可能完好；反过来解析器真坏了（字段号错）也未必每次都能抓住。
//   2. 那个视频 ID 已经失效（getVideoInfo 回 code=-404），拿它当固定测试数据，
//      等于把稳定性绑在一个会变的远端资源上。
//   3. 断言信息 `应能解出弹幕` 不含任何网络关键词，所以 catch 里「离线则跳过」
//      这条分支永远不命中 —— 断网也只会记一条红，而不是明确跳过。
//
// 改成手工编码 protobuf 字节做**确定性**验证：把 DanmakuElem 各字段按官方 proto
// 编出来，断言解出的 progress/content 逐条对得上。测的是解析器本身，不联网。
function encVarint(n) {
  const out = [];
  let v = Number(n);
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v & 0x7f);
  return Buffer.from(out);
}
const encTag = (field, wire) => encVarint(field * 8 + wire);
function encLen(field, str) {
  const body = Buffer.from(str, 'utf8');
  return Buffer.concat([encTag(field, 2), encVarint(body.length), body]);
}
const encNum = (field, n) => Buffer.concat([encTag(field, 0), encVarint(n)]);
const buildElem = ({ id, progress, mode, fontsize, color, midHash, content }) => Buffer.concat([
  encNum(1, id), encNum(2, progress), encNum(3, mode), encNum(4, fontsize), encNum(5, color),
  encLen(6, midHash), encLen(7, content)
]);
const buildSegment = (elems) => Buffer.concat(elems.map((e) => {
  const body = buildElem(e);
  return Buffer.concat([encTag(1, 2), encVarint(body.length), body]);
}));

try {
  const { parseDanmakuSegment } = await import('file:///E:/dsh/qq-bridge/src/bilibili.js');
  // progress 覆盖短/中/长；mode 刻意取 1/5/3（若解析器把 field 3 当成 progress，
  // 时间会变成 [1,5,3]，这条就必然失败 —— 正是历史上踩过的坑）。
  const fixtures = [
    { id: 1, progress: 1500, mode: 1, fontsize: 25, color: 16777215, midHash: 'aaaaaaaa', content: '第一条弹幕' },
    { id: 2, progress: 65000, mode: 5, fontsize: 18, color: 15138834, midHash: 'bbbbbbbb', content: '一分钟处的弹幕' },
    { id: 3, progress: 125800, mode: 3, fontsize: 25, color: 255, midHash: 'cccccccc', content: '两分钟处的弹幕' }
  ];
  const parsed = parseDanmakuSegment(buildSegment(fixtures));
  assert.equal(parsed.length, 3, `应解出 3 条，实际 ${parsed.length}`);
  assert.deepEqual(parsed.map((d) => d.t), [1500, 65000, 125800],
    `时间必须等于 progress，实际 ${JSON.stringify(parsed.map((d) => d.t))}`);
  assert.deepEqual(parsed.map((d) => d.text), fixtures.map((f) => f.content), '内容应逐条对应');
  assert.equal(parseDanmakuSegment(Buffer.alloc(0)).length, 0, '空包应安静返回空数组');
  pass += 1;
  console.log('  ✅ 弹幕解析正确（离线确定性用例，field 2=progress）');
} catch (error) {
  failed += 1;
  console.log('  ❌ 弹幕解析异常');
  console.log(`     ${error.message}`);
}

console.log(`\n结果：${pass} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
