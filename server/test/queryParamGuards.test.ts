// 回归：数值查询参数为非数字（Number('abc')=NaN）时，不得再把 NaN 传进 Prisma 崩成 500。
// 修复前：limit=abc → take:NaN → PrismaClientValidationError → 500；version/to=abc 同理。
//   cd server && node --env-file=.env.test --import ./test/hermeticEnv.mjs --import tsx --test test/queryParamGuards.test.ts
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getApp, closeApp, api, seedBaseline, cleanBusiness, login, uniquePhone, deliverable,
} from './helpers.js';

describe('查询参数守卫 · 非数字 limit/version 不再 500', () => {
  let token: string;

  before(async () => { await getApp(); await seedBaseline(); });
  after(async () => { await closeApp(); });

  beforeEach(async () => {
    await cleanBusiness();
    await seedBaseline();
    token = await login(uniquePhone(), '守卫测试');
  });

  test('GET /api/memories?limit=abc → 200（旧代码 take:NaN 会 500）', async () => {
    const r = await api('GET', '/api/memories?limit=abc', { token });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  test('GET /api/graph/entities?limit=abc → 200', async () => {
    const r = await api('GET', '/api/graph/entities?limit=abc', { token });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  test('GET /api/graph/relations?limit=abc → 200', async () => {
    const r = await api('GET', '/api/graph/relations?limit=abc', { token });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  test('reports version / diff 非数字版本号 → 400 BAD_VERSION（不再 500），latest 仍可取', async () => {
    const saved = await api('POST', '/api/reports', {
      token,
      body: { title: '守卫测试方案', content: deliverable('守卫测试方案', [{ h: '背景', b: '内容' }]) },
    });
    assert.equal(saved.status, 200);
    const id = (saved.body as any).reportId ?? (saved.body as any).id;
    assert.ok(id, '应返回报告 id');

    const ver = await api('GET', `/api/reports/${id}/version?v=abc`, { token });
    assert.equal(ver.status, 400);
    assert.equal((ver.body as any).code, 'BAD_VERSION');

    const diff = await api('GET', `/api/reports/${id}/diff?to=abc`, { token });
    assert.equal(diff.status, 400);
    assert.equal((diff.body as any).code, 'BAD_VERSION');

    // 有效路径不受影响：不带 v 取最新版本仍 200。
    const ok = await api('GET', `/api/reports/${id}/version`, { token });
    assert.equal(ok.status, 200);
  });

  test('PUT /api/profile 收到字面量 null body 不再 500', async () => {
    // 内容解析器会把字面量 null（JSON.parse('null')）原样穿过来，旧代码 req.body.industry
    // 即 null.industry → TypeError → 500；现在应正常建档（industry 为空）。
    // 必须发真正的字面量 "null"（而非空 body，空 body 会被归一成 {}），故直接 inject。
    const app = await getApp();
    const res = await app.inject({
      method: 'PUT', url: '/api/profile',
      headers: { 'x-user-id': token, 'content-type': 'application/json' },
      payload: 'null',
    });
    assert.notEqual(res.statusCode, 500);
    assert.ok(res.statusCode === 200 || res.statusCode === 400, `期望 200/400，实际 ${res.statusCode}`);
  });
});
