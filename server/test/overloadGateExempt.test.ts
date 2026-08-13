// 过载闸豁免名单的回归 —— 纯源码断言（不起服务、不连库）。
//   cd server && node --import tsx --test test/overloadGateExempt.test.ts
//
// 背景（2026-08-12）：MAX_IN_FLIGHT 这道闸是为「快接口排队」设计的，长耗时路径必须排除在计数外，
// 否则一个 200 的在途预算会被几十秒的请求瞬间占满，闸门对真正要防的场景失效。
// /api/video/* 是到 aidrama 的**同步 BFF 代理**（上游预算 60s），此前漏在名单外；
// 小程序把作品页升成一级 tab 后每次进入都会打一次 /api/video/works，上游一慢就能把槽位耗光、
// 把无关的快接口一起打成 503。这两条断言把「豁免」和「服务端先于端上放手」钉住。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('过载闸：外部 BFF 代理不计入在途预算', () => {
  test('isLongRunning 覆盖 /api/video/ 前缀', () => {
    const app = read('app.ts');
    const match = /const isLongRunning = \(url: string\) =>([\s\S]*?);\n/.exec(app);
    assert.ok(match, '找不到 isLongRunning 定义——改了写法就同步改这条断言');
    assert.match(match[1], /\/api\/video\//, '/api/video/* 是同步等外部上游的代理，必须豁免');
    assert.match(match[1], /\/generate/, '长耗时 LLM 路径的豁免不得回退');
    assert.match(match[1], /\/stream/);
  });

  test('作品列表有独立的短超时上限，且服务端先于端上放手', () => {
    const route = read('routes/video.ts');
    const capMatch = /WORKS_TIMEOUT_CAP_MS = (\d+)/.exec(route);
    assert.ok(capMatch, '/video/works 必须给上游一个短超时上限');
    const cap = Number(capMatch[1]);
    // 端上 services/api.js 对这条给 12s；服务端上限必须更短，否则端断开后槽位仍被占住。
    assert.ok(cap <= 12000, `上游上限 ${cap}ms 不得超过端上 12s 的等待窗口`);
    assert.match(route, /timeoutCapMs: WORKS_TIMEOUT_CAP_MS/, '上限要真的传进网关调用');

    const gateway = read('services/video/aidramaGateway.ts');
    assert.match(gateway, /Math\.min\(cfg\.timeoutMs, Math\.max\(1000, timeoutCapMs\)\)/, '单次上限只能收紧、不能放大全局预算');
  });
});
