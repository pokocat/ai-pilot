import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { now } from './clock.js';
import { getAccessToken } from './wechat.js';
import type {
  WechatSubscribeChoice,
  WechatSubscribeScene,
  WechatSubscribeTemplate,
  WechatSubscribeTemplatesResult,
} from '../../../shared/contracts';

const SCENE_META: Record<WechatSubscribeScene, { title: string; description: string; env: string[] }> = {
  review: {
    title: '复盘提醒',
    description: '21:30 提醒记录今日结果并做复盘',
    env: ['WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID', 'WECHAT_REVIEW_TEMPLATE_ID'],
  },
  report: {
    title: '报告生成',
    description: '重要报告生成完成后提醒查看',
    env: ['WECHAT_SUBSCRIBE_REPORT_TEMPLATE_ID', 'WECHAT_REPORT_TEMPLATE_ID'],
  },
};

function envFirst(keys: string[]): string {
  for (const k of keys) {
    const v = (process.env[k] || '').trim();
    if (v) return v;
  }
  return '';
}

export function templateIdForScene(scene: WechatSubscribeScene): string {
  return envFirst(SCENE_META[scene].env);
}

export function wechatSubscribeTemplates(): WechatSubscribeTemplatesResult {
  const scenes = (Object.keys(SCENE_META) as WechatSubscribeScene[])
    .map((scene): WechatSubscribeTemplate | null => {
      const templateId = templateIdForScene(scene);
      if (!templateId) return null;
      return { scene, templateId, title: SCENE_META[scene].title, description: SCENE_META[scene].description };
    })
    .filter(Boolean) as WechatSubscribeTemplate[];
  return { scenes };
}

export async function recordWechatSubscribeChoices(args: {
  tenantId: string;
  userId: string;
  choices: WechatSubscribeChoice[];
}): Promise<{ accepted: number }> {
  let accepted = 0;
  for (const c of args.choices) {
    if (!SCENE_META[c.scene]) continue;
    const expectedTemplateId = templateIdForScene(c.scene);
    if (!expectedTemplateId || c.templateId !== expectedTemplateId) continue;
    const isAccept = c.status === 'accept';
    if (isAccept) accepted += 1;
    await prisma.wechatSubscription.upsert({
      where: { userId_scene_templateId: { userId: args.userId, scene: c.scene, templateId: c.templateId } },
      update: {
        status: c.status,
        ...(isAccept ? { remaining: { increment: 1 }, acceptedAt: now() } : {}),
      },
      create: {
        tenantId: args.tenantId,
        userId: args.userId,
        scene: c.scene,
        templateId: c.templateId,
        status: c.status,
        remaining: isAccept ? 1 : 0,
        acceptedAt: isAccept ? now() : null,
      },
    });
  }
  return { accepted };
}

export async function hasWechatSubscriptionQuota(userId: string, scene: WechatSubscribeScene): Promise<boolean> {
  const templateId = templateIdForScene(scene);
  if (!templateId) return false;
  const sub = await prisma.wechatSubscription.findFirst({
    where: { userId, scene, templateId, status: 'accept', remaining: { gt: 0 } },
    select: { id: true },
  });
  return !!sub;
}

export async function hasSentWechatNotificationToday(userId: string, scene: WechatSubscribeScene): Promise<boolean> {
  const d = now();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const found = await prisma.wechatNotificationLog.findFirst({
    where: { userId, scene, status: 'sent', createdAt: { gte: dayStart } },
    select: { id: true },
  });
  return !!found;
}

function clip(v: string, max: number): string {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  return Array.from(s || '军师提醒').slice(0, max).join('');
}

function timeValue(d = now()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function miniprogramState(): 'developer' | 'trial' | 'formal' {
  const v = (process.env.WECHAT_SUBSCRIBE_STATE || process.env.WECHAT_MINIPROGRAM_STATE || 'formal').trim();
  return v === 'developer' || v === 'trial' ? v : 'formal';
}

function pageForScene(scene: WechatSubscribeScene, opts: { reportId?: string | null } = {}): string {
  if (scene === 'report' && opts.reportId) return `packages/work/report/index?id=${encodeURIComponent(opts.reportId)}`;
  if (scene === 'report') return 'packages/work/library/index';
  return 'pages/studio/index';
}

function dataForScene(scene: WechatSubscribeScene, opts: { title: string; note?: string }) {
  if (scene === 'report') {
    return {
      thing1: { value: clip(opts.title, 20) },
      phrase2: { value: '已生成' },
      time3: { value: timeValue() },
      thing4: { value: clip(opts.note || '点击查看报告', 20) },
    };
  }
  return {
    thing1: { value: clip(opts.title || '今晚复盘提醒', 20) },
    time2: { value: timeValue() },
    thing3: { value: clip(opts.note || '记录今日结果，调整明天军令', 20) },
  };
}

async function postWechatSubscribe(payload: object): Promise<{ errcode?: number; errmsg?: string }> {
  const token = await getAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return (await res.json()) as { errcode?: number; errmsg?: string };
  } finally {
    clearTimeout(timer);
  }
}

async function logNotification(args: {
  tenantId: string;
  userId: string;
  scene: WechatSubscribeScene;
  templateId?: string | null;
  title: string;
  status: 'sent' | 'failed' | 'skipped';
  reason?: string;
  payload?: Prisma.InputJsonValue;
}) {
  await prisma.wechatNotificationLog.create({
    data: {
      tenantId: args.tenantId,
      userId: args.userId,
      scene: args.scene,
      templateId: args.templateId ?? null,
      title: clip(args.title, 80),
      status: args.status,
      reason: args.reason ?? null,
      payloadJson: args.payload ?? undefined,
      sentAt: args.status === 'sent' ? now() : null,
    },
  });
}

export async function sendWechatSubscribeMessage(args: {
  tenantId: string;
  userId: string;
  scene: WechatSubscribeScene;
  title: string;
  note?: string;
  reportId?: string | null;
  logSkipped?: boolean;
}): Promise<{ sent: boolean; reason?: string }> {
  const templateId = templateIdForScene(args.scene);
  if (!templateId) {
    if (args.logSkipped) await logNotification({ ...args, status: 'skipped', reason: 'template not configured' });
    return { sent: false, reason: 'template not configured' };
  }
  const user = await prisma.user.findUnique({ where: { id: args.userId }, select: { wechatOpenId: true } });
  if (!user?.wechatOpenId) {
    if (args.logSkipped) await logNotification({ ...args, templateId, status: 'skipped', reason: 'wechat openid missing' });
    return { sent: false, reason: 'wechat openid missing' };
  }
  const sub = await prisma.wechatSubscription.findFirst({
    where: { userId: args.userId, scene: args.scene, templateId, status: 'accept', remaining: { gt: 0 } },
    orderBy: { acceptedAt: 'asc' },
  });
  if (!sub) {
    if (args.logSkipped) await logNotification({ ...args, templateId, status: 'skipped', reason: 'no subscription quota' });
    return { sent: false, reason: 'no subscription quota' };
  }

  const payload = {
    touser: user.wechatOpenId,
    template_id: templateId,
    page: pageForScene(args.scene, { reportId: args.reportId }),
    miniprogram_state: miniprogramState(),
    lang: 'zh_CN',
    data: dataForScene(args.scene, { title: args.title, note: args.note }),
  };

  let data: { errcode?: number; errmsg?: string };
  try {
    data = await postWechatSubscribe(payload);
  } catch (err) {
    await logNotification({ ...args, templateId, status: 'failed', reason: (err as Error).message, payload: payload as Prisma.InputJsonValue });
    return { sent: false, reason: (err as Error).message };
  }

  if (data.errcode && data.errcode !== 0) {
    if (data.errcode === 43101) {
      await prisma.wechatSubscription.update({ where: { id: sub.id }, data: { remaining: 0, status: 'reject' } }).catch(() => {});
    }
    const reason = data.errmsg || `wechat errcode ${data.errcode}`;
    await logNotification({ ...args, templateId, status: 'failed', reason, payload: payload as Prisma.InputJsonValue });
    return { sent: false, reason };
  }

  const consumed = await prisma.wechatSubscription.updateMany({
    where: { id: sub.id, remaining: { gt: 0 } },
    data: { remaining: { decrement: 1 }, lastSentAt: now() },
  });
  if (consumed.count === 0) return { sent: false, reason: 'subscription quota consumed' };
  await logNotification({ ...args, templateId, status: 'sent', payload: payload as Prisma.InputJsonValue });
  return { sent: true };
}

export function notifyReportReady(args: {
  tenantId: string;
  userId: string;
  title: string;
  reportId?: string | null;
}): void {
  void sendWechatSubscribeMessage({
    tenantId: args.tenantId,
    userId: args.userId,
    scene: 'report',
    title: args.title || '报告已生成',
    note: '点击查看报告',
    reportId: args.reportId,
  }).catch((err) => console.error('[wechat-subscribe] report notify failed:', (err as Error).message));
}

export function notifyReviewReminder(args: {
  tenantId: string;
  userId: string;
  lastReviewDate?: string | null;
}): void {
  void sendWechatSubscribeMessage({
    tenantId: args.tenantId,
    userId: args.userId,
    scene: 'review',
    title: '今晚复盘提醒',
    note: args.lastReviewDate ? `上次复盘 ${args.lastReviewDate}` : '记录今日结果，调整明天军令',
  }).catch((err) => console.error('[wechat-subscribe] review notify failed:', (err as Error).message));
}
