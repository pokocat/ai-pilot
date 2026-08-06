import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { now, dayStart, dateKey, hhmm } from './clock.js';
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
  payment: {
    title: '支付到账',
    description: '支付成功、权益到账后提醒确认',
    env: ['WECHAT_SUBSCRIBE_PAYMENT_TEMPLATE_ID', 'WECHAT_PAYMENT_TEMPLATE_ID'],
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
  const found = await prisma.wechatNotificationLog.findFirst({
    where: { userId, scene, status: 'sent', createdAt: { gte: dayStart() } }, // 上海时区当日 00:00（P1-4）
    select: { id: true },
  });
  return !!found;
}

function clip(v: string, max: number): string {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  return Array.from(s || '军师提醒').slice(0, max).join('');
}

function timeValue(d = now()): string {
  return `${dateKey(d)} ${hhmm(d)}`; // 上海时区（P1-4）
}

function miniprogramState(): 'developer' | 'trial' | 'formal' {
  const v = (process.env.WECHAT_SUBSCRIBE_STATE || process.env.WECHAT_MINIPROGRAM_STATE || 'formal').trim();
  return v === 'developer' || v === 'trial' ? v : 'formal';
}

function pageForScene(scene: WechatSubscribeScene, opts: { reportId?: string | null } = {}): string {
  if (scene === 'report' && opts.reportId) return `packages/work/report/index?id=${encodeURIComponent(opts.reportId)}`;
  if (scene === 'report') return 'packages/work/library/index';
  if (scene === 'payment') return 'packages/work/credits/index'; // 订单明细页（含支付订单段）
  return 'pages/studio/index';
}

// 模板字段键 = 微信后台该模板的实际关键词编号，对不上整条推送被拒（errcode 47003），且只有
// 事后翻 WechatNotificationLog 才看得出——所以每个 scene 的键都必须对着后台模板逐字核过，
// 不能照别的模板抄。核对方法：微信公众平台 → 订阅消息 → 我的模板 → 详细内容里的 {{thingN.DATA}}。
//
// 三个 scene 的键，2026-07-30 全部对着后台模板详情逐字核过：
//   review （26922「最新分析报告提醒」）：thing2=报告类型 thing3=报告名称 thing5=备注 time6=生成时间
//     ⚠️ 此前发的是 thing1/time2/thing3，与模板完全不符 → 所有借它的推送（早间军令 / 每日复盘 /
//     周复盘 / 久不复盘召回 / 预言到期 / 岁验）在生产恒 47003 拒发，用户一条也收不到。
//     语义映射：category→报告类型（提醒品类）、title→报告名称、note→备注。
//   report （76218「报告生成通知」）：thing1=报告名称 phrase2=生成状态 time3=完成时间 thing4=温馨提示
//     —— 与历史写法恰好一致，这条一直是好的（唯一没坏的一个）。
//   payment（29967「套餐购买成功通知」）：thing1=类型 amount2=金额 thing3=用户 time5=时间 number6=订单号
//     ⚠️ 此前发的 phrase2/time3/thing4 三个键模板里根本不存在，还缺金额/用户/订单号三个位 →
//     支付到账通知同样恒 47003。amount2 是金额类型（币种符号+数字，带 2 位小数）；
//     number6 是数字类型（纯数字，≤32 位）——我们自己的 outTradeNo 形如 js{时间戳}{hex} 带字母，
//     发上去必被拒，故优先用微信自己的 transactionId（全数字，也正是用户在微信账单里看到的那个号），
//     缺失时退化为从 outTradeNo 抽数字。
function dataForScene(scene: WechatSubscribeScene, opts: {
  title: string; note?: string; category?: string; userName?: string; amountFen?: number; orderNo?: string;
}) {
  if (scene === 'payment') {
    return {
      thing1: { value: clip(opts.title, 20) },
      amount2: { value: `¥${((opts.amountFen ?? 0) / 100).toFixed(2)}` },
      thing3: { value: clip(opts.userName || '老板', 20) },
      time5: { value: timeValue() },
      number6: { value: digitsOnly(opts.orderNo) },
    };
  }
  if (scene === 'report') {
    return {
      thing1: { value: clip(opts.title, 20) },
      phrase2: { value: '已生成' },
      time3: { value: timeValue() },
      thing4: { value: clip(opts.note || '点击查看报告', 20) },
    };
  }
  return {
    thing2: { value: clip(opts.category || '军师提醒', 20) },
    thing3: { value: clip(opts.title || '今晚复盘提醒', 20) },
    thing5: { value: clip(opts.note || '记录今日结果，调整明天军令', 20) },
    time6: { value: timeValue() },
  };
}

/** 微信 number 类型只认纯数字（≤32 位）：带字母的单号发上去整条被拒，故抽数字后再发。 */
function digitsOnly(v?: string): string {
  return (String(v || '').replace(/\D/g, '') || '0').slice(0, 32);
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
  category?: string; // review 模板的「报告类型」位（提醒品类）；缺省「军师提醒」
  amountFen?: number; // payment 模板的「金额」位（分）
  orderNo?: string; // payment 模板的「订单号」位；传微信 transactionId 优先（纯数字）
  reportId?: string | null;
  logSkipped?: boolean;
}): Promise<{ sent: boolean; reason?: string; retryable?: boolean }> {
  const templateId = templateIdForScene(args.scene);
  if (!templateId) {
    if (args.logSkipped) await logNotification({ ...args, status: 'skipped', reason: 'template not configured' });
    return { sent: false, reason: 'template not configured', retryable: false };
  }
  const user = await prisma.user.findUnique({ where: { id: args.userId }, select: { wechatOpenId: true, name: true } });
  if (!user?.wechatOpenId) {
    if (args.logSkipped) await logNotification({ ...args, templateId, status: 'skipped', reason: 'wechat openid missing' });
    return { sent: false, reason: 'wechat openid missing', retryable: false };
  }
  const sub = await prisma.wechatSubscription.findFirst({
    where: { userId: args.userId, scene: args.scene, templateId, status: 'accept', remaining: { gt: 0 } },
    orderBy: { acceptedAt: 'asc' },
  });
  if (!sub) {
    if (args.logSkipped) await logNotification({ ...args, templateId, status: 'skipped', reason: 'no subscription quota' });
    return { sent: false, reason: 'no subscription quota', retryable: false };
  }

  // 先原子「认领」一份额度，再调用微信推送——不能反过来（旧实现：先发送、发送成功后才扣减）。
  // 微信推送是不可逆的外部副作用；若像旧实现一样在发送之后才扣减，两个并发请求（如同一用户
  // 短时间内两次触发报告生成）会都通过上面的 findFirst 校验、都真的把消息推给微信（超出用户
  // 实际授权的额度重复打扰），事后扣减时才发现只有一份额度可扣——输掉竞态的一方明明已经调用了
  // 发送接口，却在扣减判定处直接 return（从不调用 logNotification），产生完全不可追溯的「幽灵
  // 推送」。改为发送前先原子扣减（updateMany + where remaining>0）：认领失败＝额度已被并发请求
  // 抢走，直接拒绝、不再调用发送接口；认领成功后发送失败/被拒再退回额度——与全仓
  // reserveCredits/reserveQuota「先预留后结算」惯例一致。
  const claimed = await prisma.wechatSubscription.updateMany({
    where: { id: sub.id, remaining: { gt: 0 } },
    data: { remaining: { decrement: 1 } },
  });
  if (claimed.count === 0) {
    if (args.logSkipped) await logNotification({ ...args, templateId, status: 'skipped', reason: 'no subscription quota' });
    return { sent: false, reason: 'no subscription quota', retryable: false };
  }

  const payload = {
    touser: user.wechatOpenId,
    template_id: templateId,
    page: pageForScene(args.scene, { reportId: args.reportId }),
    miniprogram_state: miniprogramState(),
    lang: 'zh_CN',
    data: dataForScene(args.scene, {
      title: args.title, note: args.note, category: args.category,
      userName: user.name, amountFen: args.amountFen, orderNo: args.orderNo,
    }),
  };

  let data: { errcode?: number; errmsg?: string };
  try {
    data = await postWechatSubscribe(payload);
  } catch (err) {
    await prisma.wechatSubscription.update({ where: { id: sub.id }, data: { remaining: { increment: 1 } } }).catch(() => {});
    await logNotification({ ...args, templateId, status: 'failed', reason: (err as Error).message, payload: payload as Prisma.InputJsonValue });
    return { sent: false, reason: (err as Error).message, retryable: true };
  }

  if (data.errcode && data.errcode !== 0) {
    if (data.errcode === 43101) {
      // 用户单侧永久拒绝：不退回（这份额度本就该清零），直接标记禁用。
      await prisma.wechatSubscription.update({ where: { id: sub.id }, data: { remaining: 0, status: 'reject' } }).catch(() => {});
    } else {
      // 其它失败（限流/参数错误等）：退回已认领的额度，允许下次重试。
      await prisma.wechatSubscription.update({ where: { id: sub.id }, data: { remaining: { increment: 1 } } }).catch(() => {});
    }
    const reason = data.errmsg || `wechat errcode ${data.errcode}`;
    await logNotification({ ...args, templateId, status: 'failed', reason, payload: payload as Prisma.InputJsonValue });
    return { sent: false, reason, retryable: data.errcode !== 43101 };
  }

  await prisma.wechatSubscription.update({ where: { id: sub.id }, data: { lastSentAt: now() } }).catch(() => {});
  await logNotification({ ...args, templateId, status: 'sent', payload: payload as Prisma.InputJsonValue });
  return { sent: true, retryable: false };
}

export function notifyReportReady(args: {
  tenantId: string;
  userId: string;
  title: string;
  reportId?: string | null;
}): Promise<{ sent: boolean; reason?: string; retryable?: boolean }> {
  return sendWechatSubscribeMessage({
    tenantId: args.tenantId,
    userId: args.userId,
    scene: 'report',
    title: args.title || '报告已生成',
    note: '点击查看报告',
    reportId: args.reportId,
  });
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
    category: '复盘提醒',
    title: '今晚复盘提醒',
    note: args.lastReviewDate ? `上次复盘 ${args.lastReviewDate}` : '记录今日结果，调整明天军令',
  }).catch((err) => console.error('[wechat-subscribe] review notify failed:', (err as Error).message));
}
