#!/usr/bin/env node
/**
 * qq-bridge 启动器：先探测当前 DSH 端口，写回 config.json，再拉起 bridge.js。
 *
 * 为什么需要它：DSH Desktop 的 WebUI 端口每次重启都会变（实测 58668 → 53040 → 57461），
 * 而 bridge.js 只认 config.json 里写死的 dsh.baseUrl，且不读环境变量覆盖。
 * 于是每次重启 DSH，桥接都会连到一个已经不存在的端口，表现成「DSH 已就绪」但实际无响应。
 *
 * 探测方法不是「随便找一个监听端口」，而是**用真实的鉴权链路验证**：
 * 铸造 session cookie → 调 agentPresets.list → 必须返回非空预设清单。
 * 只有真 DSH 会通过，其它占用端口的进程通不过。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG = path.join(ROOT, "config.json");

const { NodeApiClient, unwrap, discoverDshSessionCookie } = await import(
  new URL("../src/dsh-client.js", import.meta.url).href
);

function log(msg) {
  console.log(`[launcher] ${msg}`);
}

/** 列出本机所有处于 LISTEN 的端口（不依赖外部命令）。 */
async function listListeningPorts() {
  // 通过 /proc 不存在于 Windows；改用 Node 无法直接枚举。
  // 走 PowerShell 的 Get-NetTCPConnection 一次拿全量，比逐个端口盲扫快得多。
  const { execFileSync } = await import("node:child_process");
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique",
      ],
      { encoding: "utf8", timeout: 15000, windowsHide: true }
    );
    return [...new Set(out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536))];
  } catch (error) {
    log(`枚举监听端口失败：${error?.message ?? error}`);
    return [];
  }
}

/** 端口是否是真 DSH：能铸造 cookie 且 agentPresets.list 返回非空。 */
async function isRealDsh(port) {
  const base = `http://127.0.0.1:${port}`;
  let cookie;
  try {
    cookie = discoverDshSessionCookie(base);
  } catch {
    return null;
  }
  if (!cookie) return null;
  try {
    const api = new NodeApiClient(base, undefined, { token: cookie });
    const { presets } = unwrap(await api.agentPresets.list({}), "agentPresets.list");
    if (!Array.isArray(presets) || presets.length === 0) return null;
    return presets.map((p) => String(p.id));
  } catch {
    return null;
  }
}

/** 探测 DSH 端口；优先复用 config 里的旧值（若仍有效），否则全量扫描。 */
async function detectDsh() {
  const oldBase = (() => {
    try {
      return JSON.parse(fs.readFileSync(CONFIG, "utf8")).dsh?.baseUrl ?? "";
    } catch {
      return "";
    }
  })();
  const oldPort = Number((/^http:\/\/127\.0\.0\.1:(\d+)$/.exec(oldBase) ?? [])[1]);

  // 1) 先试配置里的旧端口——命中就完全不用改配置，最省事。
  if (oldPort) {
    const ids = await isRealDsh(oldPort);
    if (ids) return { port: oldPort, presets: ids, source: "config" };
  }

  // 2) 全量扫描。按端口降序试（DSH 通常落在高位随机端口），命中即停。
  const ports = (await listListeningPorts()).filter((p) => p !== oldPort).sort((a, b) => b - a);
  log(`旧端口 ${oldPort || "(无)"} 不可用，扫描 ${ports.length} 个监听端口…`);
  for (const port of ports) {
    const ids = await isRealDsh(port);
    if (ids) return { port, presets: ids, source: "scan" };
  }
  return null;
}

const found = await detectDsh();
if (!found) {
  log("❌ 没有找到可用的 DSH。请先启动 DeepSeek Harness。");
  process.exit(1);
}

log(`找到 DSH: 127.0.0.1:${found.port}（来源: ${found.source}）`);
log(`预设: ${found.presets.join(", ")}`);

for (const need of ["qq-chat", "qq-chat-v2"]) {
  if (!found.presets.includes(need)) {
    log(`⚠️  缺少 preset "${need}"。请先运行 node scripts/setup-dsh.mjs desktop 并重启 DSH。`);
  }
}

// 写回 config.json（保留原有格式与中文，只改 baseUrl）
const raw = fs.readFileSync(CONFIG, "utf8");
const cfg = JSON.parse(raw);
const want = `http://127.0.0.1:${found.port}`;
if (cfg.dsh?.baseUrl !== want) {
  cfg.dsh = cfg.dsh ?? {};
  cfg.dsh.baseUrl = want;
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  log(`已更新 config.json: dsh.baseUrl = ${want}`);
} else {
  log(`config.json 无需改动（baseUrl 已是 ${want}）`);
}

// 拉起桥接（继承 stdio，Ctrl+C 可一起结束）
log("启动 bridge.js…");
const child = spawn(process.execPath, [path.join(ROOT, "src", "bridge.js")], {
  cwd: ROOT,
  stdio: "inherit",
  windowsHide: false,
});

const shutdown = (sig) => {
  try {
    child.kill(sig);
  } catch {}
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

child.on("exit", (code, signal) => {
  log(`bridge 退出 code=${code} signal=${signal ?? "-"}`);
  process.exit(code ?? 0);
});
