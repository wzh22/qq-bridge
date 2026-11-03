#!/usr/bin/env node
// 备份本项目**全部长期记忆**到 `state/backups/memory-<YYYYMMDD-HHmmss>/`。
// 源文件只读：不删、不改、不移动 state/ 下任何真实记忆文件。
//
// 为什么需要它：本项目的长期记忆全是「单点文件、零备份」——diary.jsonl、
// diary-core.jsonl、owner-memory.json、social-v2.json 这些一旦损坏就是永久失忆，
// 而 scripts/ 下此前只有备份人格卡的 backup-persona.mjs，没有任何记忆备份机制。
//
// 三个设计约束（按重要性排序）：
//
//   1. 备份必须**原子**。先写 `<名字>.<pid>.<rand>.tmp` 并 fsync，校验通过后再 rename 成
//      正式文件名（与 src/diary.js 的 writeAll/appendCorrection 同一套做法）。整份备份
//      先落在 `state/backups/.staging-*` 这个隐藏目录里，**全部文件校验通过之后**才把目录
//      rename 成 `memory-<时间戳>`。因此出现在 backups/ 下的 memory-* 目录只有两种状态：
//      完整，或者不存在——不会出现「拷到一半」的备份。
//
//   2. 备份必须**可自证**。每写完一个文件立刻回读，比对 size + sha256（rename 前后各一次）。
//      不一致就报错、删掉整个暂存目录、以退出码 1 结束：宁可这轮没有备份，也不留一份
//      「看起来存在、实际已损坏」的备份。另外写 MANIFEST.json 记录每个文件的字节数与
//      sha256，将来恢复时能核对（MANIFEST 本身也走同一套写盘+校验）。
//
//   3. 源文件**可能正被 bridge 写入**（diary 追加、social-v2 重写）。所以读源时比对
//      读前/读后的 size+mtime，变了就重读（最多 3 次）；仍不稳定则保留这次读到的一致快照
//      并明确警告——备份的是「某一刻的字节」，不是跨文件的原子事务，这一点必须如实说。
//
// 保留策略：只保留最近 14 份 `memory-*`，更早的先打印路径再删除。删除失败只警告，
// 不影响本轮备份的退出码。
//
// 用法：
//   node scripts/memory-backup.mjs                # 备份（保留最近 14 份）
//   node scripts/memory-backup.mjs --list         # 列出已有备份（时间 / 文件数 / 总大小）
//   node scripts/memory-backup.mjs --dry-run      # 只打印将要做什么，不写盘
//   node scripts/memory-backup.mjs --help
//
// 自测用（不影响正常运行）：
//   --state-dir=<dir>  指向别的 state 目录（默认仓库 state/），用于在 %TEMP% 里造场景，
//                      避免碰真实记忆文件。
//   QQB_MEMORY_BACKUP_TEST_TAMPER=1
//                      测试钩子：写临时文件时故意翻转 1 个字节，用来端到端证明
//                      「size+sha256 不一致 → 非零退出、且不留下半成品目录」这条路径真的有效。
//                      只在显式设置该环境变量时生效。
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = 14;

/** 需要备份的记忆文件（相对 state/）。只备存在的。 */
const MEMORY_FILES = [
  'diary.jsonl', // 日记正文
  'diary-others.jsonl', // 他人日记
  'diary-core.jsonl', // 核层：承诺/边界/关系/偏好（不参与衰减）
  'diary-decay.json', // 衰减状态 sidecar
  'diary-others-decay.json',
  'owner-memory.json', // 关于主人的长期事实
  'social-v2.json', // 社交状态
  'inner-life.json', // 内生活状态
];

const BACKUP_NAME_RE = /^memory-\d{8}-\d{6}(?:-\d+)?$/;
const TAMPER_ENV = 'QQB_MEMORY_BACKUP_TEST_TAMPER';

class UsageError extends Error {}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const p2 = (n) => String(n).padStart(2, '0');
const fmtBytes = (n) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} B`;

function stampOf(d) {
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  );
}

/** `memory-20261103-185530` → `2026-11-03 18:55:30` */
function parseStamp(name) {
  const m = /^memory-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

// ── 完整性校验 ────────────────────────────────────────────────────────────

/**
 * 回读 `file` 并与期望的 size + sha256 比对。
 * 不一致直接抛错——调用点靠它保证「要么完整，要么不存在」。
 */
function assertVerified(file, expectedSize, expectedHash, label) {
  const bytes = fs.readFileSync(file);
  const st = fs.statSync(file);
  const hash = sha256(bytes);
  const problems = [];
  if (st.size !== expectedSize || bytes.length !== expectedSize) {
    problems.push(`size ${st.size} ≠ 期望 ${expectedSize}`);
  }
  if (hash !== expectedHash) {
    problems.push(`sha256 ${hash.slice(0, 16)}… ≠ 期望 ${expectedHash.slice(0, 16)}…`);
  }
  if (problems.length > 0) {
    throw new Error(`${label} ${path.basename(file)} 完整性校验失败：${problems.join('；')}`);
  }
  return { size: st.size, sha256: hash };
}

/**
 * 读源文件的一致快照。
 *
 * 源可能正被 bridge 追加/重写，所以比对读前/读后的 size+mtime；变了就重读。
 * 3 次仍不稳定时返回最后那次读到的字节（它本身是自洽的），由调用方警告。
 */
function readStableSnapshot(file, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const before = fs.statSync(file);
    const buf = fs.readFileSync(file);
    const after = fs.statSync(file);
    const stable = before.size === after.size && before.mtimeMs === after.mtimeMs && buf.length === after.size;
    last = { buf, mtimeMs: after.mtimeMs, stable };
    if (stable) break;
  }
  return last;
}

/**
 * 原子写一个文件：tmp → fsync → 校验 tmp → rename → 再校验正式文件。
 * 任何一步不一致都会在 rename 之前（或之后立刻）炸掉，调用方负责清掉暂存目录。
 */
function writeVerifiedAtomic(dir, name, buf, expectedHash) {
  const tmp = path.join(dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);

  let payload = buf;
  if (process.env[TAMPER_ENV] === '1' && name !== 'MANIFEST.json' && buf.length > 0) {
    // 测试钩子：故意写坏 1 个字节，验证校验真的会拦住（size 不变、只有 sha256 不同）。
    payload = Buffer.from(buf);
    payload[payload.length - 1] ^= 0xff;
  }

  try {
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, payload);
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    // rename 之前先验 tmp：半成品绝不能出现在正式文件名下。
    assertVerified(tmp, buf.length, expectedHash, '临时文件');
    const dest = path.join(dir, name);
    fs.renameSync(tmp, dest);
    assertVerified(dest, buf.length, expectedHash, '备份文件');
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw error;
  }
}

// ── 备份目录的发现 / 摘要 / 清理 ──────────────────────────────────────────

/** 列出 backups/ 下的 `memory-*` 目录，按「新 → 旧」排序（目录名本身即时间序）。 */
function listBackups(backupsDir) {
  let entries;
  try {
    entries = fs.readdirSync(backupsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const items = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    if (!BACKUP_NAME_RE.test(ent.name)) continue;
    const dir = path.join(backupsDir, ent.name);
    let memoryFiles = 0;
    let bytes = 0;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || f.name.startsWith('.')) continue;
      const st = fs.statSync(path.join(dir, f.name));
      bytes += st.size;
      if (MEMORY_FILES.includes(f.name)) memoryFiles += 1;
    }
    items.push({ name: ent.name, dir, memoryFiles, bytes, time: parseStamp(ent.name) });
  }
  items.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return items;
}

/** 上一轮被强杀可能留下的 `.staging-*`：只警告，不擅自删（可能正在被另一个进程写）。 */
function warnStaleStaging(backupsDir) {
  let entries;
  try {
    entries = fs.readdirSync(backupsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const stale = entries.filter((e) => e.isDirectory() && e.name.startsWith('.staging-')).map((e) => path.join(backupsDir, e.name));
  if (stale.length === 0) return;
  console.warn(`⚠ 发现 ${stale.length} 个疑似中断残留的暂存目录（已忽略，确认无用后可手动删除）：`);
  for (const p of stale) console.warn(`  - ${p}`);
}

/** 新备份将是最新一份，因此旧备份最多只能留 KEEP-1 份。 */
function planPrune(existing, keep) {
  return existing.slice(Math.max(0, keep - 1));
}

// ── 日志输出 ──────────────────────────────────────────────────────────────

function printUsage(stream = console.log) {
  stream(
    [
      '用法：node scripts/memory-backup.mjs [选项]',
      '',
      '  （无选项）        执行备份，只保留最近 14 份',
      '  --list            列出已有备份（时间 / 文件数 / 总大小）',
      '  --dry-run         只打印将要做什么，不写盘、不删除',
      '  --state-dir=<dir> 指定 state 目录（默认仓库 state/，自测/迁移用）',
      '  --help            显示本帮助',
    ].join('\n'),
  );
}

// ── 主流程 ────────────────────────────────────────────────────────────────

function runBackup({ stateDir, backupsDir, dryRun }) {
  const present = [];
  const skipped = [];
  for (const name of MEMORY_FILES) {
    const abs = path.join(stateDir, name);
    let st = null;
    try {
      st = fs.statSync(abs);
    } catch {
      st = null;
    }
    if (st === null) {
      skipped.push(name);
      continue;
    }
    if (!st.isFile()) {
      skipped.push(`${name}（不是普通文件）`);
      continue;
    }
    present.push({ name, abs, size: st.size });
  }

  if (present.length === 0) {
    throw new Error(`在 ${stateDir} 下没有找到任何待备份的记忆文件（检查 --state-dir 是否指对）`);
  }

  const totalBytes = present.reduce((sum, f) => sum + f.size, 0);
  const stamp = stampOf(new Date());
  const baseName = `memory-${stamp}`;

  if (dryRun) {
    let finalName = baseName;
    for (let i = 2; fs.existsSync(path.join(backupsDir, finalName)); i += 1) finalName = `${baseName}-${i}`;
    const finalDir = path.join(backupsDir, finalName);
    const existing = listBackups(backupsDir);
    const doomed = planPrune(existing, KEEP);

    console.log(`[dry-run] 源目录：${stateDir}`);
    console.log(`[dry-run] 备份目录（将创建）：${finalDir}`);
    for (const f of present) {
      console.log(`  + ${f.name.padEnd(24)} ${fmtBytes(f.size).padStart(12)}`);
    }
    if (skipped.length > 0) console.log(`  跳过（不存在）：${skipped.join('、')}`);
    console.log(`[dry-run] 合计 ${present.length} 个文件 / ${fmtBytes(totalBytes)}；每份拷贝后都会比对 size + sha256`);
    if (doomed.length > 0) {
      console.log(`[dry-run] 备份后超出保留数 ${KEEP}，将删除 ${doomed.length} 份旧备份：`);
      for (const item of doomed) console.log(`  - ${item.dir}`);
    } else {
      console.log(`[dry-run] 无需清理（现有 ${existing.length} 份，保留上限 ${KEEP} 份）`);
    }
    console.log('[dry-run] 未写入任何文件，未删除任何目录');
    return 0;
  }

  fs.mkdirSync(backupsDir, { recursive: true });
  warnStaleStaging(backupsDir);

  const staging = path.join(backupsDir, `.staging-memory-${stamp}-${process.pid}-${randomBytes(3).toString('hex')}`);
  fs.mkdirSync(staging, { recursive: true });

  const warnings = [];
  const recorded = [];
  let finalDir;

  try {
    for (const item of present) {
      const snap = readStableSnapshot(item.abs);
      const hash = sha256(snap.buf);
      writeVerifiedAtomic(staging, item.name, snap.buf, hash);
      recorded.push({
        name: item.name,
        bytes: snap.buf.length,
        sha256: hash,
        source: item.abs,
        mtime: new Date(snap.mtimeMs).toISOString(),
      });
      if (!snap.stable) {
        warnings.push(`${item.name} 在备份期间被改写，已保存最近一次读到的一致快照（${snap.buf.length} B）`);
      }
    }

    const manifest = {
      kind: 'memory-backup',
      createdAt: new Date().toISOString(),
      stateDir,
      keep: KEEP,
      note: '恢复：把本目录中的文件覆盖回 state/ 同名文件即可；可用每项的 sha256/bytes 核对。',
      files: recorded,
      skipped,
      warnings,
    };
    const manifestBuf = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    writeVerifiedAtomic(staging, 'MANIFEST.json', manifestBuf, sha256(manifestBuf));

    // 全部文件已校验通过 → 整目录 rename，此刻备份才「诞生」。
    finalDir = path.join(backupsDir, baseName);
    for (let i = 2; fs.existsSync(finalDir); i += 1) finalDir = path.join(backupsDir, `${baseName}-${i}`);
    fs.renameSync(staging, finalDir);
    finalDir = path.resolve(finalDir);
  } catch (error) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw error;
  }

  console.log(`记忆备份：${finalDir}`);
  for (const item of recorded) {
    console.log(`  ✓ ${item.name.padEnd(24)} ${fmtBytes(item.bytes).padStart(12)}  sha256 ${item.sha256.slice(0, 16)}…`);
  }
  console.log(`合计 ${recorded.length} 个文件 / ${fmtBytes(recorded.reduce((s, f) => s + f.bytes, 0))}，全部通过 size + sha256 校验`);
  if (skipped.length > 0) console.log(`跳过（不存在）：${skipped.join('、')}`);
  for (const w of warnings) console.warn(`⚠ ${w}`);

  const all = listBackups(backupsDir);
  const doomed = all.slice(KEEP);
  if (doomed.length === 0) {
    console.log(`保留 ${all.length} 份备份（上限 ${KEEP} 份），无需清理`);
  } else {
    console.log(`清理 ${doomed.length} 份超出保留数（上限 ${KEEP} 份）的旧备份：`);
    for (const item of doomed) {
      console.log(`  - 删除 ${item.dir}`);
      try {
        fs.rmSync(item.dir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`⚠ 删除失败（保留原样）：${item.dir} —— ${error?.message ?? error}`);
      }
    }
  }
  return 0;
}

function runList({ stateDir, backupsDir }) {
  const items = listBackups(backupsDir);
  if (items.length === 0) {
    console.log(`还没有任何记忆备份（目录：${backupsDir}）`);
    return 0;
  }
  console.log(`现有记忆备份 ${items.length} 份（目录：${backupsDir}）`);
  for (const item of items) {
    const time = item.time ?? '（目录名无法解析时间）';
    console.log(`  ${time}  ${item.name}  ${String(item.memoryFiles)} 个记忆文件  ${fmtBytes(item.bytes)}`);
  }
  const total = items.reduce((s, x) => s + x.bytes, 0);
  console.log(`合计 ${items.length} 份 / ${fmtBytes(total)}；保留上限 ${KEEP} 份`);
  return 0;
}

function parseArgs(argv) {
  const opts = { list: false, dryRun: false, help: false, stateDir: null };
  for (const arg of argv) {
    if (arg === '--list') opts.list = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--state-dir=')) {
      const value = arg.slice('--state-dir='.length).trim();
      if (!value) throw new UsageError('--state-dir= 后面必须给一个目录');
      opts.stateDir = path.resolve(value);
    } else {
      throw new UsageError(`不认识的参数：${arg}`);
    }
  }
  if (opts.list && opts.dryRun) throw new UsageError('--list 与 --dry-run 不能同时用');
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return 0;
  }
  const stateDir = opts.stateDir ?? path.join(ROOT, 'state');
  const backupsDir = path.join(stateDir, 'backups');
  if (opts.list) return runList({ stateDir, backupsDir });
  return runBackup({ stateDir, backupsDir, dryRun: opts.dryRun });
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`✗ ${error.message}`);
    printUsage(console.error);
    process.exitCode = 2;
  } else {
    console.error(`✗ 备份失败：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}