import Taro from '@tarojs/taro';
import { api, getUserId, type WechatSubscribeChoice, type WechatSubscribeScene, type WechatSubscribeStatus } from './api';

function normalizeStatus(v: unknown): WechatSubscribeStatus {
  if (v === 'accept' || v === 'reject' || v === 'ban' || v === 'filter') return v;
  return 'reject';
}

// 模板配置缓存。微信要求 requestSubscribeMessage 由点击手势直接唤起：点击后若先 await 一次网络请求
// 再调用，真机上手势上下文已丢失，弹窗静默不出（fail can only be invoked by user TAP gesture）。
// 故配置预热进缓存，命中时 requestSubscribeMessage 在首个 await 之前同步发出，手势上下文得以保留。
let tplCache: { scene: WechatSubscribeScene; templateId: string }[] | null = null;

// 授权成功回执：三场景各自口径（payment=下单付款后的一次到账回执）。
const ACCEPT_TOAST: Record<WechatSubscribeScene, string> = {
  review: '已订阅一次复盘提醒',
  report: '已订阅一次报告提醒',
  payment: '已订阅一次到账提醒',
};

/** 预热模板配置（登录后调用；失败静默——授权时会退回即时拉取）。 */
export async function prefetchWechatSubscribeTemplates(): Promise<void> {
  if (process.env.TARO_ENV !== 'weapp' || !getUserId() || tplCache) return;
  try {
    tplCache = (await api.wechatSubscribeTemplates()).scenes.map((s) => ({ scene: s.scene, templateId: s.templateId }));
  } catch {
    /* 静默：订阅授权时再拉 */
  }
}

export async function requestWechatSubscribe(scene: WechatSubscribeScene): Promise<boolean> {
  if (process.env.TARO_ENV !== 'weapp') {
    Taro.showToast({ title: '请在微信小程序内订阅提醒', icon: 'none' });
    return false;
  }
  // 缓存命中：不 await，手势上下文内直接唤起弹窗。未命中才退回即时拉取（顺带补热缓存）。
  let tpl = tplCache?.find((s) => s.scene === scene);
  if (!tpl) {
    // ⚠️ 走到这里这一次授权**大概率已经废了**：下面的 await 会吃掉点击手势上下文，
    // 微信随后拒 requestSubscribeMessage（can only be invoked by user TAP gesture），
    // 弹窗不出、不留记录、调用方 catch 一吞就彻底无痕——2026-07-31 真机实测就是这么丢掉
    // 全部 payment 授权的（新用户启动时未登录 → app.tsx 的预热空转 → 缓存恒 null）。
    // 现在 store.afterLogin 也会预热，正常路径不该再落到这里；真落到了就明确留痕，
    // 并且仍然把模板拉回来补热缓存——用户下一次点击就能正常弹窗。
    console.warn(`[subscribe] 模板缓存未命中（scene=${scene}），本次授权可能因手势上下文丢失而静默失败；已补热缓存，下次点击可正常唤起`);
    const scenes = (await api.wechatSubscribeTemplates()).scenes.map((s) => ({ scene: s.scene, templateId: s.templateId }));
    tplCache = scenes;
    tpl = scenes.find((s) => s.scene === scene);
  }
  if (!tpl) {
    Taro.showToast({ title: '提醒模板尚未配置', icon: 'none' });
    return false;
  }
  const res = await Taro.requestSubscribeMessage({ tmplIds: [tpl.templateId] } as any);
  const choice: WechatSubscribeChoice = {
    scene,
    templateId: tpl.templateId,
    status: normalizeStatus((res as Record<string, unknown>)[tpl.templateId]),
  };
  await api.recordWechatSubscription([choice]);
  if (choice.status === 'accept') {
    Taro.showToast({ title: ACCEPT_TOAST[scene] ?? '已订阅一次提醒', icon: 'none' });
    return true;
  }
  Taro.showToast({ title: choice.status === 'ban' ? '请先在微信设置里允许订阅消息' : '未订阅提醒', icon: 'none' });
  return false;
}
