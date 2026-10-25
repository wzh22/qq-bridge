// 定位「DSH 安装目录下的 node_modules」—— 供仓库脚本加载 DSH 自身的模块做校验。
//
// DSH 有两种安装形态，模块位置完全不同：
//
//   A. 源码 / 开发安装
//      <DSH>/node_modules 是真实目录，普通 node 直接能读。
//
//   B. 打包安装（Electron + app.asar）
//      模块在 <install>/resources/app.asar/dsh/node_modules 里面。
//      **普通 node 的 fs 读不到 asar 内部** —— readFileSync / require 都是
//      ENOENT / MODULE_NOT_FOUND，而目录又确实存在（在 asar 归档里）。
//      只有 Electron 内置的 node（ELECTRON_RUN_AS_NODE=1）带 asar 支持。
//      本机实测：~/.dsh/profiles/*/node_modules 里只有第三方插件自己的依赖
//      （cosmokit、schemastery），DSH 本体全在 asar 里 —— 所以形态 B 下
//      「从 profile 的 package.json 反查」这条路必然失败。
//
// 解析顺序：
//   1. 环境变量 DSH_INSTALL_MODULES / DSH_MODULES（直接指定，最高优先级）
//   2. 从 profile 的 package.json 用 Node 模块解析反查真实安装位置（形态 A）
//   3. 从常见安装位置找 resources/app.asar/dsh/node_modules（形态 B）
//      —— 若当前不是 Electron-as-node，**自动改用同目录的 Electron 可执行文件
//         重新拉起本脚本**，并把解析结果通过环境变量传下去。
//         不抛错让人手动敲环境变量：那种「文档里写着怎么修」的失败，
//         在自动化里等于永久红的检查项 —— 红久了就没人看了。
// 全部失败时抛出带指引的错误，不做静默回退 —— 宁可显式报错，也不要静默用错版本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 用于**反查**位置的探针包。解析成功只说明「这个 node_modules 里至少有一个我们认识的包」，
// 不能直接当作 DSH 本体目录 —— 实测踩过：~/.dsh/profiles/desktop/node_modules 里
// 有 js-yaml（某个第三方插件的依赖），于是被误判成 DSH 安装目录，
// 后续 import '@deepseek-ai/dsh-persona' 才发现根本没有，报 ERR_MODULE_NOT_FOUND。
// 所以反查出的目录必须再过一道 REQUIRED_PACKAGE 存在性检查。
const PROBE_SPECIFIERS = ['@deepseek-ai/dsh-persona', 'js-yaml'];

// 这个包必须真的在目录里，否则那只是「碰巧有依赖的插件目录」，不是 DSH 本体。
const REQUIRED_PACKAGE = '@deepseek-ai/dsh-persona';

function findNodeModules(resolvedFile) {
  let dir = path.dirname(resolvedFile);
  for (;;) {
    if (path.basename(dir) === 'node_modules') return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function candidateProfiles(home) {
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  add(process.env.DSH_PROFILE);
  add('web');
  add('default');
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) add(e.name);
    }
  } catch { /* profiles 目录不存在时忽略 */ }
  return names;
}

// ── 形态 B：打包安装 ────────────────────────────────────────────────
//
// 不写死产品名（DeepSeek Harness / 未来改名 / 内部构建版都要能认）。
// 判据是「<某个安装根>/resources/app.asar」这个结构，而非目录叫什么。

/** 当前运行时是否带 asar 支持（Electron 内置 node）。 */
function hasAsarSupport() {
  return Boolean(process.versions.electron) && process.noAsar !== true;
}

/** 该路径是否「本进程真的能读」—— 普通 node 对 asar 内部路径恒为 false。 */
function readable(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * 扫常见安装根，返回所有形如 .../resources/app.asar 的路径。
 * 只做浅层（最多两跳）枚举，避免在 Program Files 里递归太慢。
 */
function findAsarRoots() {
  const roots = [];
  const envRoot = process.env.DSH_INSTALL_ROOT;
  if (envRoot) roots.push(path.resolve(envRoot));

  const programDirs = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.APPDATA && path.join(process.env.APPDATA, '..', 'Local', 'Programs'),
  ].filter(Boolean);

  for (const base of programDirs) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // 直接是安装根：<base>/<App>/resources/app.asar
      const direct = path.join(base, e.name);
      if (fs.existsSync(path.join(direct, 'resources', 'app.asar'))) roots.push(direct);
      // 再往下看一层（有些安装器多套一个目录）
      let subs = [];
      try { subs = fs.readdirSync(direct, { withFileTypes: true }); } catch { continue; }
      for (const s of subs) {
        if (!s.isDirectory()) continue;
        const cand = path.join(direct, s.name);
        if (fs.existsSync(path.join(cand, 'resources', 'app.asar'))) roots.push(cand);
      }
    }
  }
  return [...new Set(roots)];
}

/** 从安装根推出 Electron 可执行文件（<install>/*.exe 里最大的那个）。 */
function findElectronExe(installRoot) {
  let best = null;
  let entries = [];
  try { entries = fs.readdirSync(installRoot, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isFile() || !/\.exe$/i.test(e.name)) continue;
    const full = path.join(installRoot, e.name);
    let size = 0;
    try { size = fs.statSync(full).size; } catch { continue; }
    // 主程序 100 MB 量级；elevate.exe 之类只有几十 KB，用大小天然排除。
    if (size < 20 * 1024 * 1024) continue;
    if (!best || size > best.size) best = { path: full, size };
  }
  return best?.path ?? null;
}

const REEXEC_FLAG = 'DSH_DSH_MODULES_REEXEC';

/**
 * 用 Electron 内置 node 重新拉起当前脚本，把 asar 里的 node_modules 通过
 * DSH_INSTALL_MODULES 传下去。成功则本进程退出，不再返回。
 */
function reexecUnderElectron(modulesDir, electronExe) {
  const script = process.argv[1];
  if (!script || process.env[REEXEC_FLAG] === '1') return false;

  process.stderr.write(
    `[dsh-modules] DSH 以 asar 打包安装，改用 Electron 内置 node 运行（否则读不到 @deepseek-ai/*）\n`
    + `[dsh-modules]   electron: ${electronExe}\n`
    + `[dsh-modules]   modules:  ${modulesDir}\n`,
  );
  const res = spawnSync(electronExe, [script, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_INSTALL_MODULES: modulesDir,
      [REEXEC_FLAG]: '1',
    },
  });
  if (res.error) return false;
  process.exit(res.status ?? 1);
}

export function dshModulesDir() {
  const override = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (override) return override;

  // ── 形态 A：真实目录 ──
  const home = dshHome();
  for (const profile of candidateProfiles(home)) {
    const anchor = path.join(home, 'profiles', profile, 'package.json');
    if (!fs.existsSync(anchor)) continue;
    const req = createRequire(anchor);
    for (const spec of PROBE_SPECIFIERS) {
      try {
        const dir = findNodeModules(req.resolve(spec));
        // 必须确认 DSH 本体真的在这里；只有 js-yaml 的目录是插件依赖目录，不是 DSH 安装目录。
        if (dir && readable(path.join(dir, ...REQUIRED_PACKAGE.split('/')))) return dir;
      } catch { /* 换下一个 specifier，再换下一个 profile */ }
    }
  }

  // ── 形态 B：app.asar ──
  for (const root of findAsarRoots()) {
    const modulesDir = path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules');
    if (!hasAsarSupport()) {
      // 普通 node 无法验证 asar 内部，但可以确认 Electron 在不在——
      // 用户在，就交给它跑；不在，继续找下一个候选。
      const exe = findElectronExe(root);
      if (exe && reexecUnderElectron(modulesDir, exe)) return modulesDir; // 不返回
      continue;
    }
    if (readable(path.join(modulesDir, '@deepseek-ai', 'dsh-persona'))) return modulesDir;
  }

  throw new Error(
    '无法定位 DSH 安装目录下的 node_modules。\n'
    + `  已尝试：profile 反查（${home}/profiles/*）与常见安装位置的 app.asar。\n`
    + '  请设置 DSH_INSTALL_MODULES=<DSH 安装目录>/node_modules 后重试；\n'
    + '  打包安装请指向 <install>/resources/app.asar/dsh/node_modules，\n'
    + '  并用 Electron 内置 node 运行（ELECTRON_RUN_AS_NODE=1 <install>/<App>.exe <script>）。\n'
    + `  或设置 DSH_HOME 指向 DSH 根目录（当前解析为 ${home}）。`,
  );
}
