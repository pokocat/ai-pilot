// 自建 HTTP 工具的 SSRF 目标校验（assertSafeUrl / isPrivateIp）。
//
// 守的铁律：默认拒私网 / 环回 / 云元数据。历史坑（2026-09-27 修）——
// isPrivateIp 只认「点分」的 IPv4-mapped（::ffff:127.0.0.1），认不出等价的
// 「十六进制」写法 ::ffff:7f00:1（= 127.0.0.1）/ ::ffff:a9fe:a9fe（= 169.254.169.254）。
// 而 Node 的 WHATWG URL 会把 [::ffff:127.0.0.1] 归一成 [::ffff:7f00:1]，于是连点分字面
// 也会被归一进那条漏网路径 —— 全程无需 DNS 即可 SSRF 到环回 / 元数据。
//
// 全部用 IP 字面（不触发 DNS / 网络），断言确定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeUrl } from '../src/llm/tools/httpTool.ts';

async function rejected(url: string): Promise<boolean> {
  try { await assertSafeUrl(url); return false; } catch { return true; }
}
async function allowed(url: string): Promise<boolean> {
  try { await assertSafeUrl(url); return true; } catch { return false; }
}

test('SSRF：十六进制 IPv4-mapped IPv6 指向环回 / 元数据必须拒（历史绕过）', async () => {
  assert.equal(await rejected('http://[::ffff:7f00:1]/'), true, '::ffff:7f00:1 = 127.0.0.1');
  assert.equal(await rejected('http://[::ffff:a9fe:a9fe]/latest/meta-data/'), true, '::ffff:a9fe:a9fe = 169.254.169.254');
  assert.equal(await rejected('http://[::ffff:0a00:0001]/'), true, '::ffff:0a00:0001 = 10.0.0.1');
  // 点分字面会被 URL 归一成十六进制，同样必须拒
  assert.equal(await rejected('http://[::ffff:127.0.0.1]/'), true, '点分 mapped 归一后仍拒');
});

test('SSRF：NAT64 / IPv4-compatible / 原生 IPv6 内网地址必须拒', async () => {
  assert.equal(await rejected('http://[64:ff9b::7f00:1]/'), true, 'NAT64 127.0.0.1');
  assert.equal(await rejected('http://[::7f00:1]/'), true, 'IPv4-compatible 127.0.0.1（已弃用）');
  assert.equal(await rejected('http://[::1]/'), true, '::1 环回');
  assert.equal(await rejected('http://[fe80::1]/'), true, 'fe80::/10 link-local');
  assert.equal(await rejected('http://[fc00::1]/'), true, 'fc00::/7 ULA');
});

test('SSRF：点分 IPv4 私网 / 元数据 / localhost 必须拒', async () => {
  for (const u of [
    'http://127.0.0.1/', 'http://10.1.2.3/', 'http://192.168.1.1/',
    'http://172.16.0.1/', 'http://169.254.169.254/', 'http://100.100.100.200/',
    'http://localhost/', 'http://0.0.0.0/',
  ]) {
    assert.equal(await rejected(u), true, u);
  }
});

test('SSRF：公网地址（IP 字面）放行，且非 http/https 一律拒', async () => {
  assert.equal(await allowed('http://1.1.1.1/'), true, '公网 v4');
  assert.equal(await allowed('http://[2606:4700:4700::1111]/'), true, '公网 v6（Cloudflare）');
  assert.equal(await allowed('http://[::ffff:808:808]/'), true, '::ffff:8.8.8.8 公网 mapped');
  assert.equal(await rejected('file:///etc/passwd'), true, '非 http/https');
  assert.equal(await rejected('gopher://127.0.0.1/'), true, '非 http/https');
});
