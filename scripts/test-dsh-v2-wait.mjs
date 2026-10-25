// 二代等待逻辑的「实时」端到端测试：真建一个 qq-chat-v2 会话并向 DSH 提问，
// 断言 qq_wait_for_messages 出现在该 preset 的可用工具面里。需要 DSH 正在运行。
// （纯逻辑单测见 scripts/test-v2-wait.mjs，两者不重复。）
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from '../src/dsh-client.js';
import { resolveDshBaseUrl, dshReachable } from './_test-dsh-base.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function main() {
  let auth;
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    auth = {
      token: cfg.dsh?.authToken || discoverDshLaunchToken(),
      header: cfg.dsh?.authHeader,
      prefix: cfg.dsh?.authPrefix
    };
  } catch {}
  // DSH 没起时明确跳过，不要以未捕获异常（ECONNREFUSED）退出——
  // 那种退出看起来像「测试失败」，实际只是服务没开。
  const base = resolveDshBaseUrl();
  if (!(await dshReachable(base))) {
    console.log(`SKIP DSH 不可达（${base}），实时端到端用例跳过。起 DSH 或用 DSH_BASE_URL 指定地址。`);
    process.exit(0);
  }
  const api = new NodeApiClient(base, undefined, auth);
  // 探测会话的 cwd 用系统临时目录：state/ 的 ACL 被 harden-state-acl.mjs 收紧过，
  // 沙箱里写不进去（见 scripts/probe-auth.mjs 的同款说明）。
  const cwd = path.join(os.tmpdir(), 'qq-bridge-self-test-v2-wait');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd, agentPreset: 'qq-chat-v2' }), 'session.create');
  const sessionId = created.sessionId;
  console.log('SESSION_CREATED', sessionId);

  // 必须复刻 bridge 的调用顺序：建会话 → selectModel → prompt。
  // bridge 的 ensureChatModel()（src/bridge.js）在每条会话首次发言前都会显式
  // selectModel(cfg.dsh.provider / cfg.dsh.model / cfg.dsh.reasoningEffort)；
  // 少了这一步，会话会落回 DSH 全局默认 provider（deepseek-official），
  // 而那个 key 已失效（401），于是本测试拿到空文本——这是测试的建模缺陷，
  // 不是「DSH 挂了」，更不该据此去改凭据。详见进度台账第八节。
  const provider = cfg?.dsh?.provider;
  const model = cfg?.dsh?.model;
  if (provider && model) {
    try {
      const sel = unwrap(await api.sessions.selectModel({
        sessionId,
        provider,
        model,
        reasoningEffort: cfg?.dsh?.reasoningEffort
      }), 'session.selectModel');
      console.log('MODEL_SELECTED', JSON.stringify(sel.selected));
    } catch (error) {
      console.error('❌ selectModel 失败（bridge 同样的调用会失败）：' + (error?.message ?? error));
      process.exit(1);
    }
  } else {
    console.log('WARN config.json 未配置 dsh.provider/model，跳过 selectModel，将用 DSH 全局默认模型');
  }

  const stream = api.events.mux({});
  const collector = createTurnCollector();
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待回复超时（120s）')), 120_000);
    (async () => {
      for await (const envelope of stream) {
        const frame = envelope.payload;
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          const ended = collector.push(frame.event);
          if (ended) {
            clearTimeout(timer);
            resolve(ended);
            return;
          }
        }
        if (frame.type === 'stream/error') {
          clearTimeout(timer);
          reject(new Error('事件流错误: ' + JSON.stringify(frame.error)));
          return;
        }
      }
    })().catch((error) => { clearTimeout(timer); reject(error); });
  });

  stream.follow(sessionId);
  const accepted = unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '请只输出你当前可用的工具名列表（JSON 数组），不要调用任何工具，不要发送消息。只输出 JSON。' }] }), 'session.prompt');
  console.log('PROMPT_ACCEPTED', JSON.stringify(accepted).slice(0, 120));
  const ended = await done;
  const text = ended.text || '';
  console.log('TOOLS_TEXT_START');
  console.log(text.slice(0, 3000));
  console.log('TOOLS_TEXT_END');
  const hasWait = text.includes('qq_wait_for_messages');
  console.log('HAS_qq_wait_for_messages=' + hasWait);

  // 空文本 ≠ 工具没注册。这两件事过去被混成同一句「未看到 qq_wait_for_messages」，
  // 害人去查工具装配，实际是模型侧没吐字（上游中转站分组关闭时就是 403 + 空文本）。
  // 现在分开报，把排查方向指对。
  if (!text.trim()) {
    console.log('RESULT=INCONCLUSIVE_EMPTY_MODEL_REPLY');
    console.error(
      '⚠️ 模型返回空文本，无法据此判断工具面（不是工具没注册）。\n' +
      '   常见原因：上游 provider 报错/分组关闭、鉴权失效、模型选择失败。\n' +
      '   请先看 bridge.log 里同一时段的模型错误，再来跑本测试。\n' +
      '   本用例的真实断言是「工具面含 qq_wait_for_messages」，空文本时它没有被验证 —— ' +
      '按仓库规矩（跳过不等于通过）判红，但红因是模型侧重试，不是代码缺陷。'
    );
    process.exit(1);
  }

  console.log('RESULT=' + (hasWait ? 'WAIT_TOOL_VISIBLE' : 'CHECK_FAILED'));
  // 这个测试原来只打印 CHECK_FAILED 却仍然 exit 0，于是任何用退出码判断的
  // 回归入口（run-all-tests / CI）都会把它记成「通过」——假绿灯。
  if (!hasWait) {
    console.error('❌ 模型确实回了 ' + text.length + ' 字，但其中没有 qq_wait_for_messages。');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
