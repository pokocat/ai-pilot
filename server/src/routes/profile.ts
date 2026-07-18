import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { loadChart } from '../services/paipan.js';
import { fortuneDisabledGuard } from '../services/featureFlag.js';
import { loadStrategicProfile, upsertStrategicProfile } from '../services/strategicProfile.js';
import { upsertProfileFields, saveUserBazi } from '../services/profileWrites.js';

export async function profileRoutes(app: FastifyInstance) {
  // 建档问卷（运营可配，首登动态渲染）
  app.get('/survey', async () => {
    const qs = await prisma.surveyQuestion.findMany({ where: { enabled: true }, orderBy: { sort: 'asc' } });
    return qs.map((q) => ({ key: q.key, title: q.title, options: q.optionsJson }));
  });

  // 读取企业档案
  app.get('/profile', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const p = await prisma.profile.findFirst({ where: { tenantId: user.tenantId }, orderBy: { updatedAt: 'desc' } });
    return p ? { industry: p.industry, stage: p.stage, pain: p.pain, extra: p.extraJson } : null;
  });

  // 首登 30 秒建档 / 更新档案
  app.put<{ Body: { industry?: string; stage?: string; pain?: string; extra?: object } }>(
    '/profile',
    async (req) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      const existing = await prisma.profile.findFirst({ where: { tenantId: user.tenantId } });
      const p = await upsertProfileFields(user.tenantId, {
        industry: req.body.industry,
        stage: req.body.stage,
        pain: req.body.pain,
        extra: req.body.extra,
      });
      await recordAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: existing ? 'user.profile.update' : 'user.profile.create',
        payload: { industry: p.industry, stage: p.stage, pain: p.pain },
      });
      return { industry: p.industry, stage: p.stage, pain: p.pain };
    },
  );

  // —— 八字采集（M1 PR-2）：录入生辰 → 引擎排盘落库 → 下一轮对话即带【天势档案】 ——
  // hour 传 null/缺省 = 时辰不确定（三柱排盘）；believe=false = 不信命理（只存偏好、跳过排盘，注入降级指令）。
  app.put<{ Body: {
    calendar?: 'solar' | 'lunar';
    year?: number; month?: number; day?: number;
    hour?: number | null; minute?: number;
    gender?: 'male' | 'female';
    birthPlace?: string; longitude?: number;
    believe?: boolean;
  } }>('/profile/bazi', async (req, reply) => {
    if (await fortuneDisabledGuard(reply)) return reply; // P0-2：命理下线 → 排盘/采集 403
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const res = await saveUserBazi(user, req.body ?? {});
    if (!res.ok) return reply.code(400).send({ error: res.error });
    if (!res.believe) {
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.bazi.optout', payload: {} });
      return { believe: false, chart: null };
    }
    await recordAudit({
      tenantId: user.tenantId, userId: user.id, action: 'user.bazi.chart',
      payload: { engine: res.chart.engineVersion, hourKnown: res.chart.hourKnown, trueSolar: res.chart.trueSolarApplied },
    });
    return { believe: true, chart: res.chart };
  });

  // 我的命盘（前端命盘页/建档回显）
  app.get('/profile/chart', async (req, reply) => {
    if (await fortuneDisabledGuard(reply)) return reply; // P0-2：命理下线 → 命盘 403
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const p = await prisma.profile.findFirst({ where: { tenantId: user.tenantId }, orderBy: { updatedAt: 'desc' } });
    const bazi = (p?.extraJson as { bazi?: object } | null)?.bazi ?? null;
    return { bazi, chart: await loadChart(user.id) };
  });

  // —— 战略档案（M1 PR-3）：读取 + 手动校准（镜子要能被老板改） ——
  app.get('/profile/strategic', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return { strategic: await loadStrategicProfile(user.id) };
  });

  app.put<{ Body: { mainContradiction?: string; positioning?: string; track?: string; stage?: string; narrative?: string; verse?: string } }>(
    '/profile/strategic',
    async (req) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      const pick = (v?: string) => (typeof v === 'string' ? v.trim().slice(0, 300) : undefined);
      await upsertStrategicProfile({
        tenantId: user.tenantId,
        userId: user.id,
        patch: {
          mainContradiction: pick(req.body?.mainContradiction),
          positioning: pick(req.body?.positioning),
          track: pick(req.body?.track),
          stage: pick(req.body?.stage)?.slice(0, 60),
          narrative: pick(req.body?.narrative)?.slice(0, 500),
          verse: pick(req.body?.verse)?.slice(0, 40),
        },
      });
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.strategic.update', payload: {} });
      return { strategic: await loadStrategicProfile(user.id) };
    },
  );
}
