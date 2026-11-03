// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as mediaNormalize from '../src/media-normalize.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as voiceSynthesis from '../src/voice-synthesis.js';
import * as roleEvolution from '../src/role-evolution.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as roleCard from '../src/role-card.js';
import * as roleGuard from '../src/role-guard.js';
import * as ownerMemory from '../src/owner-memory.js';
import * as memoryDecay from '../src/memory-decay.js';
import * as diaryCore from '../src/diary-core.js';
import * as diaryGrade from '../src/diary-grade.js';
// 日记本本体（叙事性长期记忆）。bridge.js 顶层是**别名**导入，见下面 context 里的说明。
import * as diary from '../src/diary.js';
// 主人收件箱摘要 / 「主人教的说话方式」同步 / 贴吧语感档案 / SnowLuma 端点自发现。
// 这四组在本次修复前全部漏注入，其中日记与贴吧风格被 try/catch 吞成一行日志，
// 属于最危险的「静默假绿」（测试全绿而链路从未执行）。见文件末尾的自检说明。
import * as ownerInbox from '../src/owner-inbox.js';
import * as styleSync from '../src/style-sync.js';
import * as tieba from '../src/tieba.js';
// 跨会话关系记忆（「她跟每个人相处到哪一步」）。bridge.js 顶层有 3 个别名导入。
import * as relationalMemory from '../src/relational-memory.js';
import * as snowlumaConn from '../src/snowluma-conn.js';
import * as stateAcl from '../src/state-acl.mjs';
import * as quietHours from '../src/quiet-hours.js';
// 「她自己的状态」：bridge.js 顶层 import 了 buildInnerLifeLines / proactiveFactor / tickLife，
// VM 里没有 import 机制，不注入的话任何走到 buildWakePromptV2 或 scheduleProactiveCheckV2
// 的用例都会 ReferenceError（表现为「唤醒 prompt 生不出来」这类假失败）。
import * as innerLife from '../src/inner-life.js';
import * as toneAnchor from '../src/tone-anchor.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';
// 向量召回（日记的「关键词 + 语义」混合检索）：bridge.js 顶层按别名导入了这批函数，
// VM 里没有 import 机制，必须在这里引入、并在 context 里按别名绑定。
import * as vectorRecall from '../src/vector-recall.js';
// 内部独白检测（narration-guard.js）：bridge.js 顶层按**原名**导入了
// detectNarration / NARRATION_NUDGE（没有 as 别名），同名绑定即可。
// 纯字符串规则判断，不碰网络/文件，接真实现。
import * as narrationGuard from '../src/narration-guard.js';

const root = fileURLToPath(new URL('..', import.meta.url));

// ── 顶层 import 绑定自检 ─────────────────────────────────────────────────────
// 为什么需要它（写在这段代码之前，因为这类坑已经重复踩了至少四次）：
//   本文件把 bridge.js 的**所有顶层 import 剥掉**，改由我们在 context 里按名字注入。
//   于是 bridge.js 每新增一个 import，就多了一个「只有人记得补」的隐式契约。
//   漏了会分成两种后果，都很糟：
//     ① 大声型：模块顶层就用到（如 setVectorLogger），VM 求值期 ReferenceError，
//        所有用例一起红，堆栈却指向本文件。
//     ② 静默型（更危险）：被 bridge.js 的 try/catch 吞掉，只在 state/bridge.log
//        留一行「loadDiary is not defined」，测试全绿而**链路从未执行**。
//        2026-10 这次就是：所有走 bridgeHarness 的用例里，日记/贴吧风格链路是空跑的。
//   所以把「靠人记得补」换成「漏了就红」：构建 context 后逐个探测绑定名是否可用。
//
// 判定规则（避免误报，三条都很关键）：
//   a) 只用 bridge.js 顶层 import 里**声明的那个本地名**（别名取别名，如
//      `nowIso as roleEvoNow` 取 roleEvoNow），不去猜模块原始名；
//   b) 跳过纯副作用 import（`import './x.js'`）和 namespace import（`import * as X`，
//      X 在 bridge.js 里是对象，VM 里没有它本来就是既有行为，不在本次射程）；
//   c) **只检查 bridge.js 真正用到的名字**：在剥掉 import 语句后的源码里做一次
//      词边界搜索（注释和普通字符串已剔除，模板串里的 ${…} 保留为代码）。
//      没被用到的 import 不算缺口 —— 那种应该去 bridge.js 侧删 import，不是往
//      harness 里塞名字。这样也能挡住「只在注释里出现过」的假缺口。
function parseTopLevelImports(statements) {
  const out = [];
  for (const stmt of statements) {
    const m = /^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/.exec(stmt);
    if (!m) continue;                       // 纯副作用 import：没有绑定
    const clause = m[1];
    const source = m[2];
    const names = [];
    let rest = clause;
    const braces = /\{([\s\S]*?)\}/.exec(clause);
    if (braces) {
      rest = clause.slice(0, braces.index) + clause.slice(braces.index + braces[0].length);
      for (const part of braces[1].split(',')) {
        const spec = part.trim();
        if (!spec) continue;
        const asM = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(spec);
        // 别名必须取 as 后面的本地名：展开模块原始名是接不上的（这正是本文件的经典坑）。
        names.push(asM ? { local: asM[2], imported: asM[1], alias: true } : { local: spec, imported: spec, alias: false });
      }
    }
    rest = rest.trim().replace(/,$/, '').trim();
    if (rest) {
      const starM = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(rest);
      if (starM) names.push({ local: starM[1], imported: '*', alias: false, namespace: true });
      else if (/^[A-Za-z_$][\w$]*$/.test(rest)) names.push({ local: rest, imported: 'default', alias: false, default: true });
    }
    for (const n of names) out.push({ ...n, source });
  }
  return out;
}

// 把注释和普通字符串清空，但**保留模板串里的 ${…} 表达式**（那是代码）。
// 曾用「反引号整段当字符串剥掉」的粗暴写法，结果把
// `${STYLE_SECTION_TITLE}` 这种真实引用误判成「未使用」。
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  const tplDepth = [];   // 模板串 ${ } 里嵌套的花括号层数
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === '`') { state = 'tpl'; out += ' '; i++; continue; }
      if (c === "'" || c === '"') { state = c; out += ' '; i++; continue; }
      if (tplDepth.length) {
        if (c === '{') tplDepth[tplDepth.length - 1] += 1;
        else if (c === '}') {
          if (tplDepth[tplDepth.length - 1] === 0) { tplDepth.pop(); state = 'tpl'; out += ' '; i++; continue; }
          tplDepth[tplDepth.length - 1] -= 1;
        }
      }
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += '\n'; } i++; continue; }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += '\n';
      i++; continue;
    }
    if (state === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { state = 'code'; i++; continue; }
      if (c === '$' && c2 === '{') { tplDepth.push(0); state = 'code'; i += 2; continue; }
      if (c === '\n') out += '\n';
      i++; continue;
    }
    // 单/双引号字符串
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') out += '\n';
    if (c === state) state = 'code';
    i++;
  }
  return out;
}

// 在已剥离 import 的源码里判断某个标识符是否被引用（词边界，排除 `.prop` 与对象键）。
function isReferenced(bodyCode, name) {
  const esc = name.replace(/\$/g, '\\$');
  const re = new RegExp(`(?<![\\w$.])${esc}(?![\\w$])`, 'g');
  return re.test(bodyCode);
}

// 自检本体：在 context 建好、**main() 求值之前**调用。
// 逐名 vm.runInContext('typeof <name>') 探测 —— 这是运行时事实，不受
// 「某个名字在别处碰巧也叫这个」影响（typeof 只回答「这个名字此刻能不能解析」）。
function assertAllImportBindingsBound({ context, importStatements, bodyCode }) {
  const declared = parseTopLevelImports(importStatements);
  const missing = [];
  const unused = [];
  const namespace = [];
  const seen = new Set();
  for (const b of declared) {
    if (b.namespace) { namespace.push(b); continue; }
    if (seen.has(b.local)) continue;
    seen.add(b.local);
    const referenced = isReferenced(bodyCode, b.local);
    if (!referenced) { unused.push(b); continue; }
    // 探针：在 vm 里**真的求值这个标识符**。
    //   · 未声明 → ReferenceError（被 catch，记进 missing）
    //   · 声明了但值是 undefined → 求值成功，不算缺失
    // 这条区分很关键：曾用 `typeof x === 'undefined'` 判断，会把这二者混为一谈，
    // 从而对「绑定了但值是 undefined」误报。注释/字符串已在 bodyCode 里剔除，
    // 所以这里不会因为注释里出现过同名就误判「有定义」。
    try {
      vm.runInContext(`(${b.local})`, context);
    } catch (error) {
      // ⚠️ 不能用 `error instanceof ReferenceError`：vm 里抛出的 ReferenceError
      // 来自**另一个 realm**（vm context 自己的 global），原型链和本文件的
      // ReferenceError 不是同一个，instanceof 会返回 false —— 于是真正的缺失
      // 会被当成"意外异常"重新抛出，自检就退化成把 vm 的原始错栈甩给调用方，
      // 既没有清单也看不出是 harness 少注入。
      // （踩过：构造验证时 test-reply-wait 10/10 全红，但报错只是一堆
      //   `evalmachine.<anonymous>:1 (loadDiary)` 错栈。）
      // 改判 error.name，它跨 realm 仍然稳定。
      if (error?.name !== 'ReferenceError') throw error;
      missing.push(b);
    }
  }
  if (missing.length) {
    const lines = missing.map((b) => `  - ${b.local}${b.alias ? `   (alias of ${b.imported})` : ''}   from '${b.source}'`);
    throw new Error(
      `audit-bridge-harness：${missing.length} 个 bridge.js 顶层 import 的绑定没有注入到 vm context。\n`
      + `bridge.js 会 ReferenceError（或更糟：被 try/catch 吞成桥接日志里一行「X is not defined」，测试全绿但链路空跑）。\n`
      + lines.join('\n')
      + `\n修复：在 bridgeHarness 的 context 里补上同名的绑定（别名要按别名绑定，不能直接展开模块）。`
    );
  }
  return { declared, missing, unused, namespace };
}

export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], faces: [], http: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    // fetch_custom_face_detail：同步收藏表情的 HTTP 兜底路径要拿到**数组**（WS 失败时用）。
    if (action === 'fetch_custom_face_detail') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: [{ emoji_id: 'http-fixture-sticker', resId: 'http-fixture-sticker', url: 'https://public.invalid/http-sticker', md5: 'AABBCCDDEEFF00112233445566778899', desc: 'HTTP 兜底表情' }]
        })
      };
    }
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    // settings.describe 的默认桩：没有 qq-mode 命名空间 ⇒ refreshMode() 回退到本地 mode.json。
    // 测试可覆盖它来验证「DSH 设置里的空 ownerQQ 不得覆盖 config.json」等契约。
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request(action, params = {}) {
      // 群成员列表：v2 读工具 qq_get_group_members 会用到（含 WS 不可用时的 HTTP 兜底路径）。
      if (action === 'get_group_member_list') {
        return {
          status: 'ok', retcode: 0,
          data: [
            { user_id: 111, nickname: '小明', card: '小明', role: 'member' },
            { user_id: 222, nickname: '路人', card: '' },
            { user_id: 123, nickname: '管理员', card: '群主', role: 'owner' }
          ]
        };
      }
      return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] };
    }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  //
  // 顺手把被剥掉的语句本身留下来（importStatements）：下面的自检要拿它算
  // 「bridge.js 到底声明了哪些绑定名」，这是唯一权威来源，不能靠人眼维护。
  const importStatements = [];
  {
    const dropping = [];
    const kept = [];
    let inImport = false;
    for (const line of source.split(/\r?\n/)) {
      if (inImport) {
        dropping.push(line);
        if (/;\s*$/.test(line)) { importStatements.push(dropping.splice(0).join('\n')); inImport = false; }
        continue;
      }
      if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
        if (/;\s*$/.test(line)) importStatements.push(line);
        else { dropping.push(line); inImport = true; }
        continue;
      }
      kept.push(line);
    }
    if (dropping.length) importStatements.push(dropping.join('\n'));
    source = kept.join('\n');
  }
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    syncStickerLibrary, listStickersForV2, getStickerImageData,
    refreshMode, modeAllowed, trackTurnEvent, replayPendingWakeReasonsV2,
    collectors, setupSleepTimerV2, scheduleProactiveCheckV2, cancelProactiveCheckV2,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPromptV2,
    initialPrompts, initialPromptMaxChars,
    extractMediaFromSegments, segmentsToText, fetchOneBotImage, fetchMediaData, resolveMediaList,
    emojiCdnCandidates, getImageDimensions, acceptImageBuffer, MAX_MEDIA_BYTES,
    GIF_MAX_FETCH_BYTES, bot,
    isConversationBusyV2, v2TurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS,
    settingFromDshNamespace, selfIdentityTextV2, buildWakeReminderPromptV2,
    getMode() { return currentMode; },
    setSelfIdentity(display, id) {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    flushQueue, retireSession,
    // 自动会话轮换（2026-11-03）：bridge.js 里是 main() 内的闭包，VM 里没有 import，
    // 只能从这里暴露，否则 scripts/test-session-rotate.mjs 无法在无 mux 的 VM 里
    // 驱动「先写记忆再退役」这条链路（学习会话的 turn 结束信号只在 pumpMux 里发出）。
    // 只影响 harness，不影响线上执行路径。
    maybeRotateSession, sweepSessionRotation, buildRotationStatus, runDiaryWrite, learnerWaiters,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...voiceSynthesis, ...stateAcl, ...presetPrompt,
    // 人格卡解析：bridge.js 的 bootstrap 唤醒会把人格卡正文内联进提示词，
    // 该路径在 VM 里会真正调用 selectRoleText —— 不注入就是
    // `ReferenceError: selectRoleText is not defined`（只影响测试，不影响线上）。
    ...roleCard,
    // 人格自我演进：bridge.js 顶层 import 了这批函数（观察/反馈/提案/快照）。
    // 与上面 roleCard / ownerMemory 同理——VM 里不注入就是
    // `ReferenceError: loadFeedback is not defined`，而且是走到 /api/roles/evo/* 才炸，
    // 所以只在 persona 相关用例里暴露。逐个显式绑定，避免展开时撞到通用名（如 nowIso）。
    appendObservation: roleEvolution.appendObservation,
    readObservations: roleEvolution.readObservations,
    loadFeedback: roleEvolution.loadFeedback,
    addFeedback: roleEvolution.addFeedback,
    loadProfiles: roleEvolution.loadProfiles,
    loadProposals: roleEvolution.loadProposals,
    saveProposals: roleEvolution.saveProposals,
    addProposal: roleEvolution.addProposal,
    applyProposalToText: roleEvolution.applyProposalToText,
    classifyFeedback: roleEvolution.classifyFeedback,
    summarizeFeedback: roleEvolution.summarizeFeedback,
    snapshotRole: roleEvolution.snapshotRole,
    listRoleHistory: roleEvolution.listRoleHistory,
    // 别名：bridge.js 里是 `nowIso as roleEvoNow`
    roleEvoNow: roleEvolution.nowIso,
    // 人格演进护栏：bridge.js 顶层也 import 了这批（预演与真实应用共用同一份判断）。
    // 不注入的话，任何走 /api/roles/evo/proposal 或 /apply 的用例都会
    // `ReferenceError: guardProposalChange is not defined` —— 表现是 500，
    // 而测试只断言 200，于是失败信息看起来像「路由坏了」，实际是 VM 少注入了名字。
    guardProposalChange: roleGuard.guardProposalChange,
    indexRoleSections: roleGuard.indexSections,
    indexSections: roleGuard.indexSections,
    coreSectionOf: roleGuard.coreSectionOf,
    countRecentApplies: roleGuard.countRecentApplies,
    GUARD_LIMITS: roleGuard.GUARD_LIMITS,
    // 主人记忆：bridge.js 顶层 import 了 owner-memory 的这批函数，但 harness 一直没注入，
    // 于是任何真正走到「消息归档」的用例都会 `ReferenceError: appendArchiveLine is not defined`。
    // 显式逐个绑定（不用展开）：避免与 context 里已有的通用名（nowIso/createId 等）撞车。
    loadOwnerMemory: ownerMemory.loadOwnerMemory,
    saveOwnerMemory: ownerMemory.saveOwnerMemory,
    mergeFacts: ownerMemory.mergeFacts,
    buildOwnerMemoryContext: ownerMemory.buildOwnerMemoryContext,
    buildFactExtractionPrompt: ownerMemory.buildFactExtractionPrompt,
    parseFactJson: ownerMemory.parseFactJson,
    appendArchiveLine: ownerMemory.appendArchiveLine,
    readArchiveSince: ownerMemory.readArchiveSince,
    // 同上，但这个是后来才加进 owner-memory 的（按 key 扫稀疏归档，避免水位卡死）。
    // 漏注入时「主人教的说话方式」的读取会 ReferenceError，被 try/catch 吞成
    // 一行「风格读取失败」日志——和日记那条是同一类静默假绿。
    readArchiveForKey: ownerMemory.readArchiveForKey,
    // 记忆衰减：bridge.js 顶层 import 了这几个（日记的「想起/活跃日」计分要用），
    // 而且**模块顶层**就要用到 `saveDecayState`（DECAY_SAVE_REGISTRY 的默认注入）。
    // 不注入的话整个 VM 在求值阶段就 ReferenceError，表现为全部用例一起红，
    // 错误信息只指向那行赋值，看着完全不像「测试 harness 少注入了一个名字」。
    // 逐个显式绑定，不用展开：retention / memoryScore 这类通用名容易撞车。
    DECAY_DEFAULTS: memoryDecay.DECAY_DEFAULTS,
    loadDecayState: memoryDecay.loadDecayState,
    saveDecayState: memoryDecay.saveDecayState,
    markActiveDay: memoryDecay.markActiveDay,
    touchEntries: memoryDecay.touchEntries,
    pruneDecayState: memoryDecay.pruneDecayState,
    // 日记核层（不该遗忘的那一类）：bridge.js 顶层 import 了这批。
    // 不注入的话构建唤醒 prompt 时会 ReferenceError（coreBlockFor → renderCoreContext），
    // 而**错误被 prompt 组装路径吞掉**，表现出来完全不像「少注入一个名字」：
    // test-reply-wait 的两个用例变成「arrived 应为 false 却是 true」
    // 和「newMessages 里多了一条旧消息」——看起来像等待逻辑坏了，实际是注入块没生成。
    // 这正是本文件反复记录过的同一类坑，不要再踩。
    loadDiaryCore: diaryCore.loadCore,
    appendDiaryCore: diaryCore.appendCore,
    writeDiaryCore: diaryCore.writeCore,
    renderCoreContext: diaryCore.renderCoreContext,
    buildCoreExtractPrompt: diaryCore.buildCoreExtractPrompt,
    parseCoreJson: diaryCore.parseCoreJson,
    mergeCoreEntries: diaryCore.mergeCoreEntries,
    closeCorePromise: diaryCore.closePromise,
    CORE_INJECT_MAX_CHARS: diaryCore.CORE_INJECT_MAX_CHARS,
    CORE_KINDS: diaryCore.CORE_KINDS,
    // ── 日记本本体（diary.js）─────────────────────────────────────────────
    // 这批是本次修复的主目标。漏注入时 bridge.js 的 try/catch 把
    // `loadDiary is not defined` 吞成 state/bridge.log 里一行
    // 「日记本加载失败，已暂停写入以免覆盖磁盘数据」，于是**所有 harness 用例里
    // 日记链路从未真正执行过**，测试却全绿。
    //
    // 命名上有两个陷阱，所以这里逐个别名绑定、**不能** `...diary`：
    //   ① bridge.js 用的是别名：appendEntry as appendDiaryEntry、
    //      appendCorrection as appendDiaryCorrection。展开注入的是 appendEntry /
    //      appendCorrection，对不上 bridge.js 里真正调用的名字。
    //   ② diary.js 也导出 nowIso，会和 context 里已有的 nowIso 撞车
    //      （现在由 slang / sticker 两个 spread 提供，语义还不一致）。
    // 只用 bridge.js 顶层 import 里真正声明的那个绑定名，避免把
    // 未使用的通用名（tokenize / scoreEntry / nowIso …）泄漏进 VM。
    loadDiary: diary.loadDiary,
    appendDiaryEntry: diary.appendEntry,             // alias: appendEntry as appendDiaryEntry
    appendDiaryCorrection: diary.appendCorrection,   // alias: appendCorrection as appendDiaryCorrection
    buildDiaryContext: diary.buildDiaryContext,
    buildDiaryWritePrompt: diary.buildDiaryWritePrompt,
    parseDiaryJson: diary.parseDiaryJson,
    parseQuery: diary.parseQuery,
    recallEntries: diary.recallEntries,
    keywordScoresFor: diary.keywordScoresFor,
    renderEntryLine: diary.renderEntryLine,
    capEntries: diary.capEntries,
    selectInjectedIds: diary.selectInjectedIds,
    DIARY_MAX_ENTRIES: diary.DIARY_MAX_ENTRIES,
    // ── 主人收件箱摘要（owner-inbox.js）────────────────────────────────────
    // 纯函数、不碰外部资源：解析/渲染/脱敏。导出名里没有通用名，可以整块展开；
    // 但为了与本文件「只注入 bridge.js 顶层 import 声明过的绑定」这条规矩一致，
    // 仍然逐个列出（多注入的名字会让自检看不出真实用量）。
    buildInboxSummaryPrompt: ownerInbox.buildInboxSummaryPrompt,
    parseInboxSummary: ownerInbox.parseInboxSummary,
    renderInboxSummary: ownerInbox.renderInboxSummary,
    maskQQ: ownerInbox.maskQQ,
    MAX_SESSIONS_PER_SUMMARY: ownerInbox.MAX_SESSIONS_PER_SUMMARY,
    // ── 「主人教的说话方式」同步（style-sync.js）──────────────────────────
    // 同上，纯函数（读/写人格卡里的某个小节）。注意桥接里是
    // `MAX_RULES as STYLE_MAX_RULES`，按原始名展开就对不上。
    buildStyleExtractionPrompt: styleSync.buildStyleExtractionPrompt,
    parseStyleJson: styleSync.parseStyleJson,
    appendStyleRules: styleSync.appendStyleRules,
    readStyleRules: styleSync.readStyleRules,
    STYLE_SECTION_TITLE: styleSync.STYLE_SECTION_TITLE,
    STYLE_MAX_RULES: styleSync.MAX_RULES,            // alias: MAX_RULES as STYLE_MAX_RULES
    // ── 贴吧语感档案（tieba.js）───────────────────────────────────────────
    // bridge.js 顶层四个别名导入，一个都不能按原始名展开（loadStyle /
    // buildStyleContext / saveStyle / normalizeStyleProfile）。
    // 只注入这四个：模块里其余导出（connectCdp / navigate / collectCorpus …）
    // 会连真实浏览器 CDP 端口，测试环境绝不该拿到。
    loadTiebaStyle: tieba.loadStyle,                         // alias: loadStyle
    buildTiebaStyleContext: tieba.buildStyleContext,          // alias: buildStyleContext
    saveTiebaStyle: tieba.saveStyle,                          // alias: saveStyle
    normalizeTiebaStyleProfile: tieba.normalizeStyleProfile,  // alias: normalizeStyleProfile
    // ── 跨会话关系记忆（relational-memory.js）──────────────────────────────
    // 又一组别名（createStore / loadStore / saveStore 都是极通用的名字），
    // 展开注入会同时导致「名字对不上」和「撞车」两个问题。
    // 只碰 STATE_DIR 下的本地 JSON（readFileSync/writeFileSync），没有网络、
    // 没有 ffmpeg/GPU，所以直接接真实现即可，无需打桩。
    createRelationalStore: relationalMemory.createStore,   // alias: createStore
    loadRelationalStore: relationalMemory.loadStore,       // alias: loadStore
    saveRelationalStore: relationalMemory.saveStore,       // alias: saveStore
    noteInteraction: relationalMemory.noteInteraction,
    recordRelationalMessage: relationalMemory.recordMessage,               // alias: recordMessage
    enrichRelationalFromMessages: relationalMemory.enrichFromMessages,     // alias: enrichFromMessages
    renderRelationalBlock: relationalMemory.renderRelationalBlock,
    // ── 内部独白检测（narration-guard.js）────────────────────────────────
    // bridge.js 顶层按原名导入这两个（不是别名），同名绑定即可。
    // 纯规则判断、无外部副作用（不碰网络/文件/GPU），接真实现。
    // 只注入 bridge.js 实际引用的两个；模块另导出 MIN_HITS / detectNarrationFeatures，
    // 顶层没用过，按自检口径不算缺口，故不注入。
    detectNarration: narrationGuard.detectNarration,
    NARRATION_NUDGE: narrationGuard.NARRATION_NUDGE,
    // ── SnowLuma 端点自发现（snowluma-conn.js）────────────────────────────
    // 读起来像「只读本地文件」，但有两条**真实外部副作用**，所以按
    // processAudioVolume / cleanupTemp 的约定打桩，并允许 globals 覆盖：
    //   ① discoverSnowLumaConnection 默认对 http://127.0.0.1:3000 发真 HTTP 探活
    //      （probe 里调 fetch，而真实 realm 的 fetch 不受本文件 fakeFetch 影响）；
    //   ② persistSnowLumaEndpoint / persistToken 直接 fs.writeFileSync 写
    //      **真实 config.json**（bridge.js 里写的是 path.join(ROOT,'config.json')，
    //      而本 harness 的假 config.json 在临时目录里，跟它不是一个文件）。
    // 若接真实现，任何走到 bot.on('open') 或他国自愈重连的用例都会改到开发者
    // 本机的生产配置。真实行为由 test-snowluma-conn.mjs / test-onebot-connection.mjs
    // 直接 import 真实模块来覆盖，不走 VM。
    discoverSnowLumaConnection: async () => ({ ok: false, tried: [], error: 'stub：harness 不探活本机网关' }),
    persistSnowLumaEndpoint: () => ({ updated: false, changed: {} }),
    persistToken: () => ({ updated: false, from: '', to: '' }),
    // 分级：bridge.js 的核层巩固用 ruleTags 判断「这条日记里有没有承诺/边界」。
    ruleTags: diaryGrade.ruleTags,
    // 桥接的出图出口会调归一化（体积/动图抽帧）：VM 里必须能拿到这几个函数。
    // 免打扰时段：bridge.js 顶层 import 了这几个纯函数（主动冒泡排期要用），
    // VM 里没有 import 机制，必须显式注入，否则走到 scheduleProactiveCheckV2 就 ReferenceError。
    matchQuietRange: quietHours.matchQuietRange,
    quietMillisLeft: quietHours.quietMillisLeft,
    normalizeQuietRanges: quietHours.normalizeQuietRanges,
    parseClockMinutes: quietHours.parseClockMinutes,
    formatClockMinutes: quietHours.formatClockMinutes,
    // 同上：作息/关系/生活这几段在唤醒 prompt 里，主动机会排期还要用 proactiveFactor。
    buildInnerLifeLines: innerLife.buildInnerLifeLines,
    proactiveFactor: innerLife.proactiveFactor,
    tickLife: innerLife.tickLife,
    // 语气锚点（2026-11-03 新增）：顶层常量，漏注入则整段唤醒 prompt 构建失败。
    // 纯字符串常量，无外部副作用，直接接真实现。
    // （关系记忆与独白检测的注入见上方 520-538 行，那两组已经在了，不要重复绑。）
    TONE_ANCHOR: toneAnchor.TONE_ANCHOR,
    normalizeImageForModel: mediaNormalize.normalizeImageForModel,
    sniffImage: mediaNormalize.sniffImage,
    planNormalization: mediaNormalize.planNormalization,
    planAnimation: mediaNormalize.planAnimation,
    // 向量召回：bridge.js 顶层是**别名**导入（`setLogger as setVectorLogger`、
    // `configure as configureVector` …）。所以这里必须按别名逐个绑定，不能展开：
    // 展开注入的是 setLogger / configure / status 这些通用名，既对不上 bridge.js
    // 里真正调用的名字，又容易和 context 里已有名字撞车。
    // 漏注入的后果：bridge.js 顶层的 setVectorLogger(log) 直接 ReferenceError，
    // 于是所有走 bridgeHarness 的用例一起变红，而堆栈指向本文件 ——
    // 看着像被测逻辑坏了，实际只是这里少绑了几个名字（同一类坑见上面 ownerMemory /
    // memoryDecay / diaryCore 的注释）。
    //
    // ⚠️ 这里**必须打桩，绝不能接真实现**：vector-recall 是在真实 realm 里被
    // import 的，不在 vm context 内，所以本文件注入的 `fetch: fakeFetch` 对它无效。
    // 接真实现时它会对 127.0.0.1:9870 发**真请求**，而 /rebuild 是**全量重建**
    // （vec_server.py 先清空再填）—— 任何带日记夹具的用例跑一次，就会把开发者本机
    // 真实的向量索引整体覆盖成几条测试数据，而且完全静默。
    // 所以：只保留纯内存的 setLogger/status，其余桩掉；默认当作服务不可用，
    // bridge 于是走「服务未就绪」分支，压根不会去 sync。
    // 需要验证向量逻辑的用例，用 globals 传桩覆盖（同 processAudioVolume 的约定）。
    setVectorLogger: vectorRecall.setLogger,
    vectorStatus: vectorRecall.status,
    configureVector: () => {},
    vectorAvailable: async () => false,
    syncVectorIndex: async () => ({ ok: false, reason: 'stub' }),
    vectorHybridSearch: async () => null,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData, describeAge }; })());`, context);

  // ★ 自检：bridge.js 顶层 import 声明过的每个绑定，此刻在 context 里必须可解析。
  // 放在这里而不是更早，是因为 qq-model-view 的四个名字是上面这行 runInContext
  // 注入的（compactModelMessage / describeAge 就在 bridge.js 的 import 里）；
  // 放早了一律误报。放在 main() 求值之前，则能在「整个 VM 崩掉」之前给出
  // 一份点名到姓的清单，而不是让人对着 ReferenceError 猜。
  // 探针用 typeof，它**不会抛**：未声明时返回字符串 'undefined'，因此这里的
  // 判断是「名字能否解析」，不会因为某个绑定真实值是 undefined 而误报。
  assertAllImportBindingsBound({
    context,
    importStatements,
    bodyCode: stripCommentsAndStrings(source),
  });

  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
