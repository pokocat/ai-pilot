// 集成测试辅助：构建一次 app（inject 免端口）、灌智能体、清库、登录、统一请求封装。
// 全程 mock 模型（无真实 key → 产出走确定性模板；嵌入走本地确定性向量），结果可复现。
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { AGENTS } from '../src/data/agents.js';

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
      update: {},
      create: {
        key: a.key, name: a.name, role: a.role, icon: a.icon, type: a.type,
        gift: a.gift, enabled: a.enabled, greet: a.greet, chipsJson: a.chips as object,
        memText: a.memText, learnText: a.learnText, systemPrompt: a.systemPrompt,
        deliverableKey: a.deliverableKey, memoryConfig: a.memoryConfig as object, sort: a.sort,
      },
    });
  }
}

/** 清空业务数据（按外键顺序）；保留 agent 注册表。 */
export async function cleanBusiness(): Promise<void> {
  await prisma.message.deleteMany();
  await prisma.reportVersion.deleteMany();
  await prisma.reportDoc.deleteMany();
  await prisma.knowledgeChunk.deleteMany();
  await prisma.knowledgeItem.deleteMany();
  await prisma.deliverable.deleteMany();
  await prisma.session.deleteMany();
  await prisma.memory.deleteMany();
  await prisma.project.deleteMany();
  await prisma.creditLedger.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
  await prisma.moderationLog.deleteMany();
  await prisma.aiSetting.deleteMany();
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface ApiRes<T = any> { status: number; body: T; }

/** 统一请求：带可选 token（x-user-id）。 */
export async function api<T = any>(
  method: Method, url: string, opts: { token?: string; body?: unknown } = {},
): Promise<ApiRes<T>> {
  const a = await getApp();
  const hasBody = opts.body !== undefined;
  // 无 body 时不要带 application/json 头，否则 Fastify 对空 body 会 400。
  const headers: Record<string, string> = {};
  if (hasBody) headers['content-type'] = 'application/json';
  if (opts.token) headers['x-user-id'] = opts.token;
  const res = await a.inject({ method, url, headers, payload: hasBody ? (opts.body as object) : undefined });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}

/** 登录（手机号 fake 登录）→ 返回 token(=userId)。 */
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
