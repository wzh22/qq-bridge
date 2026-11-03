// 话题/气氛推断的测试。
// 重点：推断必须是**确定性**的，且产出的是固定词表标签而非原文。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inferTopics,
  inferMood,
  recordMessage,
  createStore,
  TOPIC_VOCAB_EXPORTED
} from '../src/relational-memory.js';

test('inferTopics：能从真实对话里认出话题', () => {
  assert.deepEqual(inferTopics(['明天要考行测，行测好难']), ['备考']);
  assert.ok(inferTopics(['这个脚本报错了，帮我看看配置']).includes('技术'));
  assert.ok(inferTopics(['一起去打游戏吧，我的世界联机']).includes('游戏'));
});

test('inferTopics：无关内容返回空', () => {
  assert.deepEqual(inferTopics(['嗯嗯']), []);
  assert.deepEqual(inferTopics(['']), []);
});

test('inferTopics：多个话题都识别', () => {
  const t = inferTopics(['备考累了，打会儿游戏放松一下']);
  assert.ok(t.includes('备考'));
  assert.ok(t.includes('游戏'));
});

test('inferTopics：结果最多 4 个，不会失控', () => {
  const t = inferTopics([
    '联考备考复习 代码编程脚本 游戏联机 语音音色 记忆日记 跑步体测 吃饭外卖 睡觉熬夜 难受压力 上课宿舍'
  ]);
  assert.ok(t.length <= 4, `实际 ${t.length}`);
});

test('inferMood：开心/紧张/简短 能分开', () => {
  assert.equal(inferMood(['哈哈哈哈太好笑了']), 'warm');
  assert.equal(inferMood(['好烦啊真的无语']), 'tense');
  assert.equal(inferMood(['嗯']), 'brief');
  assert.equal(inferMood(['今天下午上课然后回宿舍了']), 'calm');
});

test('inferMood：空输入返回空串（不瞎猜）', () => {
  assert.equal(inferMood([]), '');
  assert.equal(inferMood(''), '');
});

test('recordMessage：一次调用同时记账 + 打标签', () => {
  const store = createStore('x.json');
  recordMessage(store, 'private:1', {
    texts: ['明天行测考试好紧张'],
    label: '…0001'
  });
  const p = store.data.persons['private:1'];
  assert.equal(p.interactions, 1, '互动次数必须累加');
  assert.equal(p.topics['备考'], 1, '话题必须打上');
  assert.ok(p.moods['tense'] >= 1, '气氛必须打上');
});

test('recordMessage：调用多次累加，不重置', () => {
  const store = createStore('x.json');
  for (let i = 0; i < 5; i += 1) {
    recordMessage(store, 'private:2', { texts: ['打游戏'] });
  }
  const p = store.data.persons['private:2'];
  assert.equal(p.interactions, 5);
  assert.equal(p.topics['游戏'], 5);
});

test('落盘内容不含原文：只存标签', () => {
  const store = createStore('x.json');
  const raw = '我今天去了医院的住院部看朋友';
  recordMessage(store, 'private:3', { texts: [raw] });
  const json = JSON.stringify(store.data);
  // 原文任何一段连续片段都不该出现
  for (const piece of ['医院的住院部', '看朋友', raw]) {
    assert.ok(!json.includes(piece), `不应包含原文片段：${piece}`);
  }
});

test('词表是只读的，防止运行时被改', () => {
  assert.ok(Object.isFrozen(TOPIC_VOCAB_EXPORTED), '词表应 Object.freeze');
});
