import { useState } from 'react';
import Taro from '@tarojs/taro';
import { IS_WEAPP } from '../services/config';

// 出图分享的统一管道（送你一卦 / 天时日历 / 方案库 / 成果卡 / 每日战报卡共用）。
//
// 为什么要收敛：这五处此前各写各的「守卫 → showLoading → 出图 → 预览 → catch toast」，
// 其中只有两处做了 IS_WEAPP 守卫。缺守卫的两处（gift / calendar）在 H5 下必然 reject——
// taro-h5 的 selectorQuery.fields({node:true}) 需要 nodeCanvasType 才回填 res.node，
// renderCardToImage 直接抛「canvas 未就绪」，用户只看到一句泛化的「生成失败，请重试」。
//
// 口径：小程序里「分享」只有三种成立形态——转发小程序卡片（openType=share）、
// 出图让用户发朋友圈/好友、站内可分享页。复制一条 http 链接不成立（小程序内打不开、
// 朋友圈也不接受粘贴链接），所以凡是要把内容给出去的场景，走本 hook 出图。

export interface ShareImageOptions {
  /** canvasId，页内屏外 <Canvas type="2d" id={canvasId}> 必须用它 */
  canvasId: string;
  /** 出图时的 loading 文案 */
  loadingTitle?: string;
  /** 非小程序环境（H5/开发者预览）的提示 */
  unsupportedTip?: string;
  /** 出图失败提示 */
  failTip?: string;
}

export interface ShareImageState {
  /** 已出图的临时路径；'' = 未出图，用它决定要不要挂 <SharePreview> */
  path: string;
  /** 出图中，用来锁按钮避免连点 */
  busy: boolean;
  /** 触发出图：内部已含环境守卫 / loading / 失败提示，**永不抛** */
  make: () => Promise<void>;
  /** 收起预览层 */
  close: () => void;
}

/**
 * @param render 拿到 canvasId 自己决定画什么、多高，返回临时图片路径
 *               （内部一律用 renderCardToImage / makeReportShareImage）。
 */
export function useShareImage(
  render: (canvasId: string) => Promise<string>,
  opts: ShareImageOptions,
): ShareImageState {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);

  const make = async () => {
    if (busy) return;
    // H5 没有小程序 canvas 2d 节点，出图必失败——在入口就说清楚，别让用户等一圈再看到泛化报错。
    if (!IS_WEAPP) {
      Taro.showToast({ title: opts.unsupportedTip ?? '请在小程序内生成分享图', icon: 'none' });
      return;
    }
    setBusy(true);
    Taro.showLoading({ title: opts.loadingTitle ?? '生成分享图…' });
    try {
      const p = await render(opts.canvasId);
      Taro.hideLoading();
      setPath(p);
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: opts.failTip ?? '生成失败，请重试', icon: 'none' });
    } finally {
      setBusy(false);
    }
  };

  return { path, busy, make, close: () => setPath('') };
}
