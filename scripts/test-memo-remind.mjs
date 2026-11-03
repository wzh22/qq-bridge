// qq_memo / qq_remind 回归测试。
//
// 口径：跑**真实桥接**（bridgeHarness 求值 src/bridge.js），只把 QQ 网关、DSH 与
// 控制台端口换成 fixture：
//   · 所有落盘都在临时 state/ 目录里，不碰生产 state/；
//   · 「到点主动发消息」用 FakeBot 的 calls.sent 断言，不真的发 QQ；
//   · 定时器用真实 setTimeout（1 秒级），不 mock 时钟——要验的正是「真的会响」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const CONSOLE_TOKEN = 'fixture-console-token';

async function fixture(run, { files = {}, config = {} } = {}) {
  const h = await bridgeHarness({ config, files });
  h.setMode('reserved2');
  // 白名单来自 harness 默认配置：groups=['456']、private=['123']。
  const group = h.getSocialV2State('group:456');
  const friend = h.getSocialV2State('private:123');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  /** POST 到生活工具端点。token=null 表示**不带**令牌（验证拒绝路径）。 */
  const post = (route, body, { token, key } = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify({ key, token, ...body });
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'x-console-token': CONSOLE_TOKEN
    };
    if (token) headers['x-agent-token'] = token;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/socialV2/${route}`,
      method: 'POST',
      headers
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.end(payload);
  });

  const readState = (name) => {
    try {
      return fs.readFileSync(path.join(h.temp, 'state', name), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    return await run({ h, group, friend, server, post, readState, sleep });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

const GROUP = () => ({ key: 'group:456', token: 'GROUP_TOKEN' });

// ── qq_memo ──────────────────────────────────────────────────────────────

test('memo：按会话隔离，令牌与 key 必须绑定同一个会话', async () => {
  await fixture(async ({ h, group, friend, post, readState }) => {
    const g = { key: 'group:456', token: group.agentToken };
    const f = { key: 'private:123', token: friend.agentToken };

    const setG = await post('memo', { action: 'set', text: '群里的备忘：周六下午打球' }, g);
    assert.equal(setG.status, 200);
    assert.equal(setG.data.ok, true);
    assert.equal(setG.data.count, 1);

    const setF = await post('memo', { action: 'set', text: '私聊备忘：明天记得问他体检结果' }, f);
    assert.equal(setF.status, 200);

    const listG = await post('memo', { action: 'list' }, g);
    assert.equal(listG.data.count, 1);
    assert.match(listG.data.memos[0].text, /打球/);
    assert.ok(listG.data.memos[0].createdAt, 'list 必须带时间');

    const listF = await post('memo', { action: 'list' }, f);
    assert.equal(listF.data.count, 1);
    assert.match(listF.data.memos[0].text, /体检/);

    // 用群令牌去读私聊的 key：服务端必须拒绝（否则模型填别人的 key 就能读别人的备忘）。
    const crossKey = await post('memo', { action: 'list' }, { key: 'private:123', token: group.agentToken });
    assert.equal(crossKey.status, 403);
    assert.match(String(crossKey.data.error), /令牌无效/);

    // 完全不带令牌：同样拒绝（fail closed）。
    const noToken = await post('memo', { action: 'list' }, { key: 'group:456' });
    assert.equal(noToken.status, 403);

    // 磁盘上只有这两条，且按 key 分开存。
    const stored = JSON.parse(readState('memos.json'));
    assert.deepEqual(Object.keys(stored.memos).sort(), ['group:456', 'private:123']);
    assert.equal(stored.memos['group:456'].length, 1);
    assert.equal(stored.memos['private:123'].length, 1);
    assert.equal(h.calls.sent.length, 0, '备忘绝不外发任何 QQ 消息');
  });
});

test('memo：同 key 同 id 覆盖而不是新增，delete 按 id 生效', async () => {
  await fixture(async ({ group, post, readState }) => {
    const g = { key: 'group:456', token: group.agentToken };
    const first = await post('memo', { action: 'set', text: '旧内容' }, g);
    assert.equal(first.status, 200);
    const id = first.data.memo.id;

    const second = await post('memo', { action: 'set', id, text: '新内容' }, g);
    assert.equal(second.status, 200);
    assert.equal(second.data.count, 1, '同 key 同 id 必须覆盖，不能变成两条');
    assert.equal(second.data.memo.id, id);
    assert.equal(second.data.memo.text, '新内容');

    const list = await post('memo', { action: 'list' }, g);
    assert.equal(list.data.count, 1);
    assert.equal(list.data.memos[0].text, '新内容');

    const del = await post('memo', { action: 'delete', id }, g);
    assert.equal(del.status, 200);
    assert.equal(del.data.count, 0);
    assert.equal(JSON.parse(readState('memos.json')).memos['group:456'], undefined);

    // 再删一次：404，且不静默成功。
    const again = await post('memo', { action: 'delete', id }, g);
    assert.equal(again.status, 404);
  });
});

test('memo：每会话 50 条上限，按最近使用淘汰并在返回里明确告知', async () => {
  await fixture(async ({ group, post, readState }) => {
    const g = { key: 'group:456', token: group.agentToken };
    for (let i = 1; i <= 50; i += 1) {
      const r = await post('memo', { action: 'set', text: `第${i}条` }, g);
      assert.equal(r.status, 200);
      assert.equal(r.data.count, i);
    }
    // 第 51~55 条：每次挤掉一条最旧的，并在 evicted/note 里点名。
    for (let i = 51; i <= 55; i += 1) {
      const r = await post('memo', { action: 'set', text: `第${i}条` }, g);
      assert.equal(r.status, 200);
      assert.equal(r.data.count, 50, `写入第 ${i} 条后仍应是 50 条`);
      assert.equal(r.data.evicted.length, 1, `写入第 ${i} 条必须明确告知淘汰了哪条`);
      assert.equal(r.data.evicted[0].text, `第${i - 50}条`);
      assert.match(r.data.note, /淘汰/);
    }
    const list = await post('memo', { action: 'list' }, g);
    assert.equal(list.data.count, 50);
    assert.equal(list.data.total, 50);
    assert.ok(!list.data.memos.some((m) => m.text === '第1条'), '最旧的必须已被淘汰');
    assert.ok(list.data.memos.some((m) => m.text === '第55条'), '最新的一条必须还在');
    assert.equal(JSON.parse(readState('memos.json')).memos['group:456'].length, 50);
  });
});

test('memo：原子写——文件始终是完整 JSON，且不留下 .tmp 垃圾', async () => {
  await fixture(async ({ h, group, post, readState }) => {
    const g = { key: 'group:456', token: group.agentToken };
    for (let i = 0; i < 12; i += 1) {
      const r = await post('memo', { action: 'set', text: `原子写-${i}` }, g);
      assert.equal(r.status, 200);
    }
    const raw = readState('memos.json');
    assert.ok(raw, 'memos.json 必须存在');
    const parsed = JSON.parse(raw); // 能解析 ⇒ 没有半截写入
    assert.equal(parsed.version, 1);
    assert.equal(parsed.memos['group:456'].length, 12);
    // 原子写的临时文件必须是「写完即 rename」，正常路径下不能留在 state/ 里。
    const leftovers = fs.readdirSync(path.join(h.temp, 'state')).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

test('memo：文件损坏时不当成空库，并拒绝写入（不覆盖真实数据）', async () => {
  const corrupt = '{"version":1,"memos":{"group:456":[{"id":"keep-me"';
  await fixture(async ({ h, group, post, readState }) => {
    assert.equal(readState('memos.json'), corrupt, '启动读取失败后，磁盘原文必须原封不动');
    const g = { key: 'group:456', token: group.agentToken };
    const list = await post('memo', { action: 'list' }, g);
    assert.equal(list.status, 200, '读失败时仍允许 list（只是空视图），但绝不能写回');
    // 空视图必须自报「只读/可能不全」，否则模型会把读失败当成「本会话没有备忘」再记一遍。
    assert.equal(list.data.writable, false);
    assert.match(String(list.data.note), /只读/);
    const set = await post('memo', { action: 'set', text: '这条不能落盘' }, g);
    assert.equal(set.status, 503);
    assert.match(String(set.data.error), /只读/);
    assert.equal(readState('memos.json'), corrupt, '拒绝写入后原文必须一字不动');
    // 损坏的原文被另存了一份，方便人工修复。
    const files = fs.readdirSync(path.join(h.temp, 'state'));
    assert.ok(files.some((f) => f.startsWith('memos.json.corrupt-')), '损坏原文必须另存为 .corrupt-*');
  }, { files: { 'state/memos.json': corrupt } });
});

// ── qq_remind ────────────────────────────────────────────────────────────

test('remind：到点由宿主主动发消息（1 秒），发完即从库中移除', async () => {
  await fixture(async ({ h, group, post, readState, sleep }) => {
    const g = { key: 'group:456', token: group.agentToken };
    const added = await post('remind', { action: 'add', when: '1s', text: '喝水' }, g);
    assert.equal(added.status, 200);
    assert.equal(added.data.ok, true);
    assert.equal(added.data.count, 1);
    assert.ok(added.data.reminder.dueInMs <= 1500, `dueInMs=${added.data.reminder.dueInMs}`);
    const id = added.data.reminder.id;
    assert.equal(h.calls.sent.length, 0, '建提醒时不应该立刻发');

    await sleep(1600);

    const sent = h.calls.sent.filter((s) => s.kind === 'group' && String(s.id) === '456');
    assert.equal(sent.length, 1, `到点必须且只发一条，实际 ${JSON.stringify(h.calls.sent)}`);
    assert.equal(sent[0].text, '⏰ 提醒：喝水');
    // 提醒是宿主代发，不在模型对话里；必须记进 recentMessages（isSelf），否则用户回一句
    // 「谢谢」模型会一脸茫然，或把这条当成别人说的话。
    const selfMsgs = h.getSocialV2State('group:456').recentMessages.filter((m) => m.isSelf);
    assert.equal(selfMsgs.length, 1, `提醒必须记成「我」发的消息：${JSON.stringify(selfMsgs)}`);
    assert.equal(selfMsgs[0].text, '⏰ 提醒：喝水');
    assert.ok(h.getSocialV2State('group:456').lastAiReplyAt > 0, '要刷新 lastAiReplyAt，避免紧接着又主动搭话');
    // 发完就从 reminders.json 里移除（at-most-once：重启不会重发）。
    const stored = JSON.parse(readState('reminders.json'));
    assert.deepEqual(stored.reminders, []);
    const list = await post('remind', { action: 'list' }, g);
    assert.equal(list.data.count, 0);
    assert.ok(!JSON.stringify(list.data).includes(id));
  });
});

test('remind：重启恢复——启动时把未到期的重新挂上定时器并按时发出', async () => {
  const dueAt = Date.now() + 1200;
  const seeded = {
    version: 1,
    reminders: [{ id: 'r_seeded01', key: 'group:456', text: '重启后也要响', when: '1s', dueAt, createdAt: Date.now() }]
  };
  await fixture(async ({ h, group, post, sleep }) => {
    // 启动时以已存在的一条待发提醒开局（模拟桥接重启）。
    const list = await post('remind', { action: 'list' }, { key: 'group:456', token: group.agentToken });
    assert.equal(list.data.count, 1, '状态文件里的提醒必须被恢复');
    assert.equal(list.data.reminders[0].id, 'r_seeded01');
    await sleep(Math.max(600, dueAt - Date.now()) + 500);
    const sent = h.calls.sent.filter((s) => s.kind === 'group');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, '⏰ 提醒：重启后也要响');
  }, { files: { 'state/reminders.json': JSON.stringify(seeded) } });
});

test('remind：重启时超过 5 分钟宽限的过期提醒直接丢弃（不补发僵尸提醒）', async () => {
  const stale = {
    version: 1,
    reminders: [{
      id: 'r_stale', key: 'group:456', text: '两小时前的提醒',
      when: '2h', dueAt: Date.now() - 2 * 60 * 60 * 1000, createdAt: Date.now() - 3 * 60 * 60 * 1000
    }]
  };
  await fixture(async ({ h, group, post, readState, sleep }) => {
    await sleep(300);
    const list = await post('remind', { action: 'list' }, { key: 'group:456', token: group.agentToken });
    assert.equal(list.data.count, 0, '过期提醒不能被恢复');
    assert.equal(h.calls.sent.length, 0, '过期提醒绝不能补发');
    // 清理也要落盘，否则每次重启都会再扫到它。
    assert.deepEqual(JSON.parse(readState('reminders.json')).reminders, []);
  }, { files: { 'state/reminders.json': JSON.stringify(stale) } });
});

test('remind：重启时刚过点（5 分钟宽限内）的提醒补发，且会错开发送', async () => {
  const justMissed = {
    version: 1,
    reminders: [{
      id: 'r_catchup', key: 'group:456', text: '刚过点的那条',
      when: '1m', dueAt: Date.now() - 60 * 1000, createdAt: Date.now() - 60 * 1000
    }]
  };
  await fixture(async ({ h, group, post, sleep }) => {
    const list = await post('remind', { action: 'list' }, { key: 'group:456', token: group.agentToken });
    assert.equal(list.data.count, 1, '宽限内的提醒必须被恢复（不是直接丢弃）');

    // 错开：第一条补发最早也要 2s 后，不能在启动瞬间就炸出来。
    await sleep(600);
    assert.equal(h.calls.sent.length, 0, '重启瞬间不该立刻补发（要给正常发送节奏留余量）');
    await sleep(2200);

    const sent = h.calls.sent.filter((s) => s.kind === 'group');
    assert.equal(sent.length, 1, `宽限内的提醒最终必须补发：${JSON.stringify(h.calls.sent)}`);
    assert.equal(sent[0].text, '⏰ 提醒：刚过点的那条');
  }, { files: { 'state/reminders.json': JSON.stringify(justMissed) } });
});

test('remind：每会话 10 条上限、单条 200 字、7 天外拒绝', async () => {
  await fixture(async ({ group, post }) => {
    const g = { key: 'group:456', token: group.agentToken };
    for (let i = 1; i <= 10; i += 1) {
      const r = await post('remind', { action: 'add', when: '2h', text: `提醒${i}` }, g);
      assert.equal(r.status, 200, `第 ${i} 条应成功：${JSON.stringify(r.data)}`);
      assert.equal(r.data.count, i);
    }
    const eleventh = await post('remind', { action: 'add', when: '2h', text: '第11条' }, g);
    assert.equal(eleventh.status, 409);
    assert.match(String(eleventh.data.error), /上限 10 条/);

    const list = await post('remind', { action: 'list' }, g);
    assert.equal(list.data.count, 10);
    assert.equal(list.data.limits.perSession, 10);

    // 删一条后又能加：上限是「待发」，不是永久配额。
    const del = await post('remind', { action: 'delete', id: list.data.reminders[0].id }, g);
    assert.equal(del.status, 200);
    assert.equal(del.data.count, 9);
    const readd = await post('remind', { action: 'add', when: '30m', text: '腾出位置后的一条' }, g);
    assert.equal(readd.status, 200);

    // 单条 200 字上限。
    const tooLong = await post('remind', { action: 'add', when: '1h', text: 'x'.repeat(201) }, g);
    assert.equal(tooLong.status, 400);
    assert.match(String(tooLong.data.error), /上限 200 字/);

    // 7 天外拒绝：8 天 / 8d。
    const far = await post('remind', { action: 'add', when: '8d', text: '太远了' }, g);
    assert.equal(far.status, 400);
    assert.match(String(far.data.error), /7 天/);
    const farDate = await post('remind', {
      action: 'add',
      when: new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
      text: '绝对时间太远'
    }, g);
    assert.equal(farDate.status, 400);
  });
});

test('remind：时间格式——相对/明天9点/绝对时间都能解析', async () => {
  await fixture(async ({ group, post }) => {
    const g = { key: 'group:456', token: group.agentToken };
    const rel = await post('remind', { action: 'add', when: '1h30m', text: '组合相对时间' }, g);
    assert.equal(rel.status, 200);
    assert.ok(Math.abs(rel.data.reminder.dueInMs - 90 * 60 * 1000) < 5000, `dueInMs=${rel.data.reminder.dueInMs}`);

    const tomorrow = await post('remind', { action: 'add', when: '明天9点', text: '明天九点' }, g);
    assert.equal(tomorrow.status, 200);
    const due = new Date(tomorrow.data.reminder.dueAt);
    assert.equal(due.getHours(), 9);
    assert.equal(due.getMinutes(), 0);
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    assert.equal(due.getDate(), tomorrowDate.getDate(), '必须落在明天');

    const absolute = new Date(Date.now() + 26 * 3600 * 1000);
    const when = `${absolute.getFullYear()}-${String(absolute.getMonth() + 1).padStart(2, '0')}-${String(absolute.getDate()).padStart(2, '0')} ${String(absolute.getHours()).padStart(2, '0')}:${String(absolute.getMinutes()).padStart(2, '0')}`;
    const abs = await post('remind', { action: 'add', when, text: '绝对时间' }, g);
    assert.equal(abs.status, 200, JSON.stringify(abs.data));
    assert.equal(new Date(abs.data.reminder.dueAt).getMinutes(), absolute.getMinutes());
  });
});

test('非法输入：全部拒绝且不留副作用', async () => {
  await fixture(async ({ h, group, post, readState }) => {
    const g = { key: 'group:456', token: group.agentToken };

    for (const body of [
      { action: 'set', text: '' },
      { action: 'set', text: '   ' },
      { action: 'set', text: 'x'.repeat(501) },
      { action: 'set', text: 'ok', id: '有空格 的 id' },
      { action: 'set', text: 'ok', id: 'x'.repeat(41) },
      { action: 'nope', text: 'ok' }
    ]) {
      const r = await post('memo', body, g);
      assert.equal(r.status, 400, `应拒绝：${JSON.stringify(body)} → ${JSON.stringify(r.data)}`);
    }
    // 非法 key 格式
    const badKey = await post('memo', { action: 'list' }, { key: 'group:abc', token: group.agentToken });
    assert.equal(badKey.status, 400);

    for (const body of [
      { action: 'add', when: '', text: '没有时间' },
      { action: 'add', when: '明天', text: '只有日期' },
      { action: 'add', when: 'hello', text: '乱写的时间' },
      { action: 'add', when: '0s', text: '零秒' },
      { action: 'add', when: '1h', text: '' },
      { action: 'add', when: '1s', text: 'x'.repeat(201) },
      { action: 'nope', when: '1h', text: 'ok' }
    ]) {
      const r = await post('remind', body, g);
      assert.equal(r.status, 400, `应拒绝：${JSON.stringify(body)} → ${JSON.stringify(r.data)}`);
    }
    const neg = await post('remind', { action: 'add', dueAt: Date.now() - 1000, text: '过去' }, g);
    assert.equal(neg.status, 400);
    const unknownDelete = await post('remind', { action: 'delete', id: 'r_nope' }, g);
    assert.equal(unknownDelete.status, 404);

    // 一条都没写进去。
    assert.equal(readState('memos.json'), null, '被拒绝的备忘不应创建文件');
    // 提醒库文件存在与否都行，但里面必须是空的。
    const raw = readState('reminders.json');
    if (raw) assert.deepEqual(JSON.parse(raw).reminders, []);
    assert.equal(h.calls.sent.length, 0);
  });
});

test('remind：取消后不会再发（定时器必须真的被清掉）', async () => {
  await fixture(async ({ h, group, post, sleep }) => {
    const g = { key: 'group:456', token: group.agentToken };
    const added = await post('remind', { action: 'add', when: '1s', text: '这条会被取消' }, g);
    assert.equal(added.status, 200);
    const del = await post('remind', { action: 'delete', id: added.data.reminder.id }, g);
    assert.equal(del.status, 200);
    await sleep(1500);
    assert.equal(h.calls.sent.length, 0, `取消后不该再发：${JSON.stringify(h.calls.sent)}`);
  });
});

// ── 顺延：撞上免打扰/静默时不能静默丢弃 ──────────────────────────────────
// 这两条钉的是 2026-11-03 的行为修正。改之前：
//   · 免打扰时段「按用户指定时间照常发」——当前配置 22:00–06:30，凌晨真会把人吵醒；
//   · 静默模式直接丢弃——操作者主动要求的安静，不该变成「提醒永久失效且用户不知道」。
// 现在两者都顺延（requeueReminder），仍会发，只是晚一点。

test('remind：落在免打扰时段要顺延，不立即发也不丢弃', async () => {
  // 造一个「现在就在免打扰里」的区间：00:00–23:59 覆盖全天。
  const config = { socialV2: { proactive: { quietRanges: [{ start: '00:00', end: '23:59' }] } } };
  await fixture(async ({ h, group, post, sleep, readState }) => {
    const g = { key: 'group:456', token: group.agentToken };
    const added = await post('remind', { action: 'add', when: '1s', text: '免打扰里到的' }, g);
    assert.equal(added.status, 200);
    const id = added.data.reminder.id;
    await sleep(1600);

    // 关键断言：到点了但**一条都没发**（被顺延）。
    assert.equal(h.calls.sent.length, 0, `免打扰时段内不该立即发：${JSON.stringify(h.calls.sent)}`);

    // 而且不能凭空消失：必须还在库里，dueAt 被推后，且带 deferred 计数。
    const raw = JSON.parse(readState('reminders.json') || '{"reminders":[]}');
    const still = raw.reminders.find((r) => r.id === id);
    assert.ok(still, `提醒必须被顺延而不是丢弃，实得：${JSON.stringify(raw.reminders)}`);
    assert.ok(still.deferred >= 1, `应记下顺延次数，实得 ${still.deferred}`);
    assert.ok(still.dueAt > Date.now(), `dueAt 必须被推后，实得 ${still.dueAt}`);
  }, { config });
});

test('remind：静默模式下顺延而不是丢弃', async () => {
  // 静默是 current-role.json 的 mode='silent'（且主人私聊不受限，见 shouldBlockSilentReply）。
  // 直接在 files 里预置这个状态文件，比调内部 API 稳。
  const silentState = JSON.stringify({ role: null, mode: 'silent' });
  await fixture(async ({ h, group, post, sleep, readState }) => {
    const g = { key: 'group:456', token: group.agentToken };
    const added = await post('remind', { action: 'add', when: '1s', text: '静默期到的' }, g);
    assert.equal(added.status, 200);
    const id = added.data.reminder.id;

    await sleep(1600);
    assert.equal(h.calls.sent.length, 0, `静默模式不该发：${JSON.stringify(h.calls.sent)}`);

    const raw = JSON.parse(readState('reminders.json') || '{"reminders":[]}');
    const still = raw.reminders.find((r) => r.id === id);
    assert.ok(still, `静默模式下提醒必须被顺延而不是丢弃，实得：${JSON.stringify(raw.reminders)}`);
    assert.ok(still.deferred >= 1);
  }, { files: { 'state/current-role.json': silentState } });
});