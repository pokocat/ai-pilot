import { useEffect, useRef, useState } from 'react';
import { store, subscribe } from '../services/store';

type Store = typeof store;

/**
 * 订阅全局 store。
 * - 无参 `useStore()`：store 任意变化都重渲染（与历史一致，零行为变更）。
 * - `useStore(selector, isEqual?)`（P2-16）：仅当选中切片变化（默认 Object.is）时才重渲染，
 *   避免「任意 emit 全量重渲染」。按组件渐进采用：返回基础类型/稳定引用的 selector 收益最大。
 * 实现用 force 计数 + 选中值缓存（非 useSyncExternalStore），不会因不稳定 snapshot 触发无限渲染；
 * 对象型 selector 在默认 Object.is 下退化为「每次 emit 重渲染」（无收益但绝不漏更新，安全）。
 */
export function useStore(): Store;
export function useStore<T>(selector: (s: Store) => T, isEqual?: (a: T, b: T) => boolean): T;
export function useStore<T>(selector?: (s: Store) => T, isEqual: (a: T, b: T) => boolean = Object.is): Store | T {
  const [, force] = useState(0);
  const selRef = useRef(selector); selRef.current = selector;
  const eqRef = useRef(isEqual); eqRef.current = isEqual;
  const valRef = useRef<T>();
  const hasVal = useRef(false);
  if (selector && !hasVal.current) { valRef.current = selector(store); hasVal.current = true; }
  useEffect(() => {
    const unsub = subscribe(() => {
      const sel = selRef.current;
      if (!sel) { force((n) => n + 1); return; } // 无参：任意变化都重渲染
      const next = sel(store);
      if (!hasVal.current || !eqRef.current(valRef.current as T, next)) {
        valRef.current = next; hasVal.current = true;
        force((n) => n + 1);
      }
    });
    return () => { unsub(); }; // 修复历史类型错误：cleanup 返回 void（subscribe 返回的是 () => boolean）
  }, []);
  return selector ? (valRef.current as T) : store;
}
