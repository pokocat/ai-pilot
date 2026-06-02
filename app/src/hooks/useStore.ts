import { useEffect, useState } from 'react';
import { store, subscribe } from '../services/store';

/** 订阅全局 store，store 变化时触发组件重渲染。 */
export function useStore() {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  return store;
}
