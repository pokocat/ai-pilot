// 回归测试：React 18 StrictMode 下 useResource 不能把整个后台钉死在骨架屏。
//
// 根因（2026-09-02 走查发现）：这里原先写的是
//   const alive = useRef(true);
//   useEffect(() => () => { alive.current = false; }, []);
// 只在卸载时置 false、从不置回 true。而 React 18 的 StrictMode 开发模式会对每个组件
// 跑一遍 mount → cleanup → mount：第一次 mount 的 cleanup 把 alive.current 永久烧成
// false，第二次 mount 起的请求回来后，.then / .catch / .finally 三个分支全被
// `if (!alive.current) return` 丢掉——data 永远是 null、loading 永远是 true。
// 于是 `npm run dev` 下每一个页面都停在骨架屏，而 `npm run build` 出来的生产包（无
// StrictMode 双跑）一切正常。这类「只有开发环境坏」的 bug 最贵：运营后台的人会以为是
// 接口挂了去查服务端，或者干脆改用生产环境调试。
//
// 现在改成每次取数各带一个局部 cancelled 标记（由该次 effect 自己的 cleanup 置位），
// 天然对「同一组件被反复 mount」免疫；跨请求的「只认最后一次结果」仍由 reqId 保证。
//
// 这个文件没有 jsdom，用一层薄薄的 DOM 垫片跑真实的 react-dom/client + StrictMode——
// 手写一个假的 hook 运行时只会验证那个假运行时，验证不了 React 真实的双跑时序。
//   cd admin && npm test
import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode } from 'react';
import { useResource, freshness } from './useResource.js';
import type { Resource } from './useResource.js';

/* ────────────── 最小 DOM 垫片 ──────────────
   react-dom/client 挂载一棵只渲染 null 的树时，实际只用到：容器的 nodeType /
   ownerDocument / 增删子节点、document.activeElement（提交前保存选区）、
   window.HTMLIFrameElement（getActiveElementDeep 的 instanceof）。够用即可。 */
interface FakeNode { nodeType: number; parentNode: FakeNode | null }

function makeEl(tag: string): any {
  const el: any = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    childNodes: [] as FakeNode[],
    firstChild: null as FakeNode | null,
    lastChild: null as FakeNode | null,
    parentNode: null as FakeNode | null,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    appendChild(c: any) {
      el.childNodes.push(c);
      c.parentNode = el;
      el.firstChild = el.childNodes[0];
      el.lastChild = c;
      return c;
    },
    insertBefore(c: any) {
      el.childNodes.unshift(c);
      c.parentNode = el;
      el.firstChild = el.childNodes[0];
      return c;
    },
    removeChild(c: any) {
      el.childNodes = el.childNodes.filter((x: FakeNode) => x !== c);
      c.parentNode = null;
      el.firstChild = el.childNodes[0] ?? null;
      el.lastChild = el.childNodes[el.childNodes.length - 1] ?? null;
      return c;
    },
  };
  Object.defineProperty(el, 'ownerDocument', { get: () => doc });
  return el;
}

const doc: any = {
  nodeType: 9,
  createElement: makeEl,
  createTextNode: (t: string) => ({ nodeType: 3, nodeValue: t, parentNode: null }),
  addEventListener() {},
  removeEventListener() {},
};
doc.documentElement = makeEl('html');
doc.body = makeEl('body');
doc.activeElement = doc.body;
Object.defineProperty(doc, 'ownerDocument', { get: () => doc });

class FakeIframeElement {}
const win: any = {
  document: doc,
  HTMLIFrameElement: FakeIframeElement,
  addEventListener() {},
  removeEventListener() {},
};
doc.defaultView = win;
(globalThis as unknown as { document: unknown }).document = doc;
(globalThis as unknown as { window: unknown }).window = win;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ────────────── 挂载工具 ────────────── */
type Act = (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: typeof import('react-dom/client').createRoot;
let act: Act;

before(async () => {
  // 动态 import：必须等上面的垫片装好再让 react-dom 求值。
  ({ createRoot } = await import('react-dom/client'));
  const react = React as unknown as { act?: Act };
  act = react.act ?? ((await import('react-dom/test-utils')) as unknown as { act: Act }).act;
});

/** 手动兑现的 promise——测试自己决定「接口什么时候回来」。 */
function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface Mounted<T> {
  /** 最近一次渲染拿到的 resource（读 data / loading / error / initial） */
  res: () => Resource<T>;
  /** 改一次筛选条件 → 触发 deps 变化重取 */
  setDep: (v: string) => Promise<void>;
  flush: () => Promise<void>;
  unmount: () => Promise<void>;
}

/**
 * 在 StrictMode 里挂一个只调用 useResource 的组件。
 * @param fetcher 收到当前 dep 值，返回该次请求的 promise（测试用 defer 控制兑现时机）
 */
async function mountInStrictMode<T>(fetcher: (dep: string) => Promise<T>, dep0 = ''): Promise<Mounted<T>> {
  const sink: { current: Resource<T> | null } = { current: null };
  let setDepExternal: ((v: string) => void) | null = null;

  function Probe(): null {
    const [dep, setDep] = React.useState(dep0);
    setDepExternal = setDep;
    const run = React.useCallback(() => fetcher(dep), [dep]);
    sink.current = useResource<T>(run, [dep]);
    return null;
  }

  const container = makeEl('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(StrictMode, null, React.createElement(Probe)));
  });

  const flush = async (): Promise<void> => { await act(async () => {}); };
  return {
    res: () => {
      assert.ok(sink.current, '组件还没渲染过');
      return sink.current;
    },
    setDep: async (v) => { await act(async () => { setDepExternal?.(v); }); },
    flush,
    unmount: async () => { await act(async () => { root.unmount(); }); },
  };
}

describe('useResource · React 18 StrictMode 双跑后仍要拿到数据', () => {
  let errors: unknown[][];
  let origError: typeof console.error;

  beforeEach(() => {
    errors = [];
    origError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); };
  });
  afterEach(() => { console.error = origError; });

  test('mount → cleanup → mount 之后，请求结果必须落到 UI，而不是永远停在骨架屏', async () => {
    const calls: Array<{ resolve: (v: string) => void }> = [];
    const m = await mountInStrictMode<string>(() => {
      const d = defer<string>();
      calls.push(d);
      return d.promise;
    });

    // StrictMode 的双跑：effect 被 setup → cleanup → setup，取数发了两次。
    assert.equal(calls.length, 2, 'StrictMode 应该让取数 effect 跑两次（不是这个数说明垫片/环境不对，测试无效）');
    assert.equal(m.res().initial, true, '还没回数据前是首屏骨架');

    for (const c of calls) c.resolve('青州战报');
    await m.flush();

    // 修复前：alive.current 被第一次 cleanup 永久置 false，这三条全挂。
    assert.equal(m.res().data, '青州战报', '双跑之后数据必须渲染出来');
    assert.equal(m.res().loading, false, 'loading 必须落回 false，否则整页永远骨架屏');
    assert.equal(m.res().initial, false);
    assert.equal(m.res().error, '');
    assert.ok(m.res().updatedAt > 0, '数据新鲜度时刻要记上，页头才有「刚刚更新」');
    await m.unmount();
  });

  test('双跑下的失败请求要报错误态，不能退化成「暂无数据」', async () => {
    const calls: Array<{ reject: (e: unknown) => void }> = [];
    const m = await mountInStrictMode<string>(() => {
      const d = defer<string>();
      calls.push(d);
      return d.promise;
    });

    for (const c of calls) c.reject(Object.assign(new Error('数据库连接超时'), { status: 500 }));
    await m.flush();

    assert.equal(m.res().error, '数据库连接超时');
    assert.equal(m.res().forbidden, false);
    assert.equal(m.res().loading, false);
    assert.equal(m.res().data, null);
    await m.unmount();
  });

  test('双跑下的 403 仍要认成「权限不足」而不是「加载失败」', async () => {
    const calls: Array<{ reject: (e: unknown) => void }> = [];
    const m = await mountInStrictMode<string>(() => {
      const d = defer<string>();
      calls.push(d);
      return d.promise;
    });

    for (const c of calls) c.reject(Object.assign(new Error('这一步需要超级管理员权限'), { status: 403, code: 'OWNER_ONLY' }));
    await m.flush();

    assert.equal(m.res().forbidden, true);
    assert.equal(m.res().error, '这一步需要超级管理员权限');
    await m.unmount();
  });

  test('reqId 语义不能丢：慢的旧请求晚回，不许盖掉新筛选的结果', async () => {
    const calls: Array<{ dep: string; resolve: (v: string) => void }> = [];
    const m = await mountInStrictMode<string>((dep) => {
      const d = defer<string>();
      calls.push({ dep, resolve: d.resolve });
      return d.promise;
    }, '近 7 天');

    assert.equal(calls.length, 2); // StrictMode 双跑
    await m.setDep('近 30 天');
    assert.equal(calls.length, 3, '筛选变了要重取');

    // 新请求先回。
    calls[2].resolve('近 30 天的单子');
    await m.flush();
    assert.equal(m.res().data, '近 30 天的单子');

    // 旧筛选的两个慢响应姗姗来迟——不能把页面打回上一个筛选的数据。
    calls[0].resolve('近 7 天的单子');
    calls[1].resolve('近 7 天的单子');
    await m.flush();
    assert.equal(m.res().data, '近 30 天的单子', '旧响应盖掉新响应 = 运营看到的是上一个筛选的数字');
    await m.unmount();
  });

  test('真正卸载之后到货的响应不再写状态（React 不该报警）', async () => {
    const calls: Array<{ resolve: (v: string) => void }> = [];
    const m = await mountInStrictMode<string>(() => {
      const d = defer<string>();
      calls.push(d);
      return d.promise;
    });

    await m.unmount();
    for (const c of calls) c.resolve('迟到的战报');
    await new Promise((r) => setTimeout(r, 0));

    assert.deepEqual(errors, [], `卸载后写状态会被 React 报出来：${JSON.stringify(errors)}`);
  });
});

describe('freshness · 页头的数据新鲜度', () => {
  test('45 秒内算「刚刚」，再往上换分钟 / 小时', () => {
    const now = 1_756_000_000_000;
    assert.equal(freshness(0, now), '');
    assert.equal(freshness(now - 10_000, now), '刚刚更新');
    assert.equal(freshness(now - 120_000, now), '2 分钟前');
    assert.equal(freshness(now - 7_200_000, now), '2 小时前');
  });
});
