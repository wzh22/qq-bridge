// 备份人格卡（roles/小鲸鱼.md），落盘到仓库根 `.roles-backup-<时间戳>/`。
//
// 为什么不是「cp 一下就行」：
//   人格卡是本仓库里**唯一被提示词运行时直接读取**的文件，改坏了群里的机器人
//   立刻就说错话，而且没有任何「编译错误」这种信号——它只会安静地变得不像人。
//   所以备份要能回答三个问题，否则等于没备：
//     1. 备的是哪一刻的哪个版本？（工作区那份 vs git HEAD 那份，常常不是一回事）
//     2. 怎么确认备份没损坏？（哈希 / 字节数，而不是「看着挺像」）
//     3. 出事怎么退回去？（恢复命令要写在 MANIFEST 里，不能靠记忆）
//
//   实测踩过的坑：本仓库的人格卡长期处于「工作区已改、尚未提交」的状态
//   （今天重写二代卡时就是 11877 字节 vs HEAD 的 20227 字节）。
//   只复制工作区文件，等于丢掉了「改之前长什么样」——而那恰恰是最常要退回的版本。
//   所以这里**同时导出 git HEAD 版本**，两者分开命名，绝不互相覆盖。
//
// 为什么要用 git cat-file 而不是 shell 重定向：
//   `git show HEAD:roles/小鲸鱼.md > x.md` 在 PowerShell 下会经过一次文本编码转换，
//   BOM / 换行 / 非 GBK 字符都可能被改写，备份出来「字节数不对」却没人发现。
//   这里直接取 Buffer 原样写盘，并在 MANIFEST 里记下字节数与 SHA-256 供核对。
//
// 用法：
//   node scripts/backup-persona.mjs             # 备份 + 写 MANIFEST
//   node scripts/backup-persona.mjs --label=x   # 给备份目录加个语义后缀
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROLE_REL = 'roles/小鲸鱼.md';
const ROLE_ABS = path.join(ROOT, 'roles', '小鲸鱼.md');

const labelArg = process.argv.find((a) => a.startsWith('--label='));
const label = labelArg ? labelArg.slice('--label='.length).replace(/[^\w\u4e00-\u9fa5-]/g, '') : '';

// 调用 git 时**不能假设 spawn 可用**。
//
// 实测：在 DSH 沙箱里，node 通过 spawnSync 启动任何进程都会 EPERM
//（包括 git.exe 的绝对路径）。这不是权限配置问题，是沙箱对「子进程再起进程」
// 的硬性限制 —— 而本脚本恰恰是被人从会话里调起来的。
// 所以 git 相关动作一律**尽力而为**：失败不阻断备份本身（备份的核心是文件字节），
// 但必须把「git 信息没取到」如实写进 MANIFEST，不能假装 HEAD 版本不存在。
function git(args) {
  try {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { ok: false, spawnFailed: true, out: Buffer.alloc(0), err: r.error.message };
    return { ok: r.status === 0, out: r.stdout || Buffer.alloc(0), err: (r.stderr || Buffer.alloc(0)).toString('utf8') };
  } catch (e) {
    return { ok: false, spawnFailed: true, out: Buffer.alloc(0), err: String(e && e.message) };
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

if (!existsSync(ROLE_ABS)) {
  console.error(`❌ 找不到人格卡：${ROLE_ABS}`);
  process.exit(1);
}

// ── 时间戳（本地时间，便于和日志/会话时间对上）──
const now = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
const dirName = `.roles-backup-${stamp}${label ? '-' + label : ''}`;
const dir = path.join(ROOT, dirName);
mkdirSync(dir, { recursive: true });

// ── 1. 工作区版本 ──
const working = readFileSync(ROLE_ABS);
const workingName = '小鲸鱼.working.md';
writeFileSync(path.join(dir, workingName), working);

// ── 2. git HEAD 版本（可能不存在：文件还是新增未提交；也可能 spawn 不通）──
let headName = null;
let headBuf = null;
let headCommit = '';
let gitUnavailable = false;
const probe = git(['cat-file', '-e', `HEAD:${ROLE_REL}`]);
if (probe.spawnFailed) {
  // 沙箱内 spawn 被拒。此时**不能**据此断言「HEAD 里没有这个文件」——
  // 那是把「我没问到」当成「不存在」。改为标记 gitUnavailable，在 MANIFEST 里说明，
  // 并让「读取文件快照」这条不依赖 git 的路径继续工作（那才是备份的底线）。
  gitUnavailable = true;
} else if (probe.ok) {
  const r = git(['cat-file', '-p', `HEAD:${ROLE_REL}`]);
  if (r.ok) {
    headBuf = r.out;
    headName = '小鲸鱼.git-head.md';
    writeFileSync(path.join(dir, headName), headBuf);
    headCommit = git(['rev-parse', '--short', 'HEAD']).out.toString('utf8').trim();
  }
}

// ── 3. 工作区 vs HEAD 的关系（备份时点的事实，不猜）──
const statusOut = gitUnavailable ? '' : git(['status', '--porcelain', '--', ROLE_REL]).out.toString('utf8').trim();
const diffOut = headBuf ? git(['diff', '--stat', 'HEAD', '--', ROLE_REL]).out.toString('utf8').trim() : '';

// ── 4. MANIFEST ──
const lines = [];
lines.push(`# 人格卡备份 MANIFEST`);
lines.push('');
lines.push(`- 备份时间：${now.toLocaleString('zh-CN', { hour12: false })}（Asia/Shanghai）`);
lines.push(`- 源文件：\`${ROLE_REL}\``);
lines.push(`- 备份目录：\`${dirName}/\``);
lines.push('');
lines.push(`## 内容`);
lines.push('');
lines.push(`| 文件 | 说明 | 字节 | SHA-256 |`);
lines.push(`| --- | --- | ---: | --- |`);
lines.push(`| \`${workingName}\` | 备份时刻**工作区**的版本 | ${working.length} | \`${sha256(working)}\` |`);
if (headBuf) {
  lines.push(`| \`${headName}\` | **git HEAD**（\`${headCommit}\`）里的版本 | ${headBuf.length} | \`${sha256(headBuf)}\` |`);
} else if (gitUnavailable) {
  lines.push(`| — | ⚠ git 不可用（沙箱禁止 spawn 子进程），**未导出 HEAD 版本** | — | — |`);
} else {
  lines.push(`| — | git HEAD 中不存在该文件（新增未提交） | — | — |`);
}
lines.push('');
lines.push(`## 备份时点的 git 状态`);
lines.push('');
if (gitUnavailable) {
  lines.push('⚠ 本次运行 git 不可用（EPERM：沙箱禁止子进程再起进程），因此**无法给出** git 状态。');
  lines.push('   这不代表工作区没有改动，只代表没查到。需要 git 视角时，在沙箱外重跑本脚本。');
} else if (statusOut) {
  lines.push('```');
  lines.push(statusOut);
  lines.push('```');
} else {
  lines.push('工作区与 HEAD 一致（无改动）。');
}
if (diffOut) {
  lines.push('');
  lines.push('与 HEAD 的差异统计：');
  lines.push('');
  lines.push('```');
  lines.push(diffOut);
  lines.push('```');
}
lines.push('');
lines.push(`## 本机其它现存恢复点`);
lines.push('');
lines.push('人格卡的历史快照不止这一份，散在几处。**恢复前先按字节数/SHA-256 对上你要的那个版本**，');
lines.push('不要只按文件名猜（实测踩过：只按日期挑，挑到了「改之前」那一版）。');
lines.push('');
lines.push('| 位置 | 字节 | 修改时间 |');
lines.push('| --- | ---: | --- |');
// 扫描仓库内所有可能是「人格卡快照」的文件：命名里带 小鲸鱼，或是 roles/ 下的 .bak / .pre-finalize。
// 只读不改，纯报告。
function findSnapshots() {
  const out = [];
  const scan = (dir, depth) => {
    if (depth > 3) return;
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        scan(full, depth + 1);
        continue;
      }
      if (!/小鲸鱼/.test(e.name)) continue;
      if (full === ROLE_ABS) continue;
      try {
        const st = statSync(full);
        out.push({ rel: path.relative(ROOT, full).replace(/\\/g, '/'), size: st.size, mtime: st.mtime });
      } catch { /* 忽略不可读项 */ }
    }
  };
  scan(ROOT, 0);
  return out.sort((a, b) => a.mtime - b.mtime);
}
const snaps = findSnapshots();
if (!snaps.length) {
  lines.push('| （无） | — | — |');
} else {
  for (const s of snaps) {
    lines.push(`| \`${s.rel}\` | ${s.size} | ${s.mtime.toLocaleString('zh-CN', { hour12: false })} |`);
  }
}
lines.push('');
lines.push(`## 怎么恢复`);
lines.push('');
lines.push('恢复到**工作区版本**（也就是备份那一刻正在生效的卡）：');
lines.push('');
lines.push('```powershell');
lines.push(`Copy-Item '${dirName}/${workingName}' '${ROLE_REL}' -Force`);
lines.push('```');
if (headName) {
  lines.push('');
  lines.push('恢复到 **git HEAD 版本**（备份时刻已提交的那一版）：');
  lines.push('');
  lines.push('```powershell');
  lines.push(`Copy-Item '${dirName}/${headName}' '${ROLE_REL}' -Force`);
  lines.push('```');
}
lines.push('');
lines.push('> ⚠ 在 DSH 沙箱内运行时，`roles/` 带 Low 完整性标签且禁止写，');
lines.push('> 上述 Copy-Item 会被拒绝（EPERM）。此时改用会话内的文件编辑工具写回，');
lines.push('> 或在沙箱外（普通终端 / danger-full-access）执行。');
lines.push('');
lines.push('## 注意');
lines.push('');
lines.push('- 本目录匹配 `.gitignore` 的 `/.roles-backup-*/`，**不进版本库**。');
lines.push('- 所以它只防「改坏了要退回」，不防「整台机器没了」。后者要靠 git 提交或外部存储。');
writeFileSync(path.join(dir, 'MANIFEST.md'), lines.join('\n'), 'utf8');

// ── 5. 校验：写完后读回，哈希必须与内存里的一致 ──
// 备份脚本自己也要被验证，否则「备份成功」只是一句口号。
const verify = [];
const rb = readFileSync(path.join(dir, workingName));
verify.push(['工作区版可读回且哈希一致', sha256(rb) === sha256(working), `${rb.length} 字节`]);
if (headBuf) {
  const rh = readFileSync(path.join(dir, headName));
  verify.push(['HEAD 版可读回且哈希一致', sha256(rh) === sha256(headBuf), `${rh.length} 字节`]);
}
const manifestOk = readFileSync(path.join(dir, 'MANIFEST.md'), 'utf8').includes(sha256(working));
verify.push(['MANIFEST 含正确的哈希', manifestOk, '']);

console.log(`=== 人格卡备份 ===`);
console.log(`源：${ROLE_REL}`);
console.log(`到：${dirName}/`);
console.log('');
console.log(`  ${workingName.padEnd(24)} ${String(working.length).padStart(6)} 字节  工作区版`);
if (headBuf) {
  console.log(`  ${headName.padEnd(24)} ${String(headBuf.length).padStart(6)} 字节  git HEAD (${headCommit})`);
} else if (gitUnavailable) {
  console.log(`  ${'（未导出 HEAD 版）'.padEnd(24)}   ⚠ git 不可用（沙箱禁止 spawn 子进程）`);
} else {
  console.log(`  ${'（git HEAD 中无此文件）'}`);
}
console.log(`  ${'MANIFEST.md'.padEnd(24)}          恢复说明 + 哈希 + 本机其它恢复点`);
console.log('');
if (gitUnavailable) {
  console.log('⚠ 本次 git 不可用，MANIFEST 里会如实标注「未取到」——');
  console.log('  这不等于「HEAD 没有这个文件」。要 git 视角请在沙箱外重跑。');
} else if (statusOut) {
  console.log(`git 状态：${statusOut}`);
}
console.log('');
let bad = 0;
for (const [name, ok, detail] of verify) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) bad += 1;
}
console.log('');
if (bad) {
  console.log(`❌ ${bad} 项校验失败，备份不可信`);
  process.exit(1);
}
console.log(`✅ 备份完成并自校验通过：${path.join(ROOT, dirName)}`);
if (working.length !== (headBuf?.length ?? working.length)) {
  console.log(`   注意：工作区版与 HEAD 版**不同**（${working.length} vs ${headBuf.length} 字节），`);
  console.log('   两份都留了，恢复时按 MANIFEST 选。');
}
