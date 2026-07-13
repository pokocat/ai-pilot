import Taro from '@tarojs/taro';
import { api, type WechatSubscribeChoice, type WechatSubscribeScene, type WechatSubscribeStatus } from './api';

function normalizeStatus(v: unknown): WechatSubscribeStatus {
  if (v === 'accept' || v === 'reject' || v === 'ban' || v === 'filter') return v;
  return 'reject';
}

export async function requestWechatSubscribe(scene: WechatSubscribeScene): Promise<boolean> {
  if (process.env.TARO_ENV !== 'weapp') {
    Taro.showToast({ title: '请在微信小程序内订阅提醒', icon: 'none' });
    return false;
  }
  const cfg = await api.wechatSubscribeTemplates();
  const tpl = cfg.scenes.find((s) => s.scene === scene);
  if (!tpl) {
    Taro.showToast({ title: '提醒模板尚未配置', icon: 'none' });
    return false;
  }
  // entityIds 是 Taro Option 类型的必填字段，仅支付宝小程序场景使用；微信侧无意义但类型要求必填，传空数组即可。
  const res = await Taro.requestSubscribeMessage({ tmplIds: [tpl.templateId], entityIds: [] });
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
