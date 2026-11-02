// 发布前扫描自身的回归：flags:'' 也必须变成全局正则。
// 否则同一个噪音匹配会被 exec 重复返回 5000 次，扫描器提前跳过文件后续内容。

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['scripts/privacy-scan.mjs'], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120000,
  windowsHide: true,
});
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

assert.equal(result.error, undefined, result.error?.message ?? '扫描子进程异常');
assert.equal(result.status, 0, `发布前扫描应通过：\n${output}`);
assert.ok(!output.includes('已提前结束该规则'), `存在未完整执行的规则：\n${output}`);
assert.ok(output.includes('扫描文件数'), `缺少扫描计数：\n${output}`);
console.log('privacy-scan：所有规则完整执行，未发现敏感信息');
