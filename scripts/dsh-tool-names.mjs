// DSH 工具名抽取：**唯一实现**，供
//   · `scripts/scan-dsh-tool-names.mjs`（人工/升级时对账，打印清单）
//   · `scripts/test-preset-local-tools.mjs`（登记期断言，防拼错假名）
// 共同使用。
//
// 为什么要抽成模块：这两处过去各有一份实现，而测试那份是**模糊**的
// （`\bname:\s*['"]x['"]` 全文件乱扫 + 只认少数包名前缀 + 只读包根目录的
// cordis.patch.yml）。结果 0.2.0 对账时把 10 个**真实存在**的工具名误判成
// 「假名」——`dsh-mcp-resources` 与 `dsh-experimental-tool-agent-team` 不匹配它
// 的包名白名单，`subagent_codex` 写在 `dsh-web-app/presets/*.patch.yml` 而不是
// 包根。误判方向是危险的：它会逼人把真名字从守卫名单里删掉。
//
// 抽取规则（都要求**就近锚定**，不把 `systemPrompt.section({ name: 'tool:read' })`
// 这类非工具名当工具）：
//   ① `.register(defineTool({ … name: "X" … }))` —— DSH 所有工具包的注册形状
//   ② `toolName: "X"` / `toolName: z.string().default("X")` —— 配置化工具名
//      （dsh-tool-subagent 的 subagent / subagent_fork 就是这样声明的）
//   ③ YAML patch 里的 `toolName: X` 行（任意层级 *.patch.yml，含 presets/ 子目录）
import fs from 'node:fs';
import path from 'node:path';
import { dshModulesDir } from './dsh-modules.mjs';

/** 名字形态：小写字母开头，允许下划线与连字符，长度合理。 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{1,40}$/;

/** DSH 自带包所在目录（`<node_modules>/@deepseek-ai`）。 */
export function dshPackagesDir() {
  return process.env.DSH_TOOL_PACKAGES || path.join(dshModulesDir(), '@deepseek-ai');
}

/** 用户安装的第三方插件目录（也会注册工具：plugin-guard / 超级注入器等）。 */
export function dshPluginDirs() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : null);
  return [home ? path.join(home, 'plugins') : null].filter((p) => p && fs.existsSync(p));
}

/**
 * **profile 里安装的第三方插件包目录**（`~/.dsh/profiles/<name>/node_modules`）。
 *
 * 为什么必须扫这里（2026-10-25 实测）：守卫名单历来只对账 `@deepseek-ai/dsh-*`，
 * 但本机 profile 装了 26 个第三方插件，其中 8 个用 `defineTool` 往**全局层**
 * 注册了工具（`advanced_search`、`save_token_expand`、`univer_api`…）。
 * 官方包里没有这些名字 ⇒ 扫描器把它们看不见 ⇒
 *   ① 守卫漏覆盖，名字留在仿真会话 schema 里（真实发生过，见 tool-restrict.log）；
 *   ② 一旦把名字补进守卫，不带本函数的扫描器又会把它们判成"拼错的假名"，
 *      把人逼回去删掉 —— 正是注释里说过的最危险的误判方向。
 * 所以扫描范围必须包含 profile 的 node_modules。
 *
 * 返回**具体包目录**（已展开 `@scope/name`），而不是 node_modules 根目录，
 * 因为根目录里混着大量第三方插件的传递依赖，逐个当包扫会浪费大量 IO。
 */
export function dshProfilePackageDirs() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : null);
  if (!home) return [];
  const out = [];
  const seen = new Set();
  let profiles = [];
  try { profiles = fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true }) } catch { return [] }
  for (const p of profiles) {
    if (!p.isDirectory()) continue;
    const modules = path.join(home, 'profiles', p.name, 'node_modules');
    let entries = [];
    try { entries = fs.readdirSync(modules, { withFileTypes: true }) } catch { continue }
    const push = (dir) => {
      // junction/symlink（link: 依赖）也算：isDirectory() 对 junction 为 true。
      if (seen.has(dir)) return;
      seen.add(dir);
      out.push(dir);
    };
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('@')) {
        let subs = [];
        try { subs = fs.readdirSync(path.join(modules, e.name), { withFileTypes: true }) } catch { continue }
        for (const s of subs) {
          if (s.isDirectory()) push(path.join(modules, e.name, s.name));
        }
      } else if (/^(dsh-|@)/.test(e.name)) {
        push(path.join(modules, e.name));
      }
    }
  }
  return out;
}

function walkFiles(dir, out = [], depth = 0, maxDepth = 5) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < maxDepth) walkFiles(full, out, depth + 1, maxDepth); }
    else out.push(full);
  }
  return out;
}

/** 从一个 JS/TS 源文件里抽取工具名。 */
function extractFromSource(text, source, add) {
  for (const m of text.matchAll(/\.register\(\s*defineTool\(\{[\s\S]{0,400}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
  for (const m of text.matchAll(/\btoolName:\s*["']([^"']+)["']/g)) add(m[1], source);
  for (const m of text.matchAll(/\btoolName:\s*[^;\n]*?\.default\(\s*["']([^"']+)["']/g)) add(m[1], source);
  // 独立的一次性工具文件（defineTool 不挂在 .register( 上时的兜底）
  // ⚠️ 必须允许**别名导入**：打包后的第三方插件普遍写成
  //   `import { defineTool as defineTool12 } from "@deepseek-ai/dsh-tools"`
  // 再 `return defineTool12({ name: 'univer_status', … })`。
  // 只认字面量 `defineTool(` 会漏掉 univer-office 的全部 14 个工具名，
  // 于是守卫里真实存在的 univer_status 被误判成假名。
  for (const m of text.matchAll(/defineTool[0-9A-Za-z_$]*\(\{[\s\S]{0,200}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
  // 直接传对象字面量的注册：`ctx.tools.register({ name: 'x', … })`
  // （time-machine 用 `tctx.tools.register`，read-url / context-lens 用 `ctx.tools.register`）
  //
  // ⚠️ 必须锚定在 `.tools.register(`，不能写成裸 `.register(`：DSH 里还有
  // slash 命令、locale、slot 三种同名 register，裸匹配会把**斜杠命令名**
  // （`export` / `file` / `goal` / `plan`）当成工具名报成"漏隐藏的危险工具"——
  // 那些名字根本没有对应工具，restrict 它们只会换来一串无意义的失败日志。
  if (/\.tools\s*\.\s*register\s*\(/.test(text)) {
    for (const m of text.matchAll(/\.tools\s*\.\s*register\(\s*\{[\s\S]{0,300}?\bname:\s*["']([^"']+)["']/g)) {
      add(m[1], source);
    }
    // 第三种形态：**先造对象、再注册** —— `ctx.tools.register(readLinksTool(ctx, cfg))`。
    // 工具名写在被调函数的 `return { name: 'x', … }` 里，上面两条规则都抓不到。
    // 这里只跟着 register 的参数标识符去找同名函数，不做全文件乱扫：
    // 全文件乱扫 `name: 'x'` 会把 Excel 参数名、表单字段名一起捞进来（实测 470 条噪声）。
    for (const call of text.matchAll(/\.tools\s*\.\s*register\(\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
      const fn = call[1];
      const decl = new RegExp(
        `(?:function\\s+${fn}\\s*\\(|(?:const|let|var)\\s+${fn}\\s*=\\s*(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>)`
        + `[\\s\\S]{0,600}?\\breturn\\s*\\{[\\s\\S]{0,300}?\\bname:\\s*["']([^"']+)["']`,
      );
      const hit = decl.exec(text);
      if (hit) add(hit[1], source);
    }
  }
}

/** 从 YAML patch 里抽取配置化的工具名。 */
function extractFromPatch(text, source, add) {
  for (const m of text.matchAll(/^\s*(?:-\s*)?toolName:\s*([^\s#]+)\s*$/gm)) {
    add(m[1].replace(/^['"]|['"]$/g, ''), source);
  }
}

/**
 * 抽取已安装 DSH（及其插件）里出现的全部工具名。
 *
 * @param options.packagesDir - `@deepseek-ai` 目录；缺省按 {@link dshPackagesDir} 解析。
 * @param options.pluginDirs - 第三方插件目录列表；缺省按 {@link dshPluginDirs} 解析。
 * @returns `{ names: Map<name, Set<source>>, packages: string[] }`。
 *          `packages` 是实际扫过的包/插件名，便于诊断「一个都没扫到」。
 */
export function collectDshToolNames({ packagesDir, pluginDirs, profileDirs } = {}) {
  const names = new Map();
  const packages = [];
  const add = (name, source) => {
    if (!TOOL_NAME_RE.test(name)) return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(source);
  };

  const roots = [];
  const pkgRoot = packagesDir ?? dshPackagesDir();
  if (fs.existsSync(pkgRoot)) roots.push({ dir: pkgRoot, filter: /^dsh-/ });
  for (const dir of pluginDirs ?? dshPluginDirs()) {
    // 用户的插件目录里全是插件包（含 .bak-* 备份，也一起扫：备份里的旧名字
    // 仍然说明这个名字曾经真实存在）。
    roots.push({ dir, filter: null });
  }
  // profile 里装着的第三方插件包：每个 dir 就是一个包的根，直接扫。
  const profilePkgs = profileDirs ?? dshProfilePackageDirs();
  if (profilePkgs.length) roots.push({ dir: null, packages: profilePkgs });

  for (const root of roots) {
    // 形态 A：一个目录下有多个包（@deepseek-ai / 用户 plugins 目录）
    // 形态 B：直接给出包目录列表（profile 的 node_modules）
    const pkgList = root.packages
      ? root.packages.map((dir) => ({ name: pkgLabel(dir), dir }))
      : (() => {
        let entries = [];
        try { entries = fs.readdirSync(root.dir, { withFileTypes: true }) } catch { return [] }
        return entries
          .filter((e) => e.isDirectory() && (!root.filter || root.filter.test(e.name)))
          .map((e) => ({ name: e.name, dir: path.join(root.dir, e.name) }));
      })();

    for (const { name, dir } of pkgList) {
      packages.push(name);
      for (const f of walkFiles(dir)) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue }
        if (/\.(js|mjs|cjs)$/.test(f) || f.endsWith('.d.ts')) extractFromSource(text, name, add);
        else if (/\.patch\.ya?ml$/.test(f)) extractFromPatch(text, name, add);
      }
    }
  }
  return { names, packages };
}

/**
 * 某个包是否装在**任意** profile 里 —— 直接按包名探测目录，不走 {@link dshProfilePackageDirs}。
 *
 * 为什么必须独立探测（2026-10-25，这是本文件最隐蔽的一个坑）：
 *   「第三方工具名凭什么豁免真实存在性校验」的判据是「所属插件装没装」。
 *   如果这个判据复用 `dshProfilePackageDirs()`，那么扫描器一旦退化
 *   （目录遍历返回空 / asar 路径失效 / 有人改回只扫官方包），
 *   两件事会**同时**发生：名字扫不到 + 判据认为"插件没装"
 *   ⇒ 于是每个第三方名字都被当作"没装插件所以缺席正常"而跳过 ⇒ **全绿**。
 *   实测确认过：给 dshProfilePackageDirs() 加 `return []` 后，
 *   test-preset-local-tools 依然 fail 0 —— 一个把真故障藏起来的判据。
 *   现在改成按包名直接 existsSync 探测：遍历坏了它也照样返回 true，
 *   于是"插件装着但名字扫不到"必定报红，把退化暴露出来。
 */
export function isProfilePackageInstalled(pkgName) {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : null);
  if (!home || !pkgName) return false;
  let profiles = [];
  try { profiles = fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true }) } catch { return false }
  for (const p of profiles) {
    if (!p.isDirectory()) continue;
    // 直接拼 `node_modules/<pkgName>`；带 scope 的名字自然落到 `@scope/name`。
    if (readable(path.join(home, 'profiles', p.name, 'node_modules', ...pkgName.split('/')))) {
      return true;
    }
  }
  return false;
}

/**
 * profile 里**已安装**的包名集合（给「第三方工具名凭什么豁免」判定用）。
 *
 * 见 {@link isProfilePackageInstalled} 的说明：这里**不**复用目录遍历结果，
 * 而是逐个按名字探测，保证「扫描器退化」不会同时让归属判据瞎掉。
 */
export function dshProfilePackageLabels() {
  return new Set(dshProfilePackageDirs().map((dir) => pkgLabel(dir)));
}

/** 包目录 → 便于阅读的包名（`…/node_modules/@scope/pkg` → `@scope/pkg`）。 */
export function pkgLabel(dir) {
  const base = path.basename(dir);
  const parent = path.basename(path.dirname(dir));
  return parent.startsWith('@') ? `${parent}/${base}` : base;
}

/** 便利包装：只要名字集合。 */
export function dshToolNameSet(options) {
  return new Set(collectDshToolNames(options).names.keys());
}

/**
 * 「危险语义」判定：与本地执行 / 文件 / 进程 / 派生 agent / 宿主运行期相关的名字。
 * 守卫**必须**覆盖它们。纯模型侧无害工具由 {@link SAFE_MODEL_TOOLS} 显式排除。
 *
 * 这是**发现用**的启发式（宁可多报，人工再判），不是安全边界本身；
 * 边界是守卫的 restrict 名单 + 执行期白名单。
 */
export const DANGER_TOOL_RE = /(pwsh|bash|shell|exec|spawn|process|terminal|pty|read|write|edit|file|fs_|glob|grep|patch|str_replace|subagent|agent_|teammate|workflow|ralph|job|skill|present|goal|plan|todo|memory|snapshot|rollback|incident|plugin|cordis|dsh_|dev_|import|install|reload|inject|stage|config|workspace|session|export|office|slash|command|schedule|voice|speech|team|mcp_resource)/;

/** 明确无害、允许出现在仿真会话 schema 里的模型侧工具。 */
export const SAFE_MODEL_TOOLS = new Set(['ask_user_question', 'todo_write']);
