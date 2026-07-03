import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { computeAndStoreChart, loadChart } from '../services/paipan.js';
import { loadStrategicProfile, upsertStrategicProfile } from '../services/strategicProfile.js';
import { cityLongitude } from '../data/cityLongitude.js';
import { now } from '../services/clock.js';

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
      const data = {
        industry: req.body.industry,
        stage: req.body.stage,
        pain: req.body.pain,
        extraJson: req.body.extra ?? undefined,
      };
      const p = existing
        ? await prisma.profile.update({ where: { id: existing.id }, data })
        : await prisma.profile.create({ data: { ...data, tenantId: user.tenantId } });
      // 同步租户行业/阶段
      await prisma.tenant.update({
        where: { id: user.tenantId },
        data: { industry: p.industry ?? undefined, stage: p.stage ?? undefined },
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
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const b = req.body ?? {};
    const believe = b.believe !== false;

    // 先落偏好（含不信命理开关），排盘失败也不丢采集
    const existing = await prisma.profile.findFirst({ where: { tenantId: user.tenantId } });
    const extra = { ...((existing?.extraJson as object) ?? {}), bazi: { ...b, believe } };
    if (existing) await prisma.profile.update({ where: { id: existing.id }, data: { extraJson: extra } });
    else await prisma.profile.create({ data: { tenantId: user.tenantId, extraJson: extra } });

    if (!believe) {
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.bazi.optout', payload: {} });
      return { believe: false, chart: null };
    }

    // 校验（排盘输入必须完整合法；日期合法性由历法库把关）
    const yearNum = Number(b.year); const monthNum = Number(b.month); const dayNum = Number(b.day);
    if (b.calendar !== 'solar' && b.calendar !== 'lunar') return reply.code(400).send({ error: '历法必须是 solar 或 lunar' });
    if (b.gender !== 'male' && b.gender !== 'female') return reply.code(400).send({ error: '缺少性别' });
    if (!Number.isInteger(yearNum) || yearNum < 1920 || yearNum > now().getFullYear()) return reply.code(400).send({ error: '出生年份不合法' });
    if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 31) return reply.code(400).send({ error: '出生日期不合法' });
    if (!Number.isInteger(monthNum) || Math.abs(monthNum) < 1 || Math.abs(monthNum) > 12 || (monthNum < 0 && b.calendar !== 'lunar')) {
      return reply.code(400).send({ error: '出生月份不合法' });
    }
    const hourKnown = b.hour !== null && b.hour !== undefined;
    if (hourKnown && (!Number.isInteger(Number(b.hour)) || Number(b.hour) < 0 || Number(b.hour) > 23)) {
      return reply.code(400).send({ error: '时辰不合法（0-23，或不填表示不确定）' });
    }
    try {
      const chart = await computeAndStoreChart({
        tenantId: user.tenantId,
        userId: user.id,
        input: {
          calendar: b.calendar, year: yearNum, month: monthNum, day: dayNum,
          hour: hourKnown ? Number(b.hour) : null, minute: b.minute ?? 0,
          gender: b.gender, birthPlace: b.birthPlace,
          // 经度：显式传入优先；否则按出生城市查映射表（未命中不做真太阳时校正）
          longitude: b.longitude ?? cityLongitude(b.birthPlace),
        },
        targetYear: now().getFullYear(),
      });
      await recordAudit({
        tenantId: user.tenantId, userId: user.id, action: 'user.bazi.chart',
        payload: { engine: chart.engineVersion, hourKnown: chart.hourKnown, trueSolar: chart.trueSolarApplied },
      });
      return { believe: true, chart };
    } catch {
      return reply.code(400).send({ error: '生辰无法排盘，请检查日期是否存在（如农历大小月/闰月）' });
    }
  });

  // 我的命盘（前端命盘页/建档回显）
  app.get('/profile/chart', async (req) => {
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
