// 自定义 HTTP 工具单元测试：stub fetch，断言请求组装（body/query/headers/身份头）、
// 响应截断、非2xx 兜底、SSRF 私网拒绝。
//   cd server && node --import tsx --test test/httpTool.test.ts
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeHttpTool, assertSafeUrl, type HttpToolDef } from '../src/llm/tools/httpTool.js';
import type { ToolContext } from '../src/llm/tools/types.js';

const CTX: ToolContext = { tenantId: 't1', userId: 'u1', agentKey: 'ak', projectId: null, query: 'q' };
const PUB = 'http://93.184.216.34/api'; // 公网 IP 字面量：assertSafeUrl 不走 DNS、不私网

function def(over: Partial<HttpToolDef> = {}): HttpToolDef {
  return { key: 'query_order', name: '查订单', description: 'd', inputSchema: { type: 'object', properties: {} }, httpMethod: 'POST', httpUrl: PUB, headers: {}, argsLocation: 'body', ...over };
}

let last: { url: string; init: any } | null = null;
const realFetch = globalThis.fetch;
function stub(status: number, body: string) {
  globalThis.fetch = (async (url: any, init: any = {}) => {
    last = { url: String(url), init };
    return { ok: status >= 200 && status < 300, status, text: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}
beforeEach(() => { last = null; });
afterEach(() => { globalThis.fetch = realFetch; });

describe('makeHttpTool', () => {
  test('POST body：args 进 JSON body，合并静态头 + 注入身份头', async () => {
    stub(200, '订单状态：已发货');
    const t = makeHttpTool(def({ headers: { Authorization: 'Bearer xyz' } }));
    const out = await t.run({ orderId: 'A1' }, CTX);
    assert.equal(out, '订单状态：已发货');
    assert.equal(last!.init.method, 'POST');
    assert.deepEqual(JSON.parse(last!.init.body), { orderId: 'A1' });
    assert.equal(last!.init.headers.Authorization, 'Bearer xyz');
    assert.equal(last!.init.headers['Content-Type'], 'application/json');
    assert.equal(last!.init.headers['X-Tenant-Id'], 't1');
    assert.equal(last!.init.headers['X-User-Id'], 'u1');
    assert.equal(last!.init.headers['X-Agent-Key'], 'ak');
  });

  test('GET / argsLocation=query：args 拼到 query string，无 body', async () => {
    stub(200, 'ok');
    const t = makeHttpTool(def({ httpMethod: 'GET', argsLocation: 'query' }));
    await t.run({ q: '增长', n: 3 }, CTX);
    assert.equal(last!.init.method, 'GET');
    assert.equal(last!.init.body, undefined);
    assert.match(last!.url, /[?&]q=%E5%A2%9E%E9%95%BF/);
    assert.match(last!.url, /[?&]n=3/);
  });

  test('响应超长截断到 ~4000', async () => {
    stub(200, 'x'.repeat(5000));
    const out = await makeHttpTool(def()).run({}, CTX);
    assert.ok(out.length <= 4001 + 1 && out.endsWith('…'));
  });

  test('非 2xx → 失败提示串（不抛）', async () => {
    stub(500, 'boom');
    const out = await makeHttpTool(def()).run({}, CTX);
    assert.match(out, /工具调用失败 HTTP 500/);
  });
});

describe('assertSafeUrl (SSRF)', () => {
  test('拒非 http/https', async () => { await assert.rejects(() => assertSafeUrl('ftp://x/y'), /http\/https/); });
  test('拒环回 127.0.0.1', async () => { await assert.rejects(() => assertSafeUrl('http://127.0.0.1/x'), /内网|环回/); });
  test('拒私网 10.x / 192.168 / 172.16', async () => {
    await assert.rejects(() => assertSafeUrl('http://10.0.0.5/x'), /内网|环回/);
    await assert.rejects(() => assertSafeUrl('http://192.168.1.1/x'), /内网|环回/);
    await assert.rejects(() => assertSafeUrl('http://172.16.0.1/x'), /内网|环回/);
  });
  test('拒云元数据 169.254.169.254 / 100.100.100.200', async () => {
    await assert.rejects(() => assertSafeUrl('http://169.254.169.254/latest/meta-data/'), /内网|环回/);
    await assert.rejects(() => assertSafeUrl('http://100.100.100.200/'), /内网|环回/);
  });
  test('拒 localhost', async () => { await assert.rejects(() => assertSafeUrl('http://localhost:8080/x'), /内网|环回/); });
  test('放行公网 IP 字面量', async () => { await assertSafeUrl(PUB); });
  test('私网 URL 的工具 run → 配置错误串（不抛）', async () => {
    const out = await makeHttpTool(def({ httpUrl: 'http://10.0.0.1/x' })).run({}, CTX);
    assert.match(out, /配置错误/);
  });
});
