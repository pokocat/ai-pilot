// 克隆类动作的钻石计价 —— 创建数字人 / 训练声音的单价真源。
//
// ★ 为什么不写在端上：本仓库铁律是「会影响真实用户的对外数据（定价/权益）归运营后台，
//   代码不许 seed、不许当真相源」。端上硬编码价格，运营在后台改完就被下一次发版打回，
//   而且改价要等发版 + 审核。所以端上只负责显示，数字一律从 GET /video/clone-pricing 取。
//
// 持久化选型与海报成品图（services/creative/config.ts）完全一致：复用现成的 FeatureFlag 单行
// （id='video-clone-pricing'），`payload` 承载四档单价。理由同上游那份注释：不新增 prisma 模型、
// 复用已有的 60s 读缓存 + 写时失效、与其它运营开关同一心智。
import { featureFlagPayload, setFeatureFlagPayload } from '../featureFlag.js';

export const CLONE_PRICING_FLAG_ID = 'video-clone-pricing';

/**
 * 四档单价 + 「这些数字是不是运营配过的」。
 *
 * `configured=false` 意味着运营还没在后台配过，当前用的是代码兜底价。
 *
 * ⚠️ 消费方**只有运营后台**（admin/src/views/settings.tsx：据此显示「首次核定」还是「修改」）。
 * 小程序全仓没有一处读它 —— 所以运营核定前后，用户看到的价长得一模一样，而且照扣。
 * 别在注释里把它写成「端上据此把口径说软一点」：今天不成立，写了就是又一处言实不符。
 * 要么给端上真的加个消费点，要么就承认它是后台专用字段。
 */
export type ClonePricing = {
  /** 新训练一条专属声音。供应商侧最贵的单次动作（16AI 一条音色 8000+ 算力）。 */
  voiceCreate: number;
  /**
   * 重训已有声音。**供应商免费（每条 4 次）不等于我方免费** ——
   * 上传/存储/审核/编排成本照付，所以按低价收，而不是收 0。
   * 它必须明显便宜于 voiceCreate，否则用户没有动力走这条省供应商权益的路径。
   */
  voiceRetrain: number;
  /** 上传视频训练数字人。 */
  avatarVideo: number;
  /** 单张图片训练数字人。成本远低于视频训练，作为低成本入口，价格必须低于 avatarVideo。 */
  avatarImage: number;
  configured: boolean;
};

export type CloneAction = 'voiceCreate' | 'voiceRetrain' | 'avatarVideo' | 'avatarImage';

/**
 * 代码侧兜底价 —— **只是「运营还没配」时的保守默认，不是定价真源**，也绝不写回数据库。
 *
 * TODO(定价待运营核定)：这四个数字没有商务结论，2026-08-13 由内测临时给定，正式开量前必须由运营
 * 在后台按真实成本与毛利定死。其中 avatarImage 对应的「图片训练数字人」在军师端尚未接通
 * （上游 ShiliuGateway.cloneAvatarByImage 才刚落地），它的价格来源完全待定，属于**占位**，
 * 不要当成任何形式的承诺。
 */
const FALLBACK: Omit<ClonePricing, 'configured'> = {
  voiceCreate: 200,
  voiceRetrain: 60,
  avatarVideo: 200,
  avatarImage: 100,
};

/** 单价上限。挡住误输入（多打一个 0）把用户余额一次清空。 */
export const CLONE_PRICE_MAX = 1_000_000;

/**
 * 四档的中文名。两处用途：
 * ① 服务端错误文案 —— 让 422 说得出是哪一档不合法，而不是笼统一句「参数错误」；
 * ② 钻石流水的 reason —— 用户在账单里要能看懂这笔扣的是什么，而不是一串英文枚举。
 */
export const CLONE_ACTION_LABELS: Record<CloneAction, string> = {
  voiceCreate: '新建专属声音',
  voiceRetrain: '重训已有声音',
  avatarVideo: '视频训练数字人',
  avatarImage: '图片训练数字人',
};

const ACTIONS: CloneAction[] = ['voiceCreate', 'voiceRetrain', 'avatarVideo', 'avatarImage'];

/** 后台写入非法（路由转 422）。 */
export class ClonePricingInvalidError extends Error {
  statusCode = 422;
  code = 'CLONE_PRICING_INVALID';
}

/**
 * 单价取整到非负整数。
 * **0 是合法配置**（运营有权把某一档设成免费做活动），只有负数 / 非数字 / 越界才回落兜底。
 *
 * ⚠️ 只用于**读**：库里被写脏时 C 端必须还能拿到一组能用的数字，回落兜底是对的。
 * 写入口不许用它 —— 见 assertPrice。
 */
function price(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > CLONE_PRICE_MAX) return fallback;
  return Math.round(n);
}

/**
 * 写入口的单价校验：非法值**抛错**，绝不静默回落。
 *
 * 为什么读和写两套口径：`price()` 的回落语义搬到写入口就成了「保存成功，价格没变」——
 * 运营填了个 -1 或 2000000，接口回 200、回包里还是旧价，页面一刷新数字又对了，
 * 于是他以为改过了。改价是营收动作，这种静默失败要用一次看得见的保存失败换掉
 * （同 creative/config.ts 的 assertVisualSize：把「配得下去、跑起来悄悄坏掉」变成保存失败）。
 */
function assertPrice(key: CloneAction, value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > CLONE_PRICE_MAX) {
    throw new ClonePricingInvalidError(
      `「${CLONE_ACTION_LABELS[key]}」的单价必须是 0 到 ${CLONE_PRICE_MAX} 之间的数字（0 = 该档免费）`,
    );
  }
  return Math.round(n);
}

/** 读运营配置；任一档缺失或非法即回落兜底，并把 configured 标成 false。 */
export async function clonePricing(opts: { fresh?: boolean } = {}): Promise<ClonePricing> {
  const raw = (await featureFlagPayload(CLONE_PRICING_FLAG_ID, opts)) as Record<string, unknown> | null;
  const payload = raw ?? {};
  // 「配过」的判据是四档都给了合法数值：半份配置比没配更危险 —— 运营会以为自己配好了，
  // 实际上另外两档还在用兜底价。
  const configured = ACTIONS.every((key) => {
    const n = typeof payload[key] === 'number' ? (payload[key] as number) : Number(payload[key]);
    return Number.isFinite(n) && n >= 0 && n <= CLONE_PRICE_MAX;
  });
  return {
    voiceCreate: price(payload.voiceCreate, FALLBACK.voiceCreate),
    voiceRetrain: price(payload.voiceRetrain, FALLBACK.voiceRetrain),
    avatarVideo: price(payload.avatarVideo, FALLBACK.avatarVideo),
    avatarImage: price(payload.avatarImage, FALLBACK.avatarImage),
    configured,
  };
}

/** 取某一档的实际扣费额。端上不做价格算术，要哪一档就问哪一档。 */
export function cloneCost(pricing: ClonePricing, action: CloneAction): number {
  return pricing[action];
}

/** 下发给端上的形状。带 configured，端上才能区分「运营配过」与「用的兜底价」。 */
export function clonePricingView(pricing: ClonePricing): ClonePricing {
  return {
    voiceCreate: pricing.voiceCreate,
    voiceRetrain: pricing.voiceRetrain,
    avatarVideo: pricing.avatarVideo,
    avatarImage: pricing.avatarImage,
    configured: pricing.configured,
  };
}

/**
 * 后台写入（PUT /admin/video/clone-pricing 的落库口径）。只认显式给出的键，未给的保持原值。
 *
 * 两条守则，都是为了让 `configured=true` 这个标记名副其实：
 *
 * ① **非法值抛 422，不静默回落**（assertPrice）。改价是营收动作，"保存成功但没改上"不可接受。
 *
 * ② **首次配置必须四档一起给**。`current` 在未配置时读到的是 FALLBACK —— 那四个数字带着
 *    `TODO(定价待运营核定)`，没有商务结论，avatarImage 更是纯占位（图片训练数字人还没接到军师）。
 *    若允许只改一档就落库，另外三档会被这次写入一起变成「运营配过的价」，等于用一次改价
 *    给三个占位数字盖了章 —— 而 `configured` 恰恰是端上判断「这价能不能当承诺」的唯一依据。
 *    已配置之后再改单档是安全的：那时 `current` 里的每一档都已被运营核定过。
 */
export async function updateClonePricing(patch: Partial<Omit<ClonePricing, 'configured'>>): Promise<ClonePricing> {
  const current = await clonePricing({ fresh: true });
  if (!current.configured) {
    const missing = ACTIONS.filter((key) => patch[key] === undefined);
    if (missing.length) {
      throw new ClonePricingInvalidError(
        `首次配置克隆定价必须四档一起提交，当前缺少：${missing.map((k) => CLONE_ACTION_LABELS[k]).join('、')}。`
        + '（未提交的档位会沿用代码兜底价，而那几个数字尚未经运营核定，不能就这样变成线上定价。）',
      );
    }
  }
  const next = {} as Omit<ClonePricing, 'configured'>;
  for (const key of ACTIONS) {
    next[key] = patch[key] === undefined ? current[key] : assertPrice(key, patch[key]);
  }
  await setFeatureFlagPayload(CLONE_PRICING_FLAG_ID, next);
  // 四档都是刚校验过的合法值，回读必然 configured=true —— 这里直接置位不是臆断。
  return { ...next, configured: true };
}
