// 语料工程的路径与语料装载 —— **唯一来源**。
//
// 为什么单独抽一个文件：
//   语料工具原先散在 state/corpus/ 里，路径写死成 'E:\\dsh\\qq-bridge\\state\\corpus'，
//   出现在 14 个脚本里。这带来三个具体问题，都不是假设：
//
//   1) **换机器就废**：写死 E: 盘 + 用户名，别人 clone 下来全是 ENOENT。
//   2) **state/ 被 .gitignore 忽略**：`state/` 整条都在忽略列表里，于是
//      baseline.mjs / verify-numbers.mjs / sync-card-numbers.mjs 这些
//      **校验工具本身根本没进版本库**。换机重装 = 工具全丢，
//      而「卡片数字与语料是否一致」这条护栏就此消失，且没有任何提示。
//   3) **权限陷阱**：state/ 目录被 harden-state-acl 收紧，只留
//      当前用户/SYSTEM/Administrators 的 ACE，并带 deny 删除权限。
//      在 DSH 沙箱里跑会直接 EPERM（写入 / 删除都失败）。
//
// 所以现在的布局约定：
//   corpus/scripts/   ← 工具（进版本库，可审阅、可回归）
//   corpus/data/      ← 语料**原始采集**快照（可选入库；默认只放基线）
//   corpus/out/       ← 生成物（baseline.json 等），进版本库便于 diff
//   $QQB_STATE/corpus ← 运行时采集落盘区（默认仓库 state/corpus，不进库）
//
// 原始语料读取时**两个目录都扫**：仓库内的快照 + 运行时采集区，按文件名去重
// （仓库快照优先）。这样「拿仓库自带语料即可复现基线」和「继续采新数据」
// 两件事不冲突。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根（qq-bridge）。 */
export const ROOT = path.resolve(HERE, '..', '..');

/** 工具 / 基线 / 生成物目录。 */
export const CORPUS_DIR = path.join(ROOT, 'corpus');
export const SCRIPTS_DIR = path.join(CORPUS_DIR, 'scripts');
export const COLLECT_DIR = path.join(CORPUS_DIR, 'collect');
export const DATA_DIR = path.join(CORPUS_DIR, 'data');
export const OUT_DIR = path.join(CORPUS_DIR, 'out');

/**
 * 运行时采集落盘区。
 * 默认仍指向仓库内 state/corpus —— 采集器一直在往那里写，不搬家。
 * 可用 QQB_STATE 覆盖（测试、或换一台机器只读分析时指向别处）。
 */
export function runtimeDir() {
  const override = process.env.QQB_STATE;
  if (override) return path.resolve(override, 'corpus');
  return path.join(ROOT, 'state', 'corpus');
}

/** 人格卡路径。 */
export const ROLE_PATH = path.join(ROOT, 'roles', '小鲸鱼.md');

function listJson(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch { return []; }
}

/**
 * 返回所有可读的原始语料文件：{ name, full }。
 * 同名时仓库快照优先（保证「用仓库自带语料」可复现），运行时目录补足新增。
 */
export function corpusFiles() {
  const seen = new Set();
  const out = [];
  for (const dir of [DATA_DIR, runtimeDir()]) {
    for (const name of listJson(dir)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, full: path.join(dir, name) });
    }
  }
  return out;
}

/** 读一个 JSON 语料文件；解析失败返回 null（采集器可能写了半截文件）。 */
export function readJson(full) {
  try { return JSON.parse(fs.readFileSync(full, 'utf8')); } catch { return null; }
}

/**
 * 基线的读取位置：优先 corpus/out/baseline.json（进库、可 diff），
 * 找不到再回落到运行时目录里的旧位置（迁移期兼容）。
 */
export function baselinePath() {
  const preferred = path.join(OUT_DIR, 'baseline.json');
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(runtimeDir(), 'baseline.json');
  return fs.existsSync(legacy) ? legacy : preferred;
}

/** 确保输出目录存在。 */
export function ensureOut() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}
