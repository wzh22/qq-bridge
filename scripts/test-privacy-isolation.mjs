import fs from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * 隐私隔离测试。不依赖正在运行的 bridge —— 直接对函数和解码后的源码做断言，
 * 这样即使 bridge 没起也能验证逻辑正确。
 */
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); fail++; }
};

console.log('=== 1. 会话类型判定 ===');
const src = fs.readFileSync('E:/dsh/qq-bridge/src/bridge.js', 'utf8');

// 抽出 isOwnerPrivateSession 的实现做真实求值
const fnMatch = src.match(/function isOwnerPrivateSession\(key\) \{[\s\S]*?\n  \}/);
ok('函数存在', Boolean(fnMatch), fnMatch ? '' : '没找到');
if (fnMatch) {
  const ownerQQ = '2409281798';
  const cfg = { ownerQQ };
  const factory = new Function('cfg', `${fnMatch[0]}; return isOwnerPrivateSession;`);
  const isOwnerPrivate = factory(cfg);

  ok('主人私聊 → true',  isOwnerPrivate(`private:${ownerQQ}`) === true);
  ok('别人私聊 → false', isOwnerPrivate('private:123456') === false);
  ok('群聊 → false',      isOwnerPrivate('group:123456789') === false);
  ok('群聊(含主人QQ) → false', isOwnerPrivate('group:2409281798') === false);
  ok('空 key → false',    isOwnerPrivate('') === false);
  ok('异常 key → false',  isOwnerPrivate('private:') === false);
}

console.log('\n=== 2. 注入侧：群聊不含主人记忆 ===');
// 断言「签名里解构出了 key」，而不是把整串 `{ key = '' } = {}` 写死。
// 原写法在给这个函数加参数（后来加了 query）时会误报「签名未改」——
// 但真正要守的契约只有一条：注入侧必须拿得到会话 key，否则就没法区分群聊/私聊。
// 参数有几个、叫什么名字，都不是这个测试该管的事。
const withCtx = src.match(/function withSlangContext\(\s*promptText\s*,\s*\{([^}]*)\}\s*=\s*\{\}\s*\)\s*\{[\s\S]*?\n  \}/);
ok('withSlangContext 已解构出 key', Boolean(withCtx) && /\bkey\b/.test(withCtx[1]),
  withCtx ? `解构参数：${withCtx[1].trim()}` : '签名未改');
ok('注入条件含 isOwnerPrivateSession', /ownerMemoryEnabled\(\)\s*&&\s*isOwnerPrivateSession\(key\)/.test(src));
// 无参调用 = key 恒为 ''，会让「私聊才注入主人记忆」的闸门永远关着（隐私不会泄露，
// 但功能静默失效）。要拦的是这种退化，而不是「必须只有一个参数」。
const callSites = [...src.matchAll(/withSlangContext\(\s*promptText\s*\)/g)].length;
ok('无遗留的不传 key 调用', callSites === 0, `还有 ${callSites} 处`);

console.log('\n=== 3. 服务端：owner-memory 有会话类型闸门 ===');
const ep = src.indexOf("url.pathname === '/api/socialV2/owner-memory'");
const epBody = src.slice(ep, ep + 1800);
ok('接口存在', ep > 0);
ok('含 isOwnerPrivateSession 拒绝', /isOwnerPrivateSession\(key\)/.test(epBody));
ok('先鉴权后隐私（顺序正确）',
   epBody.indexOf('agentTokenOk') < epBody.indexOf('isOwnerPrivateSession'));

console.log('\n=== 4. 工具层：群聊直接拒绝 ===');
const mcp = fs.readFileSync('E:/dsh/qq-bridge/src/mcp-snowluma-safe.js', 'utf8');
const toolIdx = mcp.indexOf("'qq_owner_memory'");
const toolBody = mcp.slice(toolIdx, toolIdx + 1800);
ok('工具描述已标注仅限私聊', /仅限主人本人的私聊/.test(toolBody));
ok('含 private: 正则拦截', /\^private:\\d\+\$/.test(toolBody));
ok('拒绝时 isError: true', /isError:\s*true/.test(toolBody));

console.log('\n=== 5. 人格卡：隐私规则已注入且无真实信息 ===');
const { selectRoleText } = await import('file:///E:/dsh/qq-bridge/src/role-card.js');
const role = fs.readFileSync('E:/dsh/qq-bridge/roles/小鲸鱼.md', 'utf8');
const injected = selectRoleText(role, 'v2');
ok('含隐私小节', injected.includes('隐私边界'));
const LEAK = ['2409281798', '西安未央', '陕西警察学院', '交通管理工程', '公安联考'];
const leaked = LEAK.filter(w => injected.includes(w));
ok('无真实隐私进注入', leaked.length === 0, leaked.join(','));

console.log('\n=== 6. 整理会话：他人日记必须与主人记忆物理分开 ===');
// 这是"草稿纸同一张"那类泄漏：文件分开了，但生成内容时上下文串了人。
// sessions.prompt 是往同一个 sessionId 排队，上下文累积 —— 共用会话等于共用上下文。
// 参数表不要钉死在「只有 key」：并发改动把签名扩成了 runDiaryWrite(key, opts = {})，
// 这条正则原本只认 runDiaryWrite(key)，于是测试红在「有没有这个函数」而不是隐私逻辑本身。
const diaryFn = src.match(/async function runDiaryWrite\(key[^)]*\) \{[\s\S]*?\n  \}/);
ok('runDiaryWrite 存在', Boolean(diaryFn), diaryFn ? '' : '没找到');
if (diaryFn) {
  ok('按归属选会话（含三元分支）',
    /forOwner\s*\?\s*await ensureOwnerLearnerSession\(\)\s*:\s*await ensureDiaryOthersSession\(\)/.test(diaryFn[0]),
    '必须先算 forOwner 再分派');
  ok('不再无条件共用主人学习会话',
    !/sessionId\s*=\s*await ensureOwnerLearnerSession\(\);/.test(diaryFn[0]),
    '又退回共用了');
  ok('出错时只作废对应且仍为当前的那条',
    /if \(forOwner\) invalidateOwnerLearnerSession\(sessionId\); else diaryOthersSessionId = null;/.test(diaryFn[0]),
    '旧任务失败时不能误清另一条队列刚创建的新会话');
}

const othersFn = src.match(/async function ensureDiaryOthersSession\(\) \{[\s\S]*?\n  \}/);
ok('ensureDiaryOthersSession 存在', Boolean(othersFn), othersFn ? '' : '没找到');
if (othersFn) {
  ok('独立句柄 diaryOthersSessionId', /diaryOthersSessionId\s*=\s*value\.sessionId/.test(othersFn[0]));
  ok('独立工作区 diary-others-agent', /'diary-others-agent'/.test(othersFn[0]));
  ok('preset 走 strict 校验（fail-closed）',
    /resolvePresetName\([\s\S]*?strict:\s*true\s*\}/.test(othersFn[0]),
    '群聊/陌生人会话不能回退到含本地工具的默认 preset');
  ok('创建后设置模型', /ensureChatModel\(diaryOthersSessionId\)/.test(othersFn[0]));
}
ok('主人记忆会话不再被日记复用为唯一入口',
  !/diaryOthersSessionId\s*=\s*ownerLearnerSessionId/.test(src),
  '两者不能是同一个 id');

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
