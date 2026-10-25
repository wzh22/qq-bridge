// 一次性连接测试：用 @snowluma/sdk 连接 SnowLuma 的 OneBot WebSocket 网关，
// 验证地址、端口、accessToken 是否正确。成功即打印 ✅ 并退出。
//
// ⚠️ 这个测试原来直接拿 `config.json` 的 `snowluma.accessToken` 去连 WS，必然 401。
// 原因是 SnowLuma **给 HTTP 和 WebSocket 各发一个不同的 token**（见
// src/snowluma-conn.js 顶部注释：「每个账号有各自的 httpServers[].accessToken
// （HTTP 与 WebSocket 的 token 还是不同的）」）。config 里那份是 HTTP token，
// 拿去连 WS 会被网关以 401 拒绝，而 SDK 只报一句 "连接被关闭: code 1006" ——
// 看起来像网关挂了或端口错了，实际上是拿错了钥匙。
//
// 正确做法与 bridge 一致：用 discoverSnowLumaConnection() 自动发现。
// 它会拿候选 token 真去问一次 get_login_info，选出能用的那个，并单独返回 wsToken
// 与 wsUrl（端口也是 per-account 的）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { discoverSnowLumaConnection } from '../src/snowluma-conn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

console.log('正在自动发现 SnowLuma 连接（HTTP token ≠ WebSocket token）…');
const found = await discoverSnowLumaConnection({ cfg, timeoutMs: 6000 });
if (!found.ok) {
  console.error('❌ 无法发现可用的 SnowLuma 连接:', found.error);
  process.exit(1);
}
const wsUrl = found.wsUrl || cfg.snowluma?.wsUrl;
const wsToken = found.wsToken || '';
console.log(`发现账号 ${found.self?.user_id ?? '?'}（${found.self?.nickname ?? '?'}）`);
console.log(`测试连接 ${wsUrl}（WS token ${wsToken ? '已发现' : '未配置'}）…`);

const bot = new SnowLumaWebSocketClient({
  url: wsUrl,
  accessToken: wsToken || undefined,
  reconnect: false
});

const result = await Promise.race([
  new Promise((resolve) => {
    bot.on('open', () => {
      console.log('✅ WebSocket 已连接（网关接受连接，token 正确）');
      resolve(true);
    });
    bot.on('event', (event) => {
      if (event.post_type === 'meta_event') {
        console.log('✅ 收到 meta 事件:', event.meta_event_type, JSON.stringify(event).slice(0, 160));
      } else {
        console.log('📨 收到事件:', event.post_type, event.message_type ?? '', JSON.stringify(event).slice(0, 160));
      }
    });
    bot.on('close', (info) => {
      if (info?.code === 4001 || info?.code === 401 || info?.code === 1008) {
        console.error('❌ 网关拒绝连接：鉴权失败（WS token 不对）', info);
      } else {
        console.error('❌ 连接被关闭:', info);
      }
      resolve(false);
    });
  }),
  bot.connect().catch((error) => {
    console.error('❌ 连接异常:', error?.message ?? error);
    return false;
  }),
  new Promise((resolve) => setTimeout(() => {
    console.error('❌ 超时（10s）：地址/端口不对或网关未启动？');
    resolve(false);
  }, 10_000))
]);

try { bot.close(); } catch {}
process.exit(result ? 0 : 1);
