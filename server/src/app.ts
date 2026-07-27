// 应用工厂：构建并注册所有路由的 Fastify 实例（不监听端口）。
// index.ts 用它来 listen；集成测试用它来 app.inject(...) 免端口直测。
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { isAiTestMode } from './env.js';
import { authRoutes } from './routes/auth.js';
import { metaRoutes } from './routes/meta.js';
import { metricsRoutes } from './routes/metrics.js';
import { agentRoutes } from './routes/agents.js';
import { profileRoutes } from './routes/profile.js';
import { quickscanRoutes } from './routes/quickscan.js';
import { journeyRoutes } from './routes/journey.js';
import { prescriptionRoutes } from './routes/prescriptions.js';
import { brandKitRoutes } from './routes/brandKit.js';
import { bizMetricRoutes } from './routes/bizMetrics.js';
import { sayingRoutes } from './routes/sayings.js';
import { sessionRoutes } from './routes/sessions.js';
import { libraryRoutes } from './routes/library.js';
import { casefileRoutes } from './routes/casefiles.js';
import { battleRoutes } from './routes/battle.js';
import { dataSourceRoutes } from './routes/dataSources.js';
import { moduleRoutes } from './routes/modules.js';
import { searchRoutes } from './routes/search.js';
import { reminderRoutes } from './routes/reminders.js';
import { communityRoutes } from './routes/community.js';
import { decisionRoutes } from './routes/decisions.js';
import { prophecyRoutes } from './routes/prophecies.js';
import { cardRoutes } from './routes/cards.js';
import { projectRoutes } from './routes/projects.js';
import { reportRoutes } from './routes/reports.js';
import { reportShareRoutes } from './routes/reportShare.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { knowledgePipelineRoutes } from './routes/knowledgePipeline.js';
import { memoryRoutes } from './routes/memories.js';
import { graphRoutes } from './routes/graph.js';
import { planRoutes } from './routes/plans.js';
import { skuRoutes } from './routes/sku.js';
import { payRoutes } from './routes/pay.js';
import { wechatRoutes } from './routes/wechat.js';
import { adminRoutes } from './routes/admin.js';
import { adminAccountRoutes } from './routes/adminAccount.js';
import { registerHttpAudit } from './services/audit.js';
import { sandboxEnabled, assertSandboxSafe } from './services/sandbox.js';
import { enterNow } from './services/clock.js';
import { getRedis } from './services/redis.js';
import { verifyUserToken } from './services/userToken.js';
import {
  startEventLoopMonitor, noteRequestStart, noteRequestEnd, noteRequestAborted,
  gateEnter, gateLeave, gateInFlightNow, noteOverloadRejected,
} from './services/metrics.js';

/**
 * 反代信任配置（压测 P0-0）。
 *
 * 原来 `Fastify({...})` 没设 trustProxy，`req.ip` 取 socket 对端地址；而生产 Nginx 是从 127.0.0.1 反代过来的
 * （见 deploy/nginx.conf.example），于是**所有用户的 req.ip 都是 127.0.0.1**。@fastify/rate-limit 默认按
 * req.ip 分桶，结果全站共用一个 300/min 的桶 ≈ 5 RPS，超出即 429——这是一条隐藏的吞吐天花板，
 * 而且 2026-07 那轮压测因为跑在 NODE_ENV=test（限流插件根本没注册）而结构性地测不到它。
 *
 * 默认 'loopback'：只信任本机反代传来的 X-Forwarded-For。这是对当前部署形态最安全的默认值——
 * 若进程被直接暴露到公网，来自外部的 XFF 一律不采信，避免客户端自报 IP 绕过限流。
 * 上 ALB / 多层反代后用 TRUST_PROXY 覆盖：填回源网段（逗号分隔 CIDR）或跳数（如 "2"）。
 * 显式 TRUST_PROXY=false 可关掉（仅用于直接暴露且不经任何反代的场景）。
 */
function trustProxyOption(): boolean | string | number {
  const raw = (process.env.TRUST_PROXY ?? '').trim();
  if (!raw) return 'loopback';
  if (raw === 'false') return false;
  if (raw === 'true') return true; // 无条件信任：仅在入口层已保证 XFF 可信时使用
  if (/^\d+$/.test(raw)) return Number(raw); // 跳数
  return raw; // CIDR / 网段列表，交给 proxy-addr 解析
}

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  // 启动期硬护栏：生产环境误开 PAY_SANDBOX → 拒绝启动（可测 seam 绝不漏到线上）。
  assertSandboxSafe();

  const app = Fastify({ logger: opts.logger ? { level: 'info' } : false, trustProxy: trustProxyOption() });

  // 兼容「Content-Type: application/json 但 body 为空」的 POST（如无 body 的 activate / 报告渲染等接口）。
  // fastify 5.x 默认对空 JSON body 抛 FST_ERR_CTP_EMPTY_JSON_BODY(400)；而前端/小程序的请求封装会无条件带
  // application/json 头，无 body 的 POST 就被拒。这里把空 body 解析成 {}，非空仍正常解析(非法 JSON → 400)。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    // 保留原文供支付回调等需要验签的路由读取（req.rawBody）。
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    const s = (body as string).trim();
    if (!s) return done(null, {});
    try { done(null, JSON.parse(s)); }
    catch (err) { (err as Error & { statusCode?: number }).statusCode = 400; done(err as Error, undefined); }
  });

  await app.register(cors, { origin: true });
  // 知识库文档上传：单文件、≤20MB（解析器在 docParse 按需动态加载）。
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 5 } });

  // 全站限流（此前完全无 limit_req，SMS/AI 生成/下单等成本型接口零防刷，机器常态被扫描器扫——见售卖前体检 P1）。
  // 全局宽松兜底（正常用户远不会触及），成本/鉴权型路由用 route-level config.rateLimit 收紧（见 auth.ts 等）。
  // 测试(NODE_ENV=test)不启用，避免 app.inject 同源请求把套件打成 429。
  //
  // 压测 P0-0 修正：
  //   ① keyGenerator 改为「已登录按用户、未登录按 IP」。原来用插件默认的 req.ip，配合缺失的 trustProxy，
  //      全站会共用一个桶（见 trustProxyOption 注释）。按用户分桶后，成本闸才真正落到「每个人」头上，
  //      也不会被同一运营商 NAT 出口的大量小程序用户互相挤掉。
  //   ② 阈值提到 600/min 并可用 RATE_LIMIT_MAX 覆盖：分桶修对之后，原来的 300 是「每人 5 RPS」，
  //      对正常使用足够，但匿名 IP 桶要容纳 NAT 后的多个真人，故给一档余量。
  //   ③ 配了 REDIS_URL 时用 Redis store，多实例共享计数；否则内存 store（单实例有效）。
  if (!isAiTestMode()) {
    const redis = await getRedis();
    await app.register(rateLimit, {
      global: true,
      max: Number(process.env.RATE_LIMIT_MAX ?? 600),
      timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
      ...(redis ? { redis } : {}),
      keyGenerator: (req) => {
        // verifyUserToken 是纯 HMAC 校验、不查库，放在限流键上开销可忽略；验不过就退回 IP。
        const raw = req.headers['x-user-id'];
        const uid = verifyUserToken(Array.isArray(raw) ? raw[0] : raw);
        return uid ? `u:${uid}` : `ip:${req.ip}`;
      },
      // 探活不能被限流吃掉（ALB / systemd / docker healthcheck 都打这几个路径）。
      // 用 startsWith 而非全等：req.url 带 query 时全等会失配。
      allowList: (req) => req.url.startsWith('/api/health'),
    });
  }

  // 过载主动降级（压测 P0-5）。压测实测：450 RPS 交付 450，800 RPS 只交付约 366——**过载时有效吞吐
  // 不升反降**（典型拥塞崩溃），且失败形态是「排队 + 10s 超时」而非进程崩溃。与其让所有人一起劣化到
  // P95 6.23s，不如让超出容量的少数请求快速 503。
  //
  // 阈值口径：450 RPS 稳态下 P95 ≈ 40ms → 在途约 18 个；越过悬崖后 P95 6.23s → 在途约 3000 个。
  // 默认 200 落在两者之间（对正常态有 10 倍余量，又能在排队刚形成时就介入）。设 0 关闭。
  //
  // 不计入的两类：
  //   ① 探活——被限流挡住或被过载计数误伤，会让健康实例被摘掉，正好帮倒忙。
  //   ② 长耗时 LLM 路径（SSE 的 /api/generate、同步的 /api/generate-sync、
  //      /api/brand-kit/generate、/api/me/dossier/generate）——它们一挂就是几十秒到几分钟，
  //      算进一个 200 的在途预算会瞬间占满，让这道闸对真正要防的「快接口排队」失去意义。
  //      这类请求的并发由 services/llmGate.ts 按上游配额单独管，本闸不重复管。
  const maxInFlight = Number(process.env.MAX_IN_FLIGHT ?? 200);
  if (maxInFlight > 0 && !isAiTestMode()) {
    const isLongRunning = (url: string) => url.includes('/generate') || url.includes('/stream');
    app.addHook('onRequest', async (req, reply) => {
      if (isLongRunning(req.url) || req.url.startsWith('/api/health') || req.url.startsWith('/api/metrics')) return;
      if (gateInFlightNow() >= maxInFlight) {
        noteOverloadRejected();
        reply.header('Retry-After', '1');
        return reply.code(503).send({ error: '服务繁忙，请稍后重试', code: 'SERVER_BUSY' });
      }
      gateEnter();
      (req as typeof req & { __counted?: boolean }).__counted = true;
    });
    const done = (req: { __counted?: boolean }) => { if (req.__counted) { req.__counted = false; gateLeave(); } };
    app.addHook('onResponse', async (req) => done(req as typeof req & { __counted?: boolean }));
    app.addHook('onError', async (req) => done(req as typeof req & { __counted?: boolean }));
  }

  // 指标采集（压测方案 S-b / 优化计划 P1-2）：与过载闸分开计数——闸门那份刻意不含长耗时 LLM 路径
  // 与探活（否则一个 200 的在途预算会被几分钟的生成请求瞬间占满），而容量观测要的是**全量**在途。
  // 指标端点自身不计入，免得观测行为污染被观测的数字。
  startEventLoopMonitor();
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/metrics')) return;
    (req as typeof req & { __metered?: boolean }).__metered = true;
    noteRequestStart();
  });
  app.addHook('onResponse', async (req, reply) => {
    const r = req as typeof req & { __metered?: boolean };
    if (!r.__metered) return;
    r.__metered = false;
    noteRequestEnd(reply.statusCode);
  });
  // 客户端提前断开（小程序切后台、SSE 被掐）不会走 onResponse，须单独归还在途计数。
  app.addHook('onRequestAbort', async (req) => {
    const r = req as typeof req & { __metered?: boolean };
    if (!r.__metered) return;
    r.__metered = false;
    noteRequestAborted();
  });

  // 可测性（沙箱专属）：用 x-test-now 头把本次请求的「现在」固定为指定时刻，快进到期/锚点重置做离线验证。
  // 仅 sandboxEnabled() 为真时注册，生产环境此 hook 完全不存在 → 时间不可被外部篡改。
  if (sandboxEnabled()) {
    app.addHook('onRequest', async (req) => {
      const raw = req.headers['x-test-now'];
      const v = Array.isArray(raw) ? raw[0] : raw;
      if (typeof v === 'string' && v.trim()) {
        const t = v.trim();
        const d = new Date(/^\d+$/.test(t) ? Number(t) : t);
        if (!Number.isNaN(d.getTime())) enterNow(d);
      }
    });
  }

  registerHttpAudit(app);

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(metaRoutes, { prefix: '/api' });
  await app.register(metricsRoutes, { prefix: '/api' }); // Prometheus 指标（需 METRICS_TOKEN，未配则 404）
  await app.register(agentRoutes, { prefix: '/api' });
  await app.register(profileRoutes, { prefix: '/api' });
  await app.register(quickscanRoutes, { prefix: '/api' }); // 3 问速诊（WO-06：获客入口 → 初诊卡）
  await app.register(journeyRoutes, { prefix: '/api' }); // 用户 journey 状态机（WO-07：全 tab「下一步」卡）
  await app.register(prescriptionRoutes, { prefix: '/api' }); // 处方引擎（WO-12：诊断结论 → 生态工具的结构化桥）
  await app.register(brandKitRoutes, { prefix: '/api' }); // 品牌资产包（WO-13：档案 → 数字人/短剧预填输入）
  await app.register(bizMetricRoutes, { prefix: '/api' }); // 结构化经营周报（WO-10：报什么就能对比什么）
  await app.register(sayingRoutes, { prefix: '/api' });
  await app.register(sessionRoutes, { prefix: '/api' });
  await app.register(libraryRoutes, { prefix: '/api' });
  await app.register(casefileRoutes, { prefix: '/api' }); // 战略案卷（执行闭环：军令/回填）
  await app.register(battleRoutes, { prefix: '/api' }); // V7-04：三势刷新 + 认可判断一键生成军令与报告
  await app.register(decisionRoutes, { prefix: '/api' }); // 决策日志（M2：记账/验证/准确率）
  await app.register(prophecyRoutes, { prefix: '/api' }); // 预言账本（M2：天机验证/命中率）
  await app.register(cardRoutes, { prefix: '/api' }); // B 级卡片（M4：每日战报/天时日历/天命速写）
  await app.register(projectRoutes, { prefix: '/api' });
  await app.register(reportRoutes, { prefix: '/api' });
  await app.register(reportShareRoutes, { prefix: '/api' }); // 公开报告页(无鉴权,凭 id 分享)
  await app.register(knowledgeRoutes, { prefix: '/api' });
  await app.register(knowledgePipelineRoutes, { prefix: '/api' }); // V7-06：智库三段式资料整理管道
  await app.register(dataSourceRoutes, { prefix: '/api' }); // V7-07：数据源状态持久化 + 授权流程
  await app.register(moduleRoutes, { prefix: '/api' }); // V7-08：能力/模块中心（目录×用户态 + tier 分流启用）
  await app.register(searchRoutes, { prefix: '/api' }); // V7-14：跨域搜索
  await app.register(reminderRoutes, { prefix: '/api' }); // V7-11：提醒日历（纯读派生）
  await app.register(communityRoutes, { prefix: '/api' }); // V7-13：邀请码 / 社群服务 / 档案工作台
  await app.register(memoryRoutes, { prefix: '/api' });
  await app.register(graphRoutes, { prefix: '/api' });
  await app.register(planRoutes, { prefix: '/api' });
  await app.register(skuRoutes, { prefix: '/api' }); // V7-12：单次付费商品（SKU 下单，回调复用 pay 幂等底座）
  await app.register(payRoutes, { prefix: '/api' }); // 支付回调（封装插件含原文 JSON 解析器，验签用）
  await app.register(wechatRoutes, { prefix: '/api' }); // 微信消息推送 URL 验签 / 可信接收
  await app.register(adminAccountRoutes, { prefix: '/api' }); // 后台账户登录（公开 + 自证），不挂全局 requireAdmin
  await app.register(adminRoutes, { prefix: '/api' });

  // 关闭时释放无头 Chromium（若曾懒启动过；test/未生成过则 no-op）。
  app.addHook('onClose', async () => {
    const { closePdfBrowser } = await import('./services/reportPdf.js');
    await closePdfBrowser();
  });

  await app.ready();
  return app;
}
