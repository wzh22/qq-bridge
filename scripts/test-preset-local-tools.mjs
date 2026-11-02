// 铁律 L7 的注册期断言：仿真会话的 preset **不得包含本地执行能力**。
//
// 为什么必须有这个文件
// --------------------
// `QSH_PLAN.md` §0.1 的结论是：QQ 动作闸门全部跑在桥接进程内，而 OneBot 的
// 127.0.0.1:3000 HTTP 接口可被任何本机进程用 Bearer token 直接调用。因此
// **"仿真会话拿不到 shell"是整个分层安全模型唯一的真边界**。
//
// 但在此之前没有任何断言检查过这件事：
//   · `test-audit-setup-guards.mjs` 把工具名**喂**给 guard，验证它拒绝——这证明
//     guard 逻辑对，**不证明本地工具已从工具清单里隐藏**；
//   · `probe-tools.mjs` 只断言"模型某一轮没有调用本地工具"——**没调用 ≠ 不在清单里**。
//
// 本测试补上注册期那一半：从**真实 preset 文件**里解析出 preset 组成，断言
// 工具守卫被挂载，并且守卫的 restrict 名单覆盖每一个已知本地执行工具。
// 它不依赖运行中的 DSH，因此可以进 `npm run test:audit`，每次回归都跑。
//
// 口径说明：这里断言的是"preset 声明会隐藏/拒绝这些名字"。真正的端到端断言
// （注册出来的清单里确实没有）需要活的 DSH，属 `probe-tools.mjs` 的范畴。

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { collectDshToolNames as collectDshToolNamesShared, isProfilePackageInstalled } from './dsh-tool-names.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRESETS_DIR = path.join(ROOT, 'dsh', 'agent-presets');

/** 仿真模式使用的 preset（不允许有任何本地执行能力）。 */
const SIMULATION_PRESETS = ['qq-chat', 'qq-chat-v2'];

/** 封闭 agent 的 preset：按设计**允许**完整本地工具面。 */
const CLOSED_AGENT_PRESETS = ['qsh-closed'];

/**
 * 本地执行能力清单。
 *
 * ⚠️ 这里**必须**含每一个能执行本地命令、读写本地文件或派生 agent 的工具名。
 * 名字取自 DSH 0.1.7-rc.2 实际注册的工具（见 qq-tool-restrict.mjs 的注释）。
 * 2026-09-27 的对账替换：`cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop`
 * 在 0.1.7 里已不存在（dsh-tool-cordis 现在只注册 cordis_inspect_list/query），
 * 同一轮补上 `load_workspace_dependencies`（自带 Python/Node/pnpm 路径）与
 * `list_subagent_models`（派生 agent 家族）。
 *
 * 两类失败模式，本文件都要防：
 *   ① **漏**（本地工具不在守卫名单里 ⇒ 留在 schema）——由 test 3 对账 RESTRICTED_TOOL_NAMES 防；
 *   ② **拼错假名**（名字根本不存在 ⇒ `tools.restrict` 抛错被吞 ⇒ 静默失效）——
 *      由 test 6 用「假 restrict 会对未知名字抛错」来防。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（用 `scripts/scan-dsh-tool-names.mjs`
 * 从安装包里抽真实工具名双向求差）。旧名字全部还在（0 假名），新增 13 个危险语义名字：
 *   · 全局层默认启用、仿真会话真的会继承的三个 MCP 资源工具
 *     （`dsh-base` 的 `mcp-resources` 行没被 disabled）；
 *   · 派生 agent / 执行外部代码：subagent_codex / subagent_claude_code /
 *     spawn_teammate / team_task_*（现只在 DSH 自带 preset 里挂，列进来当回归网）；
 *   · plugin_manager（插件装载权 = 任意代码执行）；
 *   · schedule_*（无人值守的自我调度）。
 */
const LOCAL_EXECUTION_TOOLS = [
  'pwsh', 'bash',
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  'glob', 'grep',
  'load_workspace_dependencies',
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  'cordis_inspect_list', 'cordis_inspect_query',
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
  // 0.2.0 新增对账
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'plugin_manager',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 0.2.1 新增对账（2026-10-22）：working_directory 由 dsh-base 默认挂载（全局层继承），
  // terminal 一族 = shell，session_* 能跨会话读事件正文，plugin_market = 装载权。
  'working_directory',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  'plugin_market', 'create_worktree', 'wait_agent',
  // 按需安装的可选组合包才注册的名字：0.2.1 起默认不存在，但一旦装上就要挡，
  // 所以仍在名单里；对账时按「可选项」处理（见下方 OPTIONAL_BUNDLE_TOOLS）。
  'subagent_codex', 'subagent_claude_code',
];

/** 0.2.1 起 Codex / Claude Code 改为按需安装：这组名字默认扫不到，不算拼错假名。 */
const OPTIONAL_BUNDLE_TOOLS = new Set([
  'subagent_codex', 'subagent_claude_code',
  // dsh-plugin-guard（QQ 的 web profile bundle）**当前没装**，它注册的
  // dsh_snapshot / dsh_rollback / incident_resolved 就扫不到。
  // 但这三个名字必须留在守卫名单里：plugin-guard 会改写 package.json/lockfile
  // 并 spawn pnpm，属于本地执行面。删掉才是真危险——哪天装上了就静默放行。
  // 所以按「可选装包」处理，而不是当假名清掉。
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
]);

/**
 * 第三方插件注册的全局工具 → **所属插件包名**（2026-10-25 对账）。
 *
 * 这组名字来自 profile 的 `node_modules`，不是 `@deepseek-ai/*` 官方包。
 * 它们必须留在守卫名单里（真的会进仿真会话 schema），但判定「名字是否真实存在」
 * 的方式和官方包不同 —— 所以这里登记来源包，而不是像旧版那样给一个整体豁免集合。
 *
 * 为什么要登记来源包（这是本文件最重要的教训）：
 *   旧版写的是 `THIRD_PARTY_PLUGIN_TOOLS` 豁免集合，命中就跳过真实性校验。
 *   它看起来让套件变绿，实际把**两种失败模式都藏起来了** —— 扫描器一旦退化
 *   回「只扫 @deepseek-ai」，这 62 个名字统统逃过校验，而 2026-10-25 的真实
 *   故障正是扫描器看不见 4 个真实存在的名字（read_url / univer_status /
 *   context_lens_code / context_lens_log），差点被当成假名删掉。
 *   现在改判「所属插件**装没装**」：
 *     · 装了   ⇒ 名字必须被扫描器扫到，扫不到 = 扫描器退化或插件损坏，**报红**；
 *     · 没装   ⇒ 允许缺席（守卫仍保留名字，装上即生效，fail-closed）。
 *   这样扫描器的覆盖能力本身被钉住了，而不是被豁免绕过。
 */
const THIRD_PARTY_TOOL_OWNER = new Map(Object.entries({
  // dsh-plugin-tool-management：派生 agent / 改宿主配置 / 持久记忆
  subagent_manager_save: 'dsh-plugin-tool-management',
  subagent_manager_switch: 'dsh-plugin-tool-management',
  mcp_manager_list: 'dsh-plugin-tool-management',
  mcp_manager_save: 'dsh-plugin-tool-management',
  mcp_manager_switch: 'dsh-plugin-tool-management',
  skill_manager_list: 'dsh-plugin-tool-management',
  skill_manager_read: 'dsh-plugin-tool-management',
  skill_manager_save: 'dsh-plugin-tool-management',
  skill_manager_switch: 'dsh-plugin-tool-management',
  prompt_manager_apply: 'dsh-plugin-tool-management',
  prompt_manager_list: 'dsh-plugin-tool-management',
  scene_manager_list: 'dsh-plugin-tool-management',
  scene_manager_save: 'dsh-plugin-tool-management',
  scene_manager_switch: 'dsh-plugin-tool-management',
  memory_manager_list: 'dsh-plugin-tool-management',
  memory_manager_read: 'dsh-plugin-tool-management',
  memory_manager_save: 'dsh-plugin-tool-management',
  memory_manager_switch: 'dsh-plugin-tool-management',
  // dsh-read-url：任意 URL ⇒ SSRF 面
  read_url: 'dsh-read-url',
  read_url_links: 'dsh-read-url',
  read_url_batch: 'dsh-read-url',
  read_url_site: 'dsh-read-url',
  // dsh-free-search：主动对外检索
  advanced_search: 'dsh-free-search',
  cache_search: 'dsh-free-search',
  domain_search: 'dsh-free-search',
  multi_search: 'dsh-free-search',
  platform_search: 'dsh-free-search',
  video_search: 'dsh-free-search',
  free_search_test: 'dsh-free-search',
  research: 'dsh-free-search',
  weather: 'dsh-free-search',
  // dsh-univer-office：整套 .univer 文档读写 + 导入导出
  univer_api: 'dsh-univer-office',
  univer_status: 'dsh-univer-office',
  univer_new: 'dsh-univer-office',
  univer_unit: 'dsh-univer-office',
  univer_worktree: 'dsh-univer-office',
  univer_inspect: 'dsh-univer-office',
  univer_lint: 'dsh-univer-office',
  univer_execute: 'dsh-univer-office',
  univer_import: 'dsh-univer-office',
  univer_export: 'dsh-univer-office',
  univer_print_pdf: 'dsh-univer-office',
  univer_screenshot: 'dsh-univer-office',
  univer_compile_svg: 'dsh-univer-office',
  univer_resources: 'dsh-univer-office',
  // @goodandready/dsh-time-machine：快照 + 回滚工作区（回滚 = 覆盖文件）
  time_machine_checkpoint_create: '@goodandready/dsh-time-machine',
  time_machine_checkpoint_list: '@goodandready/dsh-time-machine',
  time_machine_checkpoint_delete: '@goodandready/dsh-time-machine',
  time_machine_checkpoint_prune: '@goodandready/dsh-time-machine',
  time_machine_checkpoint_rollback: '@goodandready/dsh-time-machine',
  time_machine_diff: '@goodandready/dsh-time-machine',
  time_machine_file_rollback: '@goodandready/dsh-time-machine',
  // dsh-image-gen：花额度 / 可上传群里的图 / 画布
  generate_image: 'dsh-image-gen',
  generate_images: 'dsh-image-gen',
  edit_image: 'dsh-image-gen',
  canvas_state: 'dsh-image-gen',
  view_canvas: 'dsh-image-gen',
  find_inspiration: 'dsh-image-gen',
  // @goodandready/dsh-context-lens：只读但没必要
  context_lens_code: '@goodandready/dsh-context-lens',
  context_lens_log: '@goodandready/dsh-context-lens',
  // dsh-better-sidebar：宿主 UI 动作
  sidebar_open: 'dsh-better-sidebar',
}));

/**
 * 工具名 → 真实存在与否。抽取实现在 `scripts/dsh-tool-names.mjs`（唯一实现，
 * 与 `scan-dsh-tool-names.mjs` 共用），用来抓"拼错的假名"。
 *
 * 历史坑：本测试过去自带一份**模糊**抽取器（全文件乱扫 `name: 'x'` + 只认少数
 * 包名前缀 + 只读包根目录的 cordis.patch.yml）。0.2.0 对账时它把 10 个**真实存在**
 * 的工具名报成假名：`dsh-mcp-resources` / `dsh-experimental-tool-agent-team` 不匹配
 * 它的包名白名单，`subagent_codex` 写在 `dsh-web-app/presets/*.patch.yml` 而非包根。
 * 误判方向很危险——它会逼人把真名字从守卫名单里删掉，等于自己拆掉安全边界。
 * 现在只保留一条实现，两边不可能再漂移。
 */
function collectDshToolNames() {
  const { names } = collectDshToolNamesShared();
  return names.size === 0 ? null : new Set(names.keys());
}
/** 允许出现在名单里、但不属于"本地执行"语义的名字（开发/注入器）。 */
const DEV_TOOL_PREFIX = /^dev_/;

/** 允许出现的 MCP 命名空间前缀（QQ 动作面）。
 *
 * ⚠️ 用 DSH 实际注册的名字：MCP server 名 `snowluma-host` 里的连字符在工具名里
 * 会被规范化成下划线（`mcp__snowluma_host__*`）。旧版这里写的是连字符版本，
 * 于是这条断言在测一个根本不存在的工具名，线上真实调用反而被 guard 拒绝。
 */
const EXPECTED_SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma_host__',
  'mcp__web-search-safe__',
  'mcp__bilibili-safe__',
  'mcp__tieba-safe__',
];

function readPreset(id) {
  const dir = path.join(PRESETS_DIR, id);
  assert.ok(fs.existsSync(dir), `preset 目录存在：${id}`);
  const cordis = path.join(dir, 'agent.cordis.yml');
  assert.ok(fs.existsSync(cordis), `preset 有 agent.cordis.yml：${id}`);
  return { dir, yml: fs.readFileSync(cordis, 'utf8'), cordis };
}

// ---------------------------------------------------------------------------
test('模拟会话的 preset 都挂了工具守卫（否则 L7 没有任何载体）', () => {
  for (const id of SIMULATION_PRESETS) {
    const { yml } = readPreset(id);
    assert.match(
      yml,
      /qq-tool-restrict/,
      `${id} 必须挂载 qq-tool-restrict（L7 的落点），否则本地工具会随全局层继承进来`,
    );
    // 源文件里仍是 preset 目录内的相对名；DSH 0.1.7 下真正装进 DSH 的是 bundle patch
    // （scripts/build-agent-preset-patches.mjs 生成），那里会把它改写成从 profile 目录
    // 可解析的 `qq-agent-presets/qq-tool-restrict.mjs`——这条断言钉的是"源里必须有守卫行"，
    // 改写结果由 test-agent-preset-patches.mjs 钉住。
    assert.match(yml, /\.\/qq-tool-restrict\.mjs/, `${id} 的守卫要指向本目录的 .mjs`);
  }
});

test('模拟会话的 preset 不得挂载 tool-web 的 search/fetch', () => {
  for (const id of SIMULATION_PRESETS) {
    const { yml } = readPreset(id);
    const webRow = /id:\s*tool-web[\s\S]{0,200}/.exec(yml);
    assert.ok(webRow, `${id} 应有 tool-web 条目`);
    assert.match(webRow[0], /search:\s*false/, `${id}: tool-web.search 必须为 false`);
    assert.match(webRow[0], /fetch:\s*false/, `${id}: tool-web.fetch 必须为 false`);
  }
});

test('守卫的 restrict 名单覆盖每一个已知本地执行工具', async () => {
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const guardPath = path.join(dir, 'qq-tool-restrict.mjs');
    assert.ok(fs.existsSync(guardPath), `${id} 的守卫文件存在`);

    // 用假 tools 服务调用真实守卫，捕获它实际下发的 restrict 请求。
    const restricted = new Set();
    const fakeTools = {
      restrict({ deny }) { for (const n of deny ?? []) restricted.add(n); },
      guard(fn) { this._guard = fn; },
    };
    const mod = await import(pathToFileURL(guardPath).href);
    mod.apply({ tools: fakeTools });

    const violations = LOCAL_EXECUTION_TOOLS.filter((t) => !restricted.has(t));
    assert.deepEqual(
      violations, [],
      `${id}: 以下本地执行工具未出现在 restrict 名单里，会留在模型的工具清单中：`
      + `${violations.join(', ')}。注册期隐藏失败 ⇒ §5.2 的 L7 断言不成立。`,
    );

    // 执行期白名单也必须拒绝它们（restrict 与 guard 是两道，不能只靠一道）。
    assert.equal(typeof fakeTools._guard, 'function', `${id}: 守卫注册了执行期白名单`);
    for (const tool of LOCAL_EXECUTION_TOOLS) {
      const verdict = fakeTools._guard({ name: tool });
      assert.ok(
        typeof verdict === 'string' && verdict.length > 0,
        `${id}: 本地工具 "${tool}" 必须在执行期被拒绝，实际返回 ${JSON.stringify(verdict)}`,
      );
    }
  }
});

test('守卫导出的名单与本测试的清单一致（防两份名单各自漂移）', async () => {
  // 先前这个测试只是"复制"名单的前 19 个名字，导致守卫里多出的 7 个名字
  // 从来没被断言过。现在改为**导入**守卫自己导出的数组，两边不可能漂移。
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const mod = await import(pathToFileURL(path.join(dir, 'qq-tool-restrict.mjs')).href);
    assert.ok(
      Array.isArray(mod.RESTRICTED_TOOL_NAMES) && mod.RESTRICTED_TOOL_NAMES.length > 0,
      `${id}: 守卫必须导出 RESTRICTED_TOOL_NAMES，供测试对账`,
    );
    const missing = LOCAL_EXECUTION_TOOLS.filter((t) => !mod.RESTRICTED_TOOL_NAMES.includes(t));
    assert.deepEqual(missing, [],
      `${id}: 守卫导出的名单缺少本地执行工具：${missing.join(', ')}`);
    // 反向：名单里不该混入"允许的无害工具"。
    for (const allowed of ['ask_user_question', 'todo_write']) {
      assert.ok(!mod.RESTRICTED_TOOL_NAMES.includes(allowed),
        `${id}: ${allowed} 是无害模型侧工具，不应出现在 restrict 名单里（会与 SAFE_EXACT 自相矛盾）`);
    }
  }
});

test('守卫名单里的每个名字都是 DSH 真实注册的工具（防拼错假名静默失效）', async () => {
  // 为什么必须测：`tools.restrict()` 对未知名字会**抛错**，而守卫逐个 try/catch
  // 只打日志 ⇒ 拼错的名字 = **静默 no-op**。这正是本名单初版的真实缺陷：
  // pwsh_persistent / bash_persistent / cordis / goal_write / goal_read 五个假名
  // 让整批限制悄悄少生效，而套件当时全绿。
  //
  // 三类名字，三种判据（区别很重要，混用会重演 2026-10-25 的误报）：
  //   ① 官方包（@deepseek-ai/*）    ⇒ 扫描器必须扫得到；
  //   ② 第三方插件工具              ⇒ **所属插件装了就**必须扫得到（见 THIRD_PARTY_TOOL_OWNER）；
  //   ③ dev_* / 可选 bundle          ⇒ 运行时才出现或本机没装，允许缺席。
  const dshNames = collectDshToolNames();
  if (dshNames === null) {
    console.log('  ⏭  跳过：未找到 DSH 工具包（设 DSH_TOOL_PACKAGES 指向 @deepseek-ai 目录即可启用）');
    return;
  }
  // 「插件装没装」必须**独立探测**，不能复用扫描器的遍历结果。
  // 复用会导致：扫描器退化 ⇒ 名字扫不到 + 判据认为没装 ⇒ 全部跳过 ⇒ 假绿。
  // 这条是实测出来的：给 dshProfilePackageDirs 塞 `return []` 后套件仍 fail 0。
  const ownerInstalled = (owner) => isProfilePackageInstalled(owner);

  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const mod = await import(pathToFileURL(path.join(dir, 'qq-tool-restrict.mjs')).href);

    const fabricated = [];
    const skippedBecauseUninstalled = [];
    for (const n of mod.RESTRICTED_TOOL_NAMES) {
      if (DEV_TOOL_PREFIX.test(n) || OPTIONAL_BUNDLE_TOOLS.has(n)) continue;
      if (dshNames.has(n)) continue;
      const owner = THIRD_PARTY_TOOL_OWNER.get(n);
      if (owner && !ownerInstalled(owner)) {
        // 插件没装 ⇒ 名字缺席是预期的（守卫保留名字 = 装上即生效）。
        skippedBecauseUninstalled.push(`${n}(${owner})`);
        continue;
      }
      fabricated.push(owner ? `${n}(来自 ${owner}，但没被扫描到)` : n);
    }

    assert.deepEqual(fabricated, [],
      `${id}: 以下名字在 DSH 已安装的工具包里找不到 ⇒ restrict 会抛错并被吞掉，`
      + `限制静默失效：${fabricated.join(', ')}`);
    if (skippedBecauseUninstalled.length) {
      console.log(`  ℹ️  ${id}: ${skippedBecauseUninstalled.length} 个名字所属插件本机未装，`
        + `按 fail-closed 保留：${skippedBecauseUninstalled.join(', ')}`);
    }
  }
});

test('第三方插件工具的来源包名必须登记且自洽（防豁免表变成垃圾桶）', async () => {
  // 这条挡住的是「往里随手加名字」：豁免表一旦变成垃圾桶，
  // 「名字必须真实存在」的约束就在这批名字上永久失效了。
  for (const [tool, owner] of THIRD_PARTY_TOOL_OWNER) {
    assert.match(tool, /^[a-z][a-z0-9_]{1,40}$/, `登记的第三方工具名形态合法：${tool}`);
    assert.ok(owner && owner.length > 0, `${tool} 必须登记所属包名`);
    // 归属必须是具体包，不能是通配或空泛描述。
    assert.match(owner, /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9-]*$/,
      `${tool} 的所属包名要写成真实包名（可带 scope），实际是 ${owner}`);
    assert.ok(!DEV_TOOL_PREFIX.test(tool), `${tool}: dev_* 不该走第三方归属表`);
  }

  // 反向断言（这条才有牙齿）：守卫里被声明为「第三方插件工具」的每一个名字，
  // 都必须在归属表里有登记。否则它要么走官方包判据被判成假名报红，
  // 要么有人为了让它变绿直接塞进 OPTIONAL_BUNDLE_TOOLS —— 那才是真漏洞。
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const mod = await import(pathToFileURL(path.join(dir, 'qq-tool-restrict.mjs')).href);
    // 守卫若导出这段名单就逐一核对；未导出（老版本守卫）则显式跳过并说明。
    const declared = mod.THIRD_PARTY_PLUGIN_TOOL_NAMES;
    if (!Array.isArray(declared)) {
      console.log(`  ⏭  ${id}: 守卫未导出 THIRD_PARTY_PLUGIN_TOOL_NAMES，跳过反向核对`);
      continue;
    }
    const unregistered = declared.filter((n) => !THIRD_PARTY_TOOL_OWNER.has(n));
    assert.deepEqual(unregistered, [],
      `${id}: 守卫声明为第三方工具、但测试里没登记归属包的名字：${unregistered.join(', ')}。`
      + `请在 THIRD_PARTY_TOOL_OWNER 补上真实包名，不要塞进豁免。`);
    // 同时也防反向漂移：归属表里有、守卫里却没有 ⇒ 有人删了守卫条目。
    const missingInGuard = [...THIRD_PARTY_TOOL_OWNER.keys()].filter((n) => !declared.includes(n));
    assert.deepEqual(missingInGuard, [],
      `${id}: 归属表登记了但守卫没挡的名字：${missingInGuard.join(', ')}`);
  }
});

test('守卫仍放行 QQ MCP 命名空间与无害模型侧工具', async () => {
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const guardPath = path.join(dir, 'qq-tool-restrict.mjs');
    const fakeTools = { restrict() {}, guard(fn) { this._guard = fn; } };
    const mod = await import(pathToFileURL(guardPath).href);
    mod.apply({ tools: fakeTools });

    for (const prefix of EXPECTED_SAFE_PREFIXES) {
      assert.equal(
        fakeTools._guard({ name: `${prefix}some_tool` }), undefined,
        `${id}: MCP 前缀 ${prefix} 应放行`,
      );
    }
    for (const name of ['ask_user_question', 'todo_write']) {
      assert.equal(fakeTools._guard({ name }), undefined, `${id}: ${name} 应放行`);
    }
    // 未知工具名必须 fail-closed。
    for (const name of ['', null, undefined, 'mcp__unknown__x', 'totally_new_tool']) {
      assert.ok(
        typeof fakeTools._guard({ name }) === 'string',
        `${id}: 未知工具 ${JSON.stringify(name)} 必须被拒绝（fail-closed）`,
      );
    }
  }
});

test('封闭 agent 的预设在创建后必须与仿真 preset 明确区分', () => {
  // qsh-closed 由 ADR 0003 定义为**故意**拥有完整本地工具面：它的守卫只负责
  // "哪些 QQ 动作可见"，不负责"本地工具权限边界"。
  //
  // ⚠️ 这条断言初版是**恒真**的：qsh-closed 还不存在，`if (!exists) continue`
  // 直接跳过整个函数体，永远不会失败——一个永远不会失败的测试不如没有。
  // 现在改为显式记录"尚未创建"，并且一旦创建就执行真实断言。
  const present = CLOSED_AGENT_PRESETS.filter((id) => fs.existsSync(path.join(PRESETS_DIR, id)));
  if (present.length === 0) {
    // 不是失败，但必须让人看见"这条闸门还没被真正覆盖"。
    console.log('  ⏭  qsh-closed 尚未创建（ADR 0003 待落地）；此项覆盖暂为空，不是通过。');
    return;
  }
  for (const id of present) {
    const yml = fs.readFileSync(path.join(PRESETS_DIR, id, 'agent.cordis.yml'), 'utf8');
    assert.match(yml, /qq-tool-restrict/, `${id} 也应挂守卫（用于 QQ 动作可见性）`);
    // 与仿真 preset 的关键区别：封闭 agent 必须能拿到本地工具 ⇒
    // 它的守卫不得把本地执行工具写进 restrict 名单。
    const guard = fs.readFileSync(path.join(PRESETS_DIR, id, 'qq-tool-restrict.mjs'), 'utf8');
    for (const tool of ['pwsh', 'read', 'write']) {
      assert.ok(
        !new RegExp(`['"]${tool}['"]`).test(guard),
        `${id}: 封闭 agent 需要本地工具，守卫不应把 "${tool}" 列入 restrict`,
      );
    }
  }
});
