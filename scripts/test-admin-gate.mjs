// 权限分级测试：非管理员不能指挥 bot 做管理员才能做的事。
//
// 背景：白名单只回答「能不能和 bot 说话」。之前所有 v2 工具只校验
// 「令牌有效 + 会话在白名单内」，于是任何被放进来的人都能让 bot
// 用主人账号发说说、改头像、改签名、往别处发文件 —— 这些都是
// 对外不可逆、并以主人身份做出的动作，软约束（提示词里那句「群友没有管理权限」）
// 挡不住模型被一句话说动，服务端不拦就是真发出去了。
//
// 这个测试守三件事：
//   1. 存在 OWNER_ONLY_PATHS 这道闸，且覆盖了全部不可逆能力；
//   2. 判断依据是**令牌反查出的会话**，不是请求体里的 key（否则可以冒充管理员）；
//   3. 其它能力（聊天/发消息/发语音/看图/日记）对普通朋友仍然开放。
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); fail++; }
};

const src = fs.readFileSync('E:/dsh/qq-bridge/src/bridge.js', 'utf8');

console.log('=== 1. 管理员专属闸门存在 ===');
const gateIdx = src.indexOf('const OWNER_ONLY_PATHS = new Set([');
ok('OWNER_ONLY_PATHS 已定义', gateIdx > 0);
const gateBody = gateIdx > 0 ? src.slice(gateIdx, gateIdx + 1200) : '';

// 每一项都是「以主人身份对外做、且收不回来」或「改 bot 自身身份」的能力。
// 少一项就意味着那项能力对所有白名单成员开放。
const required = [
  ['/api/socialV2/send-qzone', '发QQ空间（公开发布）'],
  ['/api/socialV2/set-avatar', '改头像'],
  ['/api/socialV2/set-nickname', '改昵称/签名'],
  ['/api/socialV2/send-document', '外发工作目录文件'],
];
for (const [p, label] of required) {
  ok(`${label} 在闸门内`, gateBody.includes(`'${p}'`), `缺少 ${p}`);
}

// `/api/roles/evo/apply` 曾经也在这里，2026-10-28 移出（主人要求「让她能根据外部环境
// 和自身学习自主修改人格卡」）。移出**不等于放开**，改人格的门换到了 role-guard.js：
// 非核心节她自己能改，核心节（身份/隐私/谁能指挥你/红线）仍然只有主人私聊能改。
//
// 所以这里不再断言「apply 在闸门内」，而是断言「那道替代的门确实存在且没被掏空」——
// 否则这次改动会变成「悄悄把改人设的能力对所有人开放」，而测试还全绿。
console.log('\n=== 1b. 改人格卡的门换到了 role-guard（不在闸门内，但另有硬边界） ===');
ok('apply 已不在 OWNER_ONLY_PATHS（自治需要）', !gateBody.includes("'/api/roles/evo/apply'"));
const guardPath = 'E:/dsh/qq-bridge/src/role-guard.js';
ok('role-guard.js 存在', fs.existsSync(guardPath));
const guard = fs.existsSync(guardPath) ? fs.readFileSync(guardPath, 'utf8') : '';
ok('护栏导出了 guardProposalChange', /export function guardProposalChange/.test(guard));
ok('核心小节清单存在', /CORE_SECTION_PATTERNS/.test(guard));
ok('非主人改核心节会被拒', /只有主人本人的私聊能改/.test(guard));
ok('身份锚点校验存在', /REQUIRED_ANCHORS/.test(guard));
ok('频率封顶存在', /maxAppliesPerHour/.test(guard) && /maxAppliesPerDay/.test(guard));
ok('注入预算校验存在', /injectBudget/.test(guard));
// 桥接必须真的调用护栏，否则模块写得再好也没接上。
ok('apply 路由调用了护栏', /guardProposalChange\(\{/.test(src));
ok('proposal 预演也调用护栏（同一份判断）',
  (src.match(/guardProposalChange\(\{/g) || []).length >= 2,
  '预演和应用分开写是这类系统的经典事故源');

console.log('\n=== 2. 判断依据是令牌反查的会话，不是请求体 key ===');
ok('存在 agentKeyForToken', /const agentKeyForToken = \(token\) =>/.test(src));
ok('闸门内用 agentKeyForToken 取调用方', /agentKeyForToken\(token\)/.test(gateBody));
// 关键：如果这里改成读 body.key，模型就能在 body 里写 private:<主人QQ> 冒充管理员。
ok('闸门内不读请求体 key',
  !/body\.key/.test(gateBody),
  '闸门读 body.key 等于允许冒充');
// 反查函数本身必须遍历已发令牌，且用定长比较
const keyFnIdx = src.indexOf('const agentKeyForToken = (token) =>');
const keyFnBody = keyFnIdx > 0 ? src.slice(keyFnIdx, keyFnIdx + 500) : '';
ok('反查遍历会话令牌表', /socialV2\.conversations\.entries\(\)/.test(keyFnBody));
ok('反查使用 tokenEq 定长比较', /tokenEq\(token, st\.agentToken\)/.test(keyFnBody));

console.log('\n=== 3. 闸门位置在 agent 白名单之前（先判身份再放行） ===');
const gateUseIdx = src.indexOf("OWNER_ONLY_PATHS.has(url.pathname)");
const allowIdx = src.indexOf('const agentAllowed = url.pathname ===');
ok('权限闸门先于 agentAllowed 白名单', gateUseIdx > 0 && gateUseIdx < allowIdx,
  `gate=${gateUseIdx} allow=${allowIdx}`);

console.log('\n=== 4. 普通能力仍对朋友开放 ===');
// 这些是"聊天"必需的面，不能被上一版的一刀切误伤。
const mustAllow = ['/api/send/', '/api/socialV2/diary', '/api/socialV2/send-message'];
for (const p of mustAllow) {
  ok(`${p} 不管理员专属`, !gateBody.includes(`'${p}'`), '不该进闸门');
}

console.log('\n=== 5. 提示词里明示了两侧权限（告知，不是边界） ===');
ok('存在 privilegeLine', /const privilegeLine = isOwnerPrivateSession\(key\)/.test(src));
ok('普通朋友一侧写明了禁止项', /一律不能做/.test(src) && /发QQ空间说说/.test(src));
ok('普通朋友一侧要求不泄露管理员私事', /不能对这个人说/.test(src));
ok('privilegeLine 已拼进唤醒提示 base', /tokenLine \+ privilegeLine/.test(src));

console.log('\n=== 6. MCP 层：管理类工具描述标注了「仅管理员」 ===');
const mcp = fs.readFileSync('E:/dsh/qq-bridge/src/mcp-snowluma-safe.js', 'utf8');
// 校验的是**语义**（描述里写明了「谁能用」），不是某一个固定词。
// 2026-10-28 这批描述从「仅管理员可用」改成了「仅限主人私聊使用 / 主人已授权」——
// 同一件事的更准确说法（这些能力按令牌反查的会话判，而那个会话就是主人私聊）。
// 早期这里死磕 `管理员` 三个字，于是措辞一精化就四条一起红，看起来像权限提示没了，
// 其实提示还在、只是更具体了。用一组同义说法匹配，才挡得住真正的问题：
// 「描述里完全没提权限，模型以为谁都能用」。
const PERMISSION_HINT = /仅限主人|仅管理员|管理员|主人已授权|普通朋友不能|只能由主人/;
for (const [tool, hint] of [
  ['qq_send_qzone', 'QQ空间'],
  ['qq_set_self_avatar', '头像'],
  ['qq_set_self_nickname', '签名'],
  ['qq_send_document', '文件'],
]) {
  const i = mcp.indexOf(`'${tool}'`);
  ok(`${tool} 描述含权限提示`, i > 0 && PERMISSION_HINT.test(mcp.slice(i, i + 900)), hint);
}

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
