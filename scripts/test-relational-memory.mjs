// 跨会话关系记忆的单测。
// 重点不是「能不能存」，而是**隐私闸门能不能真的拦住原话**。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createStore,
  loadStore,
  saveStore,
  noteInteraction,
  renderRelationalBlock,
  familiarityScore,
  decayFactor,
  leaksOriginalText,
  sanitizeSignal,
  MAX_SIGNALS_PER_PERSON
} from '../src/relational-memory.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relmem-'));
  return path.join(dir, 'relational-memory.json');
}

test('leaksOriginalText：复述原话能被抓到', () => {
  const raw = ['主人今晚一直让我发语音说晚安，听完说这语音好难听'];
  // 几乎照抄
  assert.equal(leaksOriginalText('听完说这语音好难听', raw), true);
  // 完全无关
  assert.equal(leaksOriginalText('聊过几次技术问题', raw), false);
});

test('sanitizeSignal：直接引语一律丢弃', () => {
  assert.equal(sanitizeSignal('他说：膝盖很疼'), null);
  assert.equal(sanitizeSignal('跟我说「要卸载插件」'), null);
});

test('sanitizeSignal：长数字（QQ号/手机号/日期）丢弃', () => {
  assert.equal(sanitizeSignal('QQ 2409281798'), null);
  assert.equal(sanitizeSignal('2026-11-02 那次'), null);
});

test('sanitizeSignal：健康/财务/家庭类敏感事实丢弃', () => {
  assert.equal(sanitizeSignal('他最近在医院住院'), null);
  assert.equal(sanitizeSignal('他工资涨了'), null);
  assert.equal(sanitizeSignal('他跟女朋友分手了'), null);
});

test('sanitizeSignal：合规的关系信号能留下', () => {
  // 「常聊技术」「聊得挺开心」这类才是允许的
  assert.equal(sanitizeSignal('常聊技术和备考'), '常聊技术和备考');
  assert.equal(sanitizeSignal('聊得挺开心'), '聊得挺开心');
});

test('sanitizeSignal：原话重合度高的丢弃', () => {
  const raw = ['我今天去吃了炒面和烤淀粉肠，特别香'];
  // 6 字窗口大量重合
  assert.equal(sanitizeSignal('去吃了炒面和烤淀粉肠', raw), null);
});

test('familiarityScore：次数越多、越近，越熟', () => {
  const now = Date.now();
  const a = { interactions: 1, lastAt: now };
  const b = { interactions: 20, lastAt: now };
  assert.ok(familiarityScore(b, now) > familiarityScore(a, now));

  const old = { interactions: 20, lastAt: now - 200 * 86400000 };
  assert.ok(familiarityScore(old, now) < familiarityScore(b, now));
});

test('decayFactor：45 天减半', () => {
  const now = Date.now();
  const half = decayFactor(now - 45 * 86400000, now);
  assert.ok(Math.abs(half - 0.5) < 0.02, `期望约 0.5，实际 ${half}`);
});

test('noteInteraction：记账、话题与气氛累加', () => {
  const store = createStore(tmpFile());
  noteInteraction(store, 'private:111', { label: '…1111', topics: ['技术'], mood: 'warm' });
  noteInteraction(store, 'private:111', { topics: ['技术', '备考'], mood: 'calm' });

  const p = store.data.persons['private:111'];
  assert.equal(p.interactions, 2);
  assert.equal(p.topics['技术'], 2);
  assert.equal(p.topics['备考'], 1);
  assert.equal(p.moods['warm'], 1);
});

test('noteInteraction：敏感信号不进库', () => {
  const store = createStore(tmpFile());
  noteInteraction(store, 'private:222', {
    signal: '他说膝盖很疼要住院',
    rawTexts: ['他说膝盖很疼要住院']
  });
  const p = store.data.persons['private:222'];
  assert.equal(p.signals.length, 0, '敏感信号必须被拦下');
});

test('noteInteraction：signals 有上限，不会无限增长', () => {
  const store = createStore(tmpFile());
  for (let i = 0; i < MAX_SIGNALS_PER_PERSON + 8; i += 1) {
    noteInteraction(store, 'private:333', { signal: `聊过话题第${i}类` });
  }
  const p = store.data.persons['private:333'];
  assert.ok(p.signals.length <= MAX_SIGNALS_PER_PERSON, `实际 ${p.signals.length}`);
});

test('renderRelationalBlock：标出当前会话，且不泄露原文', () => {
  const store = createStore(tmpFile());
  noteInteraction(store, 'private:2409281798', { topics: ['技术'], mood: 'warm' });
  noteInteraction(store, 'private:999', { topics: ['游戏'], mood: 'calm' });

  const block = renderRelationalBlock(store, 'private:2409281798');
  assert.match(block, /就是现在这位/);
  assert.match(block, /常聊/);
  // 不应出现完整 QQ 号
  assert.ok(!block.includes('2409281798'), '完整 QQ 号不应出现');
});

test('renderRelationalBlock：库里没人时返回空串', () => {
  const store = createStore(tmpFile());
  assert.equal(renderRelationalBlock(store, 'private:1'), '');
});

test('存储往返：落盘再读回一致', () => {
  const file = tmpFile();
  const store = createStore(file);
  noteInteraction(store, 'private:555', { label: '…5555', topics: ['日常'], mood: 'calm' });
  const r = saveStore(store);
  assert.equal(r.ok, true);

  const loaded = loadStore(createStore(file));
  assert.equal(loaded.data.persons['private:555'].interactions, 1);
});

test('存储损坏：不覆盖，只报错', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ 坏掉的 json', 'utf8');
  let reported = '';
  const store = loadStore(createStore(file), { onCorrupt: (m) => { reported = m; } });
  assert.ok(reported, '应该报告损坏');
  // 原文件仍在（没被空库覆盖）
  assert.match(fs.readFileSync(file, 'utf8'), /坏掉的 json/);
});

test('MAX_PERSONS：超出上限时淘汰最不熟的', () => {
  const store = createStore(tmpFile());
  const now = Date.now();
  // 造一个「很熟」的，和一个「很久以前只聊过一次」的
  noteInteraction(store, 'private:vip', { topics: ['技术'] });
  for (let i = 0; i < 20; i += 1) {
    noteInteraction(store, 'private:vip', {});
  }
  // 再把 lastAt 调回现在（noteInteraction 内部已设）
  store.data.persons['private:old'] = {
    label: '', interactions: 1, firstAt: now - 999 * 86400000,
    lastAt: now - 999 * 86400000, signals: [], topics: {}, moods: {}
  };
  // 填满上限
  for (let i = 0; i < 70; i += 1) {
    noteInteraction(store, `private:fill${i}`, {});
  }
  const keys = Object.keys(store.data.persons);
  assert.ok(keys.length <= 60, `上限应生效，实际 ${keys.length}`);
});
