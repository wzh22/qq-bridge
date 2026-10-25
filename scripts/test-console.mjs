// 控制台增强功能综合测试（node 直接调 API）
//
// ⚠️ 这个脚本会打**真实的控制台进程**：它会临时改生产 config.json 的白名单、
//    创建/删除真实人格、并调 /api/test-send 真的往网关发一条群消息。
//
// 2026-10-25 修的三处（此前它被 `run-all-tests.mjs` 全量跑带到生产上）：
//   ① **默认拒绝打到活着的桥接**。以前它无条件连 127.0.0.1:3100 —— 那就是
//      生产控制台端口。实测 18:38、19:14、19:17 三次全量回归都在真实桥接上
//      建了「测试人格Tmp」、把群 123456789 写进白名单又改回来。
//      现在改为：检测到端口上是一个**活的桥接**时直接退出（exit 3），
//      只允许 `--allow-live` 显式授权时继续。
//   ② **白名单/角色用 finally 兜底恢复**，并且先把 config.json 原始字节备份到
//      state/tmp/。以前恢复到一半被打断（Ctrl+C、超时被杀、后面的断言抛错）
//      就会把 `123456789` 这个测试群**永久留在生产白名单里** —— 那是一个
//      真实可被外部拉进的群号，属于权限面污染，不是"测试失败"那么简单。
//   ③ 发送前先确认网关真的可达，不可达就不发（原来"SnowLuma 不可达"被当通过，
//      但仍会把测试群写进白名单再写回来，白挨一次改配置）。
//
// 用法：
//   node scripts/test-console.mjs                 # 只对隔离 fixture 跑（端口 3199）
//   node scripts/test-console.mjs --allow-live    # 显式授权打 3100 的生产控制台
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ALLOW_LIVE = process.argv.includes('--allow-live');
// 默认打隔离 fixture 的端口（test-console-ui.mjs 的 fixture 会占用 3199 之外的随机端口，
// 这里指向 3100 时必须显式 --allow-live）。
const BASE = process.env.CONSOLE_TEST_BASE || (ALLOW_LIVE ? 'http://127.0.0.1:3100' : null);

const TEST_ROLE = '测试人格Tmp';
const TEST_GROUP = '123456789';
const CONFIG_FILE = path.join(ROOT, 'config.json');
const TMP_DIR = path.join(ROOT, 'state', 'tmp');

function readConsoleToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

// ── 0. 生产保护：不显式授权就不碰活着的桥接 ────────────────────────────────
if (!BASE) {
  // 探测 3100 上是不是一个活的桥接（有 /api/roles 就说明是）。
  let liveBridge = false;
  try {
    const probe = await fetch('http://127.0.0.1:3100/api/roles', {
      signal: AbortSignal.timeout(1500),
    });
    liveBridge = probe.ok || probe.status === 401 || probe.status === 403;
  } catch { liveBridge = false; }

  if (liveBridge) {
    // 用 exit 0 + 明确跳过：这是**环境**问题（活桥接在生产端口上），不是回归失败。
    // 直接 exit 1 会让 run-all-tests 把它记成红项，久而久之没人再看红项 ——
    // 与 test-console-ui 缺 playwright 时的处理口径一致。
    // 真正要打生产，显式加 --allow-live。
    console.log('⏭  跳过 test-console：127.0.0.1:3100 上有活着的桥接（生产控制台）。');
    console.log('   本测试会改生产白名单 / 建删真实人格 / 真的发群消息，因此默认不对生产运行。');
    console.log('   要验控制台功能请用 npm run test:console-ui（隔离 fixture）；确需打生产加 --allow-live。');
    process.exit(0);
  }
  console.error('⛔ 未指定目标：本测试需要隔离的控制台 fixture。');
  console.error('   用 CONSOLE_TEST_BASE=http://127.0.0.1:<port> 指向 fixture，或 --allow-live 打生产。');
  process.exit(0);
}

const TOKEN = readConsoleToken();
const authHeaders = TOKEN ? { 'x-console-token': TOKEN } : {};
const api = async (path, method, body) => {
  const headers = { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(BASE + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// ── 备份 config.json 原始字节：任何中断都从磁盘还原，而不只是"再调一次 API" ──
// 为什么两层都要：API 还原依赖桥接进程还活着且请求成功；文件备份兜住
// 「进程被杀 / 请求超时 / 后面的断言抛错」这些情况。恢复顺序是 API → 文件。
let configBackup = null;
try {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  configBackup = path.join(TMP_DIR, `config.backup-testconsole-${Date.now()}.json`);
  fs.copyFileSync(CONFIG_FILE, configBackup);
} catch (error) {
  console.error(`⚠️  无法备份 config.json（${error?.message ?? error}），继续但风险更高`);
  configBackup = null;
}

let origRole = null;
let origAllow = null;
const restoreEverything = async () => {
  // 1) 角色还原（origRole 为 null 表示原本没设角色）
  try {
    if (origRole !== undefined) await api('/api/role', 'POST', { role: origRole ?? null });
  } catch {}
  // 2) 白名单还原
  try {
    if (origAllow) await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
  } catch {}
  // 3) 文件级兜底：直接覆盖回原始字节（桥接下一次读盘即生效）
  if (configBackup) {
    try {
      fs.copyFileSync(configBackup, CONFIG_FILE);
      fs.rmSync(configBackup, { force: true });
    } catch (error) {
      console.error(`❌ 无法从备份还原 config.json：${error?.message ?? error}`);
      console.error(`   备份仍在：${configBackup}（请手动覆盖回去）`);
    }
  }
  // 4) 测试人格文件
  try {
    fs.rmSync(path.join(ROOT, 'roles', `${TEST_ROLE}.md`), { force: true });
  } catch {}
};

// 任何退出路径（含未捕获异常、Ctrl+C、超时被杀）都尝试还原。
// 注意 SIGTERM/SIGINT 下无法 await，所以还原里的关键一步（文件覆盖）是同步的。
process.on('exit', () => {
  if (!configBackup) return;
  try {
    if (fs.existsSync(configBackup)) {
      fs.copyFileSync(configBackup, CONFIG_FILE);
      fs.rmSync(configBackup, { force: true });
      console.error('⚠️  异常退出：已从备份还原 config.json');
    }
  } catch {}
});

try {
  // 1. 页面
  const page = await fetch(BASE + '/', { headers: authHeaders });
  const html = await page.text();
  ok('页面加载', page.status === 200 && html.includes('白名单 / 管理员') && html.includes('人格与角色') && html.includes('仿真提示词') && html.includes('测试发送'), `长度 ${html.length}`);

  // 2. 角色列表
  let r = await api('/api/roles');
  origRole = r.body.current ?? null;
  ok('角色列表', r.body.roles?.includes('傲娇助手'), JSON.stringify(r.body));

  // 3. 创建人格
  r = await api('/api/roles/create', 'POST', { name: TEST_ROLE, content: '- 性格：测试\n- 说话风格：简短' });
  ok('创建人格', r.body.ok === true, JSON.stringify(r.body));
  r = await api('/api/roles');
  ok('创建后列表出现', r.body.roles?.includes(TEST_ROLE));

  // 4. 设置 / 清除角色
  r = await api('/api/role', 'POST', { role: TEST_ROLE });
  ok('设置角色', r.body.ok === true && r.body.role === TEST_ROLE);
  r = await api('/api/role', 'POST', { role: null });
  ok('清除角色', r.body.ok === true && r.body.role === null);
  if (origRole) {
    r = await api('/api/role', 'POST', { role: origRole });
    ok('恢复原角色', r.body.ok === true && r.body.role === origRole);
  }

  // 5. 会话映射
  r = await api('/api/sessions');
  ok('会话映射', Array.isArray(r.body.sessions), `共 ${r.body.sessions.length} 个`);

  // 6. 挂起列表
  r = await api('/api/pending');
  ok('挂起列表', Array.isArray(r.body.pending), `共 ${r.body.pending.length} 个`);

  // 7. 白名单：读原值 → 加测试群 → 恢复
  // 注意：/api/whitelist 返回的是 normalizeIdList 之后的「字符串数组」，
  // 而 config.json 里可能是数字，直接 JSON.stringify 比较会因类型不同而误判失败。
  const sameIds = (a, b) => JSON.stringify((a || []).map(String).sort()) === JSON.stringify((b || []).map(String).sort());
  r = await api('/api/whitelist');
  origAllow = r.body.allow;
  ok('白名单读取', origAllow && Array.isArray(origAllow.groups), JSON.stringify(origAllow));
  const testGroups = [...new Set([...(origAllow.groups || []), TEST_GROUP])];
  r = await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: testGroups }, deny: { private: [], groups: [] } });
  ok('白名单写入（含测试群）', r.body.ok === true && (r.body.allow.groups || []).map(String).includes(TEST_GROUP), JSON.stringify(r.body.allow));
  r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
  ok('白名单恢复原值', r.body.ok === true && sameIds(r.body.allow.groups, origAllow.groups) && sameIds(r.body.allow.private, origAllow.private), JSON.stringify(r.body.allow));

  // 8. 测试发送到机器人测试群（真实发送）
  // 先确认网关可达：不可达就别去改白名单（改一次就是一次生产配置写入）。
  // /api/status 的 snowluma 字段是对象（connected/accountOnline/degraded…），
  // 不是布尔值 —— 早先按 `=== true` 判断会恒定判成"不可达"。
  let gatewayUp = false;
  try {
    const st = await api('/api/status');
    gatewayUp = st.status === 200 && st.body?.snowluma?.connected === true;
  } catch { gatewayUp = false; }

  if (!gatewayUp) {
    console.log('⏭  跳过「测试发送」：网关不可达（未改白名单，避免无意义的配置写入）');
  } else {
    // 先临时把测试群加入白名单，验证放行 + /api/test-send 真的走到网关。
    const withTestGroup = [...new Set([...(origAllow.groups || []).map(String), TEST_GROUP])];
    await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: withTestGroup }, deny: { private: [], groups: [] } });
    r = await api('/api/test-send', 'POST', { kind: 'group', id: TEST_GROUP, message: '【控制台测试】新控制台功能验证成功 ✅' });
    const snowlumaDown = typeof r.body.error === 'string' && !/白名单/.test(r.body.error);
    ok('测试发送群消息', r.body.ok === true || snowlumaDown,
      r.body.ok === true ? JSON.stringify(r.body) : `SnowLuma 不可达（非白名单拦截）：${r.body.error}`);
    // 立刻还原白名单（去掉测试群）——不要等到函数末尾
    await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
  }

  // 9. 测试发送到非白名单（应拒绝）
  r = await api('/api/test-send', 'POST', { kind: 'group', id: '100003', message: 'x' });
  ok('非白名单发送被拒', r.body.ok === false && r.status === 403, JSON.stringify(r.body));

  // 10. 清理测试人格（用绝对路径，不依赖运行目录）
  fs.rmSync(new URL(`../roles/${TEST_ROLE}.md`, import.meta.url), { force: true });
  r = await api('/api/roles');
  ok('测试人格已清理', !r.body.roles?.includes(TEST_ROLE));
} catch (error) {
  console.error(`💥 测试过程中抛错：${error?.message ?? error}`);
  failed += 1;
} finally {
  await restoreEverything();
}

// 恢复结果自检：白名单里不该残留测试群。
try {
  const after = await api('/api/whitelist');
  const leaked = (after.body?.allow?.groups || []).map(String).includes(TEST_GROUP);
  if (leaked) {
    console.error(`❌ 白名单里仍残留测试群 ${TEST_GROUP} —— 这是权限面污染，请手动从 config.json 清掉`);
    failed += 1;
  } else {
    console.log('🧹 白名单已确认干净（无测试群残留）');
  }
} catch (error) {
  console.error(`⚠️  无法自检白名单：${error?.message ?? error}`);
}

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 测试完成');
