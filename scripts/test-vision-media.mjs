// 视觉/图片链路自检脚本：
// 1. 校验配置默认模型为 DeepSeek-V4-Flash-Vision-Exp
// 2. 校验 safe-fetch 的 SSRF 防护（本机地址应被拒绝）
// 3. 若桥接运行中，校验 /api/images/message 端点可用（用二代 agent token）
// 运行：node scripts/test-vision-media.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetchBuffer } from '../src/safe-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

const config = readJson(path.join(ROOT, 'config.json'));
let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 1. 配置
//
// 这里原来是硬编码白名单（deepseek-flash / deepseek-v4-flash-vision-exp），
// 结果是**每换一次模型测试就变红**，而变红的原因往往不是真故障。更糟的是它给的
// 信号是「模型不在我认识的名单里」，而不是「这个模型不支持图片」——两者完全不是
// 一回事，容易被当成噪声略过，把真正的多模态退化盖住。
//
// 改成读 DSH 的 provider 真实声明（profiles/*/cordis.patch.yml 里 models[].input），
// 只有读不到配置时才退回白名单。这样断言问的是真问题：**当前这个 provider 的
// 这个模型，到底支不支持 image 输入**。
const MODEL_FALLBACK_ALLOWLIST = ['deepseek-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash'];

/**
 * 极简 YAML 扫描：只要 provider→model→input 这一层，不值得为它引一个解析器依赖。
 *
 * 不能用固定缩进猜 provider：实测 provider 键在 indent=6，`models:` 在 8，
 * `- id:` 在 10，`input:` 在 12，条目在 14 —— 层级是嵌在别的键底下的（llm-deepseek
 * 的 config 里），而「4 空格」这种直觉会一个都匹配不到，然后静默退回白名单，
 * 让这个测试重新变成「名单比对」。这里改成**看结构**：
 *   provider 键 ⇒ 其直接子键里出现 `models:`
 * 这样不依赖具体缩进值。
 */
function findModelInputs(configText) {
  const out = new Map(); // `${provider}/${model}` -> ['text','image']
  const lines = configText.split(/\r?\n/).map((raw) => {
    const expanded = raw.replace(/\t/g, '  ');
    const t = expanded.trim();
    return { indent: expanded.length - expanded.trimStart().length, text: t };
  });

  // 1) 收集所有「键:」候选及其缩进
  const keys = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_.-]+):\s*$/.exec(lines[i].text);
    if (m) keys.push({ name: m[1], indent: lines[i].indent, line: i });
  }

  // 2) 判定哪些候选是 provider：它的直接子块里要有 `models:`
  const providerAt = new Map(); // line -> name
  for (const k of keys) {
    // 在 keys 里找第一个缩进更深的后继；若它是 models 且缩进 = k.indent + 2，则 k 是 provider
    const next = keys.find((n) => n.line > k.line && n.indent > k.indent);
    if (next && next.name === 'models' && next.indent === k.indent + 2) {
      providerAt.set(k.line, k.name);
    }
  }
  if (!providerAt.size) return out;

  // 3) 遍历 provider 块，抽 models[].input
  const providerLines = [...providerAt.keys()].sort((a, b) => a - b);
  for (let pi = 0; pi < providerLines.length; pi++) {
    const startLine = providerLines[pi];
    const provider = providerAt.get(startLine);
    const blockEnd = pi + 1 < providerLines.length ? providerLines[pi + 1] : lines.length;
    let model = null;
    let inInput = false;
    let inputIndent = -1;
    for (let i = startLine + 1; i < blockEnd; i++) {
      const { indent, text } = lines[i];
      if (!text || text.startsWith('#')) continue;
      const idM = /^-\s+id:\s*(\S+)\s*$/.exec(text) || /^id:\s*(\S+)\s*$/.exec(text);
      if (idM) { model = idM[1]; inInput = false; continue; }
      if (/^input:\s*$/.test(text)) { inInput = true; inputIndent = indent; continue; }
      if (inInput) {
        if (indent <= inputIndent) { inInput = false; continue; }
        const v = text.replace(/^-\s*/, '').replace(/['"]/g, '').trim();
        if (v && model) {
          const key = `${provider}/${model}`;
          if (!out.has(key)) out.set(key, []);
          if (!out.get(key).includes(v)) out.get(key).push(v);
        }
      }
    }
  }
  return out;
}

let modalityKnown = false;
let supportsImage = false;
let modalityNote = '';
const provider = String(config.dsh?.provider ?? '');
const modelId = String(config.dsh?.model ?? '');
try {
  const profileDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles');
  if (fs.existsSync(profileDir)) {
    for (const entry of fs.readdirSync(profileDir)) {
      const patch = path.join(profileDir, entry, 'cordis.patch.yml');
      if (!fs.existsSync(patch)) continue;
      const inputs = findModelInputs(fs.readFileSync(patch, 'utf8'));
      const hit = inputs.get(`${provider}/${modelId}`);
      if (hit && hit.length) {
        modalityKnown = true;
        supportsImage = hit.includes('image');
        modalityNote = `${provider}/${modelId} 声明 input=[${hit.join(',')}]`;
        break;
      }
    }
  }
} catch (error) {
  modalityNote = `读取 DSH provider 配置失败：${error?.message ?? error}`;
}

if (modalityKnown) {
  check('config.dsh.model 支持图片输入（按 DSH provider 声明）', supportsImage, modalityNote);
} else {
  check('config.dsh.model 为已知多模态模型', MODEL_FALLBACK_ALLOWLIST.includes(modelId),
    modalityNote || `当前 ${provider}/${modelId}，未在 DSH provider 配置里找到声明，退回白名单判断`);
}
check('config.dsh.reasoningEffort 为 max', config.dsh?.reasoningEffort === 'max', `当前 ${config.dsh?.reasoningEffort}`);
check('config.socialV2.tools.getImages 默认开启', config.socialV2?.tools?.getImages !== false);

// 2. safe-fetch SSRF
try {
  await safeFetchBuffer('http://127.0.0.1/');
  check('safe-fetch 拒绝本机地址', false, '未抛出异常');
} catch (error) {
  check('safe-fetch 拒绝本机地址', /内网|本机|禁止/.test(String(error?.message ?? error)), error?.message);
}

// 3. 桥接端点（可选）
const consoleTokenFile = path.join(ROOT, 'state', 'console-token');
const socialV2File = path.join(ROOT, 'state', 'social-v2.json');
if (fs.existsSync(consoleTokenFile) && fs.existsSync(socialV2File)) {
  try {
    const consoleToken = fs.readFileSync(consoleTokenFile, 'utf8').trim();
    const social = JSON.parse(fs.readFileSync(socialV2File, 'utf8'));
    const conv = social?.conversations ? Object.entries(social.conversations)[0] : null;
    if (conv) {
      const [key, st] = conv;
      const agentToken = st?.agentToken;
      const messageId = st?.recentMessages?.find((m) => m && !m.isSelf)?.messageId || st?.recentMessages?.[0]?.messageId;
      if (agentToken && messageId) {
        const url = `http://127.0.0.1:${config.consolePort || 3100}/api/images/message?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`;
        const res = await fetch(url, { headers: { 'x-agent-token': agentToken, 'x-console-token': consoleToken }, signal: AbortSignal.timeout(10000) });
        const body = await res.json().catch(() => ({}));
        check('桥接 /api/images/message 端点可访问', res.ok === true && body.ok === true, `HTTP ${res.status}`);
      } else {
        console.log('⚠️ 跳过桥接端点检查：没有可用 agentToken/messageId');
      }
    }
  } catch (error) {
    console.log(`⚠️ 桥接端点检查跳过：${error?.message ?? error}`);
  }
} else {
  console.log('⚠️ 跳过桥接端点检查：缺少 state/console-token 或 state/social-v2.json');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
