// 风格同步（style-sync）读写一致性回归测试。
//
// 起因（2026-11-03 真实事故）：
//   给「主人教的说话方式」小节加了第二个标记〔常驻〕，标题变成
//   `## 主人教的说话方式 〔全部〕〔常驻〕`。而 readStyleRules 的正则只容忍
//   **一个**标记（`?`），于是它读不到这一节、返回空数组；
//   appendStyleRules 据此认为「没有旧规则」，再交给 upsertStyleSection
//   （它的匹配是宽松前缀匹配，能对上）整节替换 —— **27 条历史规则当场丢失**，
//   文件里只剩本次新提炼的 1 条。
//
// 这类 bug 的可怕之处在于：全程不报错，只有下次翻人格卡才会发现规则没了。
// 所以这里锁死两条：① 多标记必须读得回来；② 渲染时必须保住〔常驻〕。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readStyleRules,
  renderStyleSection,
  upsertStyleSection,
  appendStyleRules,
  STYLE_SECTION_TITLE
} from '../src/style-sync.js';

const HEAD = (tags) => `## ${STYLE_SECTION_TITLE} ${tags}`.trim();

test('单标记标题能读回规则（原有行为）', () => {
  const text = `${HEAD('〔全部〕')}\n\n- 别用鼠鼠\n- 别像AI\n`;
  assert.deepEqual(readStyleRules(text), ['别用鼠鼠', '别像AI']);
});

test('双标记标题必须能读回规则（2026-11-03 事故点）', () => {
  const text = `${HEAD('〔全部〕〔常驻〕')}\n\n- 别用鼠鼠\n- 别像AI\n`;
  assert.deepEqual(
    readStyleRules(text),
    ['别用鼠鼠', '别像AI'],
    '双标记读不回来 —— 会导致下一次写入把历史规则整节覆盖掉'
  );
});

test('三标记 / 方括号 / 全角括号都要容忍', () => {
  const variants = ['〔全部〕〔常驻〕', '[v2][persistent]', '（全部）（常驻）'];
  for (const tags of variants) {
    const text = `${HEAD(tags)}\n\n- 规则甲\n`;
    assert.deepEqual(readStyleRules(text), ['规则甲'], `标记形态 ${tags} 读不回来`);
  }
});

test('渲染出的小节必须带〔常驻〕，否则下次重写会丢标记', () => {
  const rendered = renderStyleSection(['规则甲']);
  assert.match(rendered, /〔常驻〕/, '渲染时没写〔常驻〕，该小节会在下次 style-sync 后失去常驻身份');
});

test('渲染 → 读回 必须幂等（写进去什么，读出来什么）', () => {
  const rules = ['别用鼠鼠这个梗', '别像AI那样说话', '说话可以冲一点'];
  const rendered = renderStyleSection(rules);
  assert.deepEqual(readStyleRules(rendered), rules, '渲染后读不回原规则');
});

test('upsert 后再读，规则一条不少（整节替换语义不能吞规则）', () => {
  const before = `${HEAD('〔全部〕〔常驻〕')}\n\n- 别用鼠鼠这个梗\n- 别像AI那样说话\n\n## 十一、隐私边界\n\n- 边界甲\n`;
  const after = upsertStyleSection(before, ['别用鼠鼠这个梗', '别像AI那样说话', '别把话说一半']).text;
  const rules = readStyleRules(after);
  assert.ok(rules.includes('别用鼠鼠这个梗'), '老规则一丢了');
  assert.ok(rules.includes('别像AI那样说话'), '老规则二丢了');
  assert.ok(rules.includes('别把话说一半'), '新规则没写进去');
  // 受保护尾部小节不能被吞
  assert.match(after, /隐私边界/, '受保护的尾部小节被吞掉了');
});

test('appendStyleRules 在双标记小节上不得丢历史规则（事故复现）', () => {
  // 注意：规则文本必须真的像「说话方式的要求」，否则会被 privacyViolation
  // 的白名单闸门判成「不像说话方式的要求」而丢弃 —— 那是刻意的防误写机制，
  // 不是 bug。这里用与真实规则同形态的句子，避免误触发。
  const before = `${HEAD('〔全部〕〔常驻〕')}\n\n- 别用鼠鼠这个梗\n- 别像AI那样说话\n- 别复述别人的话\n\n## 十一、隐私边界\n\n- 边界\n`;
  const { text, added } = appendStyleRules(before, ['别一下子说完所有话，分成几条发']);
  assert.equal(added.length, 1, '新规则没被接受');
  const after = readStyleRules(text);
  for (const r of ['别用鼠鼠这个梗', '别像AI那样说话', '别复述别人的话', added[0]]) {
    assert.ok(after.includes(r), `规则「${r}」在 append 后丢失`);
  }
});

test('ppendStyleRules 不会因为读不到小节而重建（事故根因）', () => {
  // 事故的本质：读不到 → 以为空 → 整节重建，只留下新的一批。
  // 这里直接验证「读得到」，是上面的充分条件，单独锁一条更醒目。
  const text = `${HEAD('〔全部〕〔常驻〕')}\n\n- 别用鼠鼠这个梗\n- 别像AI那样说话\n`;
  const { text: after, added } = appendStyleRules(text, ['别把话说一半']);
  assert.equal(added.length, 1);
  const rules = readStyleRules(after);
  assert.ok(rules.length >= 3, `规则数 ${rules.length}，历史规则疑似被吞`);
  assert.ok(rules.includes('别用鼠鼠这个梗'));
});

test('规则去重：重复追加同一批不应膨胀', () => {
  const base = `${HEAD('〔全部〕〔常驻〕')}\n\n- 规则甲\n`;
  const once = appendStyleRules(base, ['规则甲']).text;
  const twice = appendStyleRules(once, ['规则甲']).text;
  assert.equal(readStyleRules(twice).length, 1, '同一规则被重复写入');
});