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
    Taro.showToast({ title: scene === 'review' ? '已订阅一次复盘提醒' : '已订阅一次报告提醒', icon: 'none' });
    return true;
  }
  Taro.showToast({ title: choice.status === 'ban' ? '请先在微信设置里允许订阅消息' : '未订阅提醒', icon: 'none' });
  return false;
}
