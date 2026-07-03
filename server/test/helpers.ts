// 集成测试辅助：构建一次 app（inject 免端口）、灌智能体、清库、登录、统一请求封装。
// 全程 mock 模型（无真实 key → 产出走确定性模板；嵌入走本地确定性向量），结果可复现。
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { AGENTS } from '../src/data/agents.js';
import { SAYINGS, SURVEY, PLANS } from '../src/data/seedConfig.js';

// 安全兜底：标记测试运行，短信等外部服务一律走 mock，绝不真实触达（即使直接 node --test 跑本文件）。
// SMS 发送在请求时才读 NODE_ENV（isSmsTestMode），此处赋值早于任何发送，足以拦截。
process.env.NODE_ENV = 'test';

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!app) app = await buildApp();
  return app;
}

export async function closeApp(): Promise<void> {
  if (app) await app.close();
  await prisma.$disconnect();
}

/** 灌入智能体注册表（路由/产出依赖 agent 记录）。 */
export async function seedAgents(): Promise<void> {
  for (const a of AGENTS) {
    await prisma.agent.upsert({
      where: { key: a.key },
      update: {
        systemPrompt: a.systemPrompt, memoryConfig: a.memoryConfig as object,
        gift: a.gift, billing: a.billing, price: a.price, billingRatio: a.billingRatio ?? 1, meterUnit: a.meterUnit ?? 'text', enabled: a.enabled,
      },
      create: {
        key: a.key, name: a.name, role: a.role, icon: a.icon, type: a.type,
        gift: a.gift, billing: a.billing, price: a.price, billingRatio: a.billingRatio ?? 1, meterUnit: a.meterUnit ?? 'text', enabled: a.enabled,
        greet: a.greet, chipsJson: a.chips as object,
        memText: a.memText, learnText: a.learnText, systemPrompt: a.systemPrompt,
        deliverableKey: a.deliverableKey, memoryConfig: a.memoryConfig as object, sort: a.sort,
      },
    });
  }
}

/** 灌入基础预设：套餐 + 智能体 + 献策 + 问卷（login 取套餐赠算力、献策/问卷接口依赖）。 */
export async function seedBaseline(): Promise<void> {
  await prisma.plan.deleteMany();
  for (let i = 0; i < PLANS.length; i++) {
    const p = PLANS[i];
    await prisma.plan.create({ data: { name: p.name, price: p.price, period: p.period, creditsPerMonth: p.creditsPerMonth, tokenQuotaPerMonth: p.tokenQuotaPerMonth, agentCount: p.agentCount, featuresJson: p.features, highlighted: p.highlighted, sort: i } });
  }
  await seedAgents();
  await prisma.saying.deleteMany();
  for (let i = 0; i < SAYINGS.length; i++) await prisma.saying.create({ data: { text: SAYINGS[i].text, enabled: SAYINGS[i].enabled, sort: i } });
  await prisma.surveyQuestion.deleteMany();
  for (let i = 0; i < SURVEY.length; i++) { const q = SURVEY[i]; await prisma.surveyQuestion.create({ data: { key: q.key, title: q.title, optionsJson: q.options, sort: i } }); }
}

/** 清空业务数据（按外键顺序）；保留 agent 注册表。 */
export async function cleanBusiness(): Promise<void> {
  await prisma.casefileMetric.deleteMany();
  await prisma.casefileOrder.deleteMany();
  await prisma.casefile.deleteMany();
  await prisma.natalChart.deleteMany();
  await prisma.strategicProfile.deleteMany();
  await prisma.decisionLog.deleteMany();
  await prisma.reviewLog.deleteMany();
  await prisma.prophecyLog.deleteMany();
  await prisma.userProgress.deleteMany();
  await prisma.message.deleteMany();
  await prisma.reportVersion.deleteMany();
  await prisma.reportDoc.deleteMany();
  await prisma.knowledgeChunk.deleteMany();
  await prisma.knowledgeItem.deleteMany();
  await prisma.deliverable.deleteMany();
  await prisma.session.deleteMany();
  await prisma.memory.deleteMany();
  await prisma.project.deleteMany();
  await prisma.userAgent.deleteMany();
  await prisma.creditLedger.deleteMany();
  await prisma.tokenUsage.deleteMany();
  await prisma.tokenWallet.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.smsCode.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
  await prisma.moderationLog.deleteMany();
  await prisma.aiSetting.deleteMany();
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface ApiRes<T = any> { status: number; body: T; }

/** 统一请求：带可选 token（x-user-id）。admin 路由默认带测试 ADMIN_TOKEN，可用 adminToken=false 显式关闭。 */
export async function api<T = any>(
  method: Method, url: string, opts: { token?: string; body?: unknown; adminToken?: string | false } = {},
): Promise<ApiRes<T>> {
  const a = await getApp();
  const hasBody = opts.body !== undefined;
  // 无 body 时不要带 application/json 头，否则 Fastify 对空 body 会 400。
  const headers: Record<string, string> = {};
  if (hasBody) headers['content-type'] = 'application/json';
  if (opts.token) headers['x-user-id'] = opts.token;
  const isAdminRoute = url.startsWith('/api/admin/');
  const adminToken = opts.adminToken === false ? '' : (opts.adminToken ?? (isAdminRoute ? process.env.ADMIN_TOKEN : ''));
  if (adminToken) headers['x-admin-token'] = adminToken;
  const res = await a.inject({ method, url, headers, payload: hasBody ? (opts.body as object) : undefined });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}

/** 登录（手机号兼容免码登录）→ 返回 token(=userId)。 */
export async function login(phone: string, name?: string): Promise<string> {
  const r = await api<{ token: string }>('POST', '/api/auth/login', { body: { phone, name } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

// 生成唯一合法手机号（^1\d{10}$）。
let seq = 0;
export function uniquePhone(): string {
  return '1' + String(3_800_000_000 + (seq++)).padStart(10, '0');
}

/** 一个最小的结构化成果（用于存库 / 报告版本测试）。 */
export function deliverable(title: string, sections: { h: string; b?: string; list?: string[] }[]) {
  return {
    title, icon: 'target', meta: '测试 · mock',
    sections, trust: '本结论由 AI 生成，重大决策请结合专业意见。',
    actions: ['save_to_library', 'export_pdf'],
  };
}
