// 一次性迁移工具：把 corpus/collect 下脚本里写死的绝对路径，
// 改成从 corpus-paths.mjs 取。跑完可以删。
//
// 只改两类：
//   1. 语料目录（'E:\dsh\qq-bridge\state\corpus' 等）→ runtimeDir()
//   2. 仓库根（'E:\dsh\qq-bridge'）→ ROOT
// 其余路径（如 edge-cdp-profile）也按 ROOT 推导，但语义保持不变。
//
// 刻意**不**做模糊正则：逐文件精确匹配，改完打印每条改动供复核。
// 因为这些脚本里有字符串字面量本身是「被测试的数据」（如 test-guard.mjs 的
// 模拟命令行），无脑替换会把测试数据也改掉，让测试变得毫无意义。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECT = path.join(HERE, '..', 'collect');

// 每个文件要做的替换：[说明, 原文, 新文, 允许次数(等于它才改)]
// 允许次数用来防「我以为只有一处，其实有七处」的静默扩大。
const PLAN = {
  'analyze.mjs': [['语料目录', "const DIR = 'E:\\\\dsh\\\\qq-bridge\\\\state\\\\corpus';", "const DIR = runtimeDir();"]],
  'collect-bili.mjs': [['语料目录', "const DIR = 'E:\\\\dsh\\\\qq-bridge\\\\state\\\\corpus';", "const DIR = runtimeDir();"]],
  'collect-tieba.mjs': [['语料目录', "const DIR = 'E:\\\\dsh\\\\qq-bridge\\\\state\\\\corpus';", "const DIR = runtimeDir();"]],
  'collect-xhs-home.mjs': [['语料目录', "const DIR = 'E:\\\\dsh\\\\qq-bridge\\\\state\\\\corpus';", "const DIR = runtimeDir();"]],
  'collect-xhs.mjs': [['语料目录', "const DIR = 'E:\\\\dsh\\\\qq-bridge\\\\state\\\\corpus';", "const DIR = runtimeDir();"]],
  'diag-bili-shift.mjs': [['语料目录', "const D = 'E:\\\\dsh\\\\qq-bridge\\\\state\\\\corpus';", "const D = runtimeDir();"]],
  'guard-longrun.mjs': [
    ['语料目录', "const DIR = 'E:\\\\dsh\\\\qq-bridge\\\\state\\\\corpus';", "const DIR = runtimeDir();"],
    ['CDP 配置目录', "const CDP_PROFILE = 'E:\\\\dsh\\\\qq-bridge\\\\state\\\\edge-cdp-profile';", "const CDP_PROFILE = path.join(ROOT, 'state', 'edge-cdp-profile');"],
  ],
  'longrun.mjs': [
    ['语料目录', "const DIR = 'E:\\\\dsh\\\\qq-bridge\\\\state\\\\corpus';", "const DIR = runtimeDir();"],
    ['子进程 cwd', "cwd: 'E:\\\\dsh\\\\qq-bridge',", 'cwd: ROOT,'],
  ],
  'merge.mjs': [['语料目录', 'const D = "E:/dsh/qq-bridge/state/corpus";', 'const D = runtimeDir();']],
  'patterns.mjs': [['语料目录', 'const D="E:/dsh/qq-bridge/state/corpus";', 'const D = runtimeDir();']],
  'sense.mjs': [['语料目录', "const D = 'E:\\\\dsh\\\\qq-bridge\\\\state\\\\corpus';", 'const D = runtimeDir();']],
  // test-guard.mjs 改成**动态拼**：它测的是「能不能从 ps 输出里认出采集进程」，
  // 数据本身必须是「旧格式的绝对路径命令行」，不能跟着仓库位置走，
  // 否则测试输入会随部署变化，测试就失去了度量意义。
  // 所以保留原样，只在文件头加一句说明 —— 见下方 SKIP_NOTE。
};

// 需要注入 import 的文件（用了 runtimeDir/ROOT 就必须 import）
const NEED_PATH = new Set(['guard-longrun.mjs']);
const SKIP_NOTE = {
  'test-guard.mjs': '// 注：本文件里的 E:\\dsh\\... 是**测试输入数据**（模拟的进程命令行），\n// 故意保留绝对路径形态，不要替换成 ROOT/runtimeDir——\n// 换成动态路径会让测试输入随部署变化，度量意义就没了。\n',
};

function ensureImports(src, file) {
  const wants = [];
  if (/\bruntimeDir\(\)/.test(src)) wants.push('runtimeDir');
  if (/\bROOT\b/.test(src) && !/const ROOT/.test(src)) wants.push('ROOT');
  if (!wants.length) return src;
  // 已有 import 就直接补；没有就在第一个 import 之后插一行
  const line = `import { ${wants.join(', ')} } from '../scripts/corpus-paths.mjs';`;
  if (src.includes("from '../scripts/corpus-paths.mjs'")) return src;
  const m = src.match(/^import .*?;\s*$/m);
  if (!m) return `${line}\n${src}`;
  const end = m.index + m[0].length;
  return src.slice(0, end) + '\n' + line + src.slice(end);
}

console.log('=== 迁移 corpus/collect 的硬编码路径 ===\n');
let changedFiles = 0;
let changedLines = 0;

for (const f of readdirSync(COLLECT).filter((x) => x.endsWith('.mjs'))) {
  const full = path.join(COLLECT, f);
  let src = readFileSync(full, 'utf8');
  const before = src;

  for (const [desc, from, to] of (PLAN[f] || [])) {
    if (!src.includes(from)) {
      console.log(`  ⚠ ${f}: 「${desc}」未命中，跳过（可能已改过或格式不同）`);
      continue;
    }
    const n = src.split(from).length - 1;
    if (n !== 1) {
      console.log(`  ⚠ ${f}: 「${desc}」命中 ${n} 处，拒绝自动改（需人工判断）`);
      continue;
    }
    src = src.replace(from, to);
    console.log(`  ✅ ${f}: ${desc}`);
    changedLines += 1;
  }

  if (SKIP_NOTE[f] && !src.startsWith(SKIP_NOTE[f])) {
    src = SKIP_NOTE[f] + src;
    console.log(`  ✅ ${f}: 加说明（避免后来者误替换测试数据）`);
  }

  if (src !== before) {
    src = ensureImports(src, f);
    writeFileSync(full, src, 'utf8');
    changedFiles += 1;
  }
}

console.log(`\n完成：${changedFiles} 个文件、${changedLines} 处替换`);
console.log('未改动的（本来就是对的或不需要改）会在上面以 ⚠ 标出。');
