// 统一的「取一份后台数据」hook——替掉旧版散落 32 处的 `.catch(() => {})`。
//
// 旧写法的真实危害：请求 500 / 网络断了，页面渲染成「暂无数据」，与「真的没有数据」
// 长得一模一样。运营在排查线上事故时看到「近 30 天暂无订单」，会当成业务结论上报，
// 而实际是接口挂了。运营后台在出事时说谎，比没有这块屏更糟。
//
// 现在：区分 loading / error / empty 三态，错误可重试，并记录数据取回时刻（页头显示
// 「刚刚更新」），让运营知道自己看的是不是新鲜数据。

import { useCallback, useEffect, useRef, useState } from 'react';
import { isForbidden } from './api';

/** PageHead 等只读消费者用的窄接口——不含 setData，避免 Resource<T> 因入参逆变而无法赋给 Resource<unknown>。 */
export interface ResourceStatus {
  loading: boolean;
  reload: () => void;
  updatedAt: number;
}

export interface Resource<T> extends ResourceStatus {
  data: T | null;
  /** 空串 = 无错误 */
  error: string;
  /** 错误是 403「权限不足」而不是「加载失败」：登录态好着，文案该说去要授权，重试也没用 */
  forbidden: boolean;
  /** 首次加载中（无任何数据）——用于骨架屏；刷新时为 false，避免整页闪回骨架 */
  initial: boolean;
  /** 就地替换数据（操作返回了新快照时省掉一次往返） */
  setData: (next: T) => void;
}

/**
 * @param fetcher 取数函数。**必须**用 useCallback 或写成不依赖闭包变量的形式，
 *                否则每次渲染都是新函数、会无限重取。deps 变化才重取。
 */
export function useResource<T>(fetcher: () => Promise<T>, deps: readonly unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(0);
  // 递增请求号：只接受最后一次请求的结果，避免快速切筛选时旧响应盖掉新响应。
  const reqId = useRef(0);
  const alive = useRef(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    const my = ++reqId.current;
    setLoading(true);
    fetcher()
      .then((v) => {
        if (!alive.current || my !== reqId.current) return;
        setData(v);
        setError('');
        setForbidden(false);
        setUpdatedAt(Date.now());
      })
      .catch((e: unknown) => {
        if (!alive.current || my !== reqId.current) return;
        // 401 已由 api.req 广播 admin:unauth 切登录页，这里不再抛错误态（否则登录页背后闪一屏红字）。
        if ((e as { code?: string })?.code === 'ADMIN_UNAUTHORIZED') return;
        // 403 不是掉线：登录态保留，就地渲染成「需要授权」（旧版连它一起踢回登录页）。
        setForbidden(isForbidden(e));
        setError((e as Error)?.message || '加载失败');
      })
      .finally(() => {
        if (!alive.current || my !== reqId.current) return;
        setLoading(false);
      });
    // fetcher 由调用方用 useCallback 稳定；deps 决定何时重取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const replace = useCallback((next: T) => { setData(next); setUpdatedAt(Date.now()); }, []);

  return { data, error, forbidden, loading, initial: loading && data === null, reload, updatedAt, setData: replace };
}

/** 「刚刚 / 3 分钟前」——页头的数据新鲜度标记。 */
export function freshness(updatedAt: number, now = Date.now()): string {
  if (!updatedAt) return '';
  const sec = Math.round((now - updatedAt) / 1000);
  if (sec < 45) return '刚刚更新';
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`;
  return `${Math.round(sec / 3600)} 小时前`;
}
