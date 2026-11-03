// safe-fetch 的 fake-IP（Clash/Mihomo TUN）白名单回归测试。
// 全部离线：http/https 不发请求，DNS 用本地桩（与 test-audit-security 一致的做法）。
// 运行：node --test scripts/test-safe-fetch-fakeip.mjs
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import dns from 'node:dns';

// 模块在导入时捕获 dns.promises.lookup，所以先打桩再 import。
const originalLookup = dns.promises.lookup;
dns.promises.lookup = async (host) => {
  // fake-IP 环境下 Clash TUN 的典型应答：公网域名 -> 198.18.0.0/15 假地址。
  if (host === 'github.com') return [{ address: '198.18.0.130', family: 4 }];
  // 假地址与真实内网地址同时出现时，必须整体拒绝（不能只放行其中一条）。
  if (host === 'mixed-fake.test') return [
    { address: '198.18.0.130', family: 4 },
    { address: '::1', family: 6 },
  ];
  if (host === 'public.test') return [{ address: '93.184.216.34', family: 4 }];
  throw new Error(`Unexpected DNS lookup in offline test: ${host}`);
};
let safeFetch;
try {
  safeFetch = await import('../src/safe-fetch.js');
} finally {
  dns.promises.lookup = originalLookup;
}
const { isPrivateIp, isConfiguredFakeIp, resolveSafeAddresses, resolveSafeHost, validateFetchUrl } = safeFetch;

const ENV = 'SAFE_FETCH_FAKE_IP_CIDRS';
const savedEnv = process.env[ENV];

function setEnv(value) {
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
}

afterEach(() => setEnv(savedEnv));

test('默认（未配置 SAFE_FETCH_FAKE_IP_CIDRS）：fake-IP 仍判私网，行为不变', async () => {
  setEnv(undefined);
  assert.equal(isPrivateIp('198.18.0.130'), true, '默认不得放行 fake-IP 段');
  assert.equal(isConfiguredFakeIp('198.18.0.130'), false);
  await assert.rejects(resolveSafeAddresses('github.com'), /内网|本机地址/);
  await assert.rejects(resolveSafeHost('github.com'), /内网|本机地址/);
  await assert.rejects(validateFetchUrl('http://github.com/'), /内网|本机地址/);
});

test('配置 SAFE_FETCH_FAKE_IP_CIDRS=198.18.0.0/15：fake-IP 放行', async () => {
  setEnv('198.18.0.0/15');
  assert.equal(isPrivateIp('198.18.0.130'), false);
  assert.equal(isPrivateIp('198.18.0.0'), false);
  assert.equal(isPrivateIp('198.19.255.255'), false, '/15 边界内都要放行');
  assert.deepEqual(await resolveSafeAddresses('github.com'), ['198.18.0.130']);
  assert.equal(await resolveSafeHost('github.com'), '198.18.0.130');
  const { ip } = await validateFetchUrl('http://github.com/');
  assert.equal(ip, '198.18.0.130');
  // 公网地址不受白名单影响（本来就是 false）。
  assert.equal(isPrivateIp('93.184.216.34'), false);
});

test('安全底线：即使白名单写成 0.0.0.0/0，真正内网/本机地址仍被拦', async () => {
  setEnv('0.0.0.0/0');
  for (const ip of [
    '127.0.0.1',          // 环回
    '127.1.2.3',
    '192.168.1.1',        // RFC1918
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '169.254.169.254',    // 云 metadata（链路本地）
    '169.254.1.1',
    '100.64.0.1',         // CGNAT
    '0.0.0.0',            // 本机网络
    '192.0.0.5',          // IETF 协议分配
    '224.0.0.1',          // 组播
    '255.255.255.255',    // 广播/保留
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} 无论白名单怎么写都必须继续拦截`);
    assert.equal(isConfiguredFakeIp(ip), false, `${ip} 不得被 isConfiguredFakeIp 放行`);
  }
  // 端点级也不放行：环回 URL 依然被拒。
  await assert.rejects(validateFetchUrl('http://127.0.0.1/'), /内网|本机地址/);
  await assert.rejects(resolveSafeAddresses('127.0.0.1'), /内网|本机地址/);
  // 白名单外/内的私网互不影响：fake-IP 本身可以过，10/8 不行。
  assert.equal(isPrivateIp('198.18.0.130'), false);
});

test('白名单里写了 RFC1918 网段也放不出内网地址（地址级二次拦截）', async () => {
  setEnv('10.0.0.0/8,192.168.0.0/16,169.254.0.0/16,127.0.0.0/8');
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true);
  assert.equal(isPrivateIp('127.0.0.1'), true);
  // 同时，白名单外的 fake-IP 不受影响：这里没配 198.18/15，所以仍然拦截。
  assert.equal(isPrivateIp('198.18.0.130'), true);
});

test('白名单外的私网地址不受影响；只放行配置的子网', async () => {
  setEnv('198.18.0.0/16');
  assert.equal(isPrivateIp('198.18.0.130'), false, '/16 内放行');
  assert.equal(isPrivateIp('198.19.0.1'), true, '/15 的另一半未配置，仍然拦截');
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('192.168.1.1'), true);
  // 未配置时再次恢复原行为（缓存按环境变量原串失效）。
  setEnv(undefined);
  assert.equal(isPrivateIp('198.18.0.130'), true);
});

test('非法/非 IPv4 的白名单条目被忽略，不会意外放宽', async () => {
  setEnv('not-a-cidr, 198.18.0.0/33, ::1/128, 198.18.0.1/-1, 999.1.1.1/8');
  assert.equal(isConfiguredFakeIp('198.18.0.130'), false);
  assert.equal(isPrivateIp('198.18.0.130'), true);
  // 末尾空项也必须是空列表而不是「0.0.0.0/0」。
  setEnv(',,');
  assert.equal(isPrivateIp('198.18.0.130'), true);
  assert.equal(isPrivateIp('127.0.0.1'), true);
});

test('IPv6（含映射/内嵌 fake-IP 的写法）不参与白名单', async () => {
  setEnv('198.18.0.0/15');
  for (const ip of ['::ffff:198.18.0.130', '64:ff9b::c612:82', '::1', 'fd00::1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} 必须维持拦截（白名单仅支持 IPv4）`);
  }
  // DNS 同时返回 fake-IP 和环回地址时整体拒绝。
  await assert.rejects(resolveSafeAddresses('mixed-fake.test'), /内网|本机地址/);
});

test('导出函数签名保持兼容', () => {
  for (const name of ['isPrivateIp', 'isConfiguredFakeIp', 'resolveSafeAddresses', 'resolveSafeHost', 'validateFetchUrl', 'safeFetch', 'safeFetchBuffer']) {
    assert.equal(typeof safeFetch[name], 'function', `${name} 必须继续导出`);
  }
  assert.equal(isPrivateIp.length, 1, 'isPrivateIp(ip) 只能有一个必填参数');
});