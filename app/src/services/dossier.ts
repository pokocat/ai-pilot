import Taro from '@tarojs/taro';
import { getToken } from './token';
import { IS_MOCK } from './config';
import { request } from './api';
import type { Deliverable } from '../../../shared/contracts';

// 战略案卷 · PR-EX 执行闭环落库：
// 「认可方案 → 案卷 → 今日军令 → 打卡 → 数据回填 → 复盘」的数据源已切到服务端
// （POST /casefile/accept 等，按用户行级隔离，换设备不丢）；mock 模式沿用本地 storage 实现。
// 老用户首次进入时会把本地案卷一次性导入服务端（服务端幂等，已有案卷则跳过）。
// 军令内容全部来自用户认可的真实成果或用户手动录入，不预置任何业务结论。

export interface DossierOrder {
  id: string;
  text: string;
  from: string;        // 来源军师名（如 军师 / 增长操盘手）
  tag: string;         // 军令类别徽标（如 军令 · 增长）
  date: string;        // YYYY-MM-DD（属于哪一天的军令）
  done: boolean;
  aligned?: boolean | null; // 是否对齐主要矛盾（服务端标注；本地/手动为 null）
}

export interface DailyBackfill {
  leads: string;       // 线索
  consults: string;    // 咨询
  deals: string;       // 成交
  savedAt?: string;
}

export interface Dossier {
  id: string;
  title: string;        // 案卷名（来自认可的方案标题）
  sourceAgent: string;  // 认可时的军师
  createdAt: string;
  updatedAt: string;
  judgment: string;     // 方案首段判断（真实成果内容）
  risks: string[];      // 「现在不能做」：从认可方案中提取的风险/禁区条目
  orders: DossierOrder[];
  backfill: Record<string, DailyBackfill>; // 按日期
}

const KEY_PREFIX = 'junshi.dossier.';
const MIGRATED_PREFIX = 'junshi.dossier.migrated.';

function storageKey(): string {
  return `${KEY_PREFIX}${getToken() || 'guest'}`;
}

export function today(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function normalizeOrderText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

// ============ 本地 storage 实现（mock 模式数据源 + 服务端迁移来源） ============

function loadLocal(): Dossier | null {
  try {
    const raw = Taro.getStorageSync(storageKey());
    if (!raw) return null;
    return typeof raw === 'string' ? (JSON.parse(raw) as Dossier) : (raw as Dossier);
  } catch {
    return null;
  }
}

function saveLocal(d: Dossier) {
  d.updatedAt = new Date().toISOString();
  try { Taro.setStorageSync(storageKey(), JSON.stringify(d)); } catch { /* noop */ }
}

// 从认可的成果中提取「可执行动作」：优先取标题含 行动/动作/下一步/清单/计划/建议 的分节列表，
// 兜底取任意列表分节；最多 3 条作为今日军令。（与服务端 services/casefile.ts 同一套启发式）
function extractOrders(d: Deliverable): { text: string }[] {
  const actionHint = /行动|动作|下一步|清单|计划|建议|怎么做|7 ?天|30 ?天/;
  const listSections = d.sections.filter((s) => s.list && s.list.length);
  const preferred = listSections.filter((s) => actionHint.test(s.h));
  const source = (preferred.length ? preferred : listSections).flatMap((s) => s.list || []);
  const seen = new Set<string>();
  return source
    .map(normalizeOrderText)
    .filter(Boolean)
    .filter((text) => {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    })
    .slice(0, 3)
    .map((text) => ({ text }));
}

// 「现在不能做」：取标题含 风险/不能/不要/避免/禁 的分节内容。
function extractRisks(d: Deliverable): string[] {
  const riskHint = /风险|不能|不要|避免|禁|红线/;
  const out: string[] = [];
  d.sections.forEach((s) => {
    if (!riskHint.test(s.h)) return;
    if (s.list?.length) out.push(...s.list);
    else if (s.b) out.push(s.b);
  });
  return out.slice(0, 3);
}

// 方案首段正文作为案卷主判断。
function firstJudgment(d: Deliverable): string {
  const withBody = d.sections.find((s) => s.b);
  return withBody?.b || d.title || '';
}

function acceptLocal(deliverable: Deliverable, agentName: string): { dossier: Dossier; newOrders: number; skippedOrders: number } {
  const now = new Date().toISOString();
  const existing = loadLocal();
  const date = today();
  const existingKeys = new Set((existing?.orders || []).map((o) => `${o.date}\0${normalizeOrderText(o.text)}`));
  const orders = extractOrders(deliverable).filter((o) => {
    const key = `${date}\0${normalizeOrderText(o.text)}`;
    if (existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  }).map((o, i) => ({
    id: `${Date.now()}-${i}`,
    text: o.text,
    from: agentName,
    tag: `军令 · ${agentName}`,
    date,
    done: false,
  }));
  const dossier: Dossier = existing
    ? {
        ...existing,
        title: deliverable.title || existing.title,
        sourceAgent: agentName,
        judgment: firstJudgment(deliverable) || existing.judgment,
        risks: extractRisks(deliverable).length ? extractRisks(deliverable) : existing.risks,
        orders: [...orders, ...existing.orders],
      }
    : {
        id: `dossier-${Date.now()}`,
        title: deliverable.title || '战略案卷',
        sourceAgent: agentName,
        createdAt: now,
        updatedAt: now,
        judgment: firstJudgment(deliverable),
        risks: extractRisks(deliverable),
        orders,
        backfill: {},
      };
  saveLocal(dossier);
  return { dossier, newOrders: orders.length, skippedOrders: extractOrders(deliverable).length - orders.length };
}

// ============ 服务端实现（server 模式） ============

type CasefileRes = { casefile: Dossier | null; newOrders?: number; skippedOrders?: number; imported?: boolean };

// 一次性迁移：服务端还没有案卷、且本地存有旧案卷 → 导入（服务端幂等）。
async function migrateLocalIfNeeded(): Promise<Dossier | null> {
  const token = getToken();
  if (!token) return null;
  const flagKey = `${MIGRATED_PREFIX}${token}`;
  try {
    if (Taro.getStorageSync(flagKey)) return null;
  } catch { /* noop */ }
  const local = loadLocal();
  if (!local) {
    try { Taro.setStorageSync(flagKey, '1'); } catch { /* noop */ }
    return null;
  }
  const r = await request<CasefileRes>('/casefile/import', 'POST', { dossier: local });
  try { Taro.setStorageSync(flagKey, '1'); } catch { /* noop */ }
  return r.casefile;
}

// ============ 页面使用的异步接口（mock/server 同一口径） ============

/** 拉取当前案卷（server 模式含一次性本地迁移；未登录/失败返回 null）。 */
export async function refreshDossier(): Promise<Dossier | null> {
  if (IS_MOCK) return loadLocal();
  if (!getToken()) return null;
  try {
    const r = await request<CasefileRes>('/casefile');
    if (r.casefile) return r.casefile;
    return await migrateLocalIfNeeded();
  } catch {
    return null;
  }
}

/** 认可方案 → 生成/更新案卷 + 拆今日军令。 */
export async function acceptDeliverable(
  deliverable: Deliverable,
  agentName: string,
): Promise<{ dossier: Dossier | null; newOrders: number; skippedOrders: number }> {
  if (IS_MOCK) return acceptLocal(deliverable, agentName);
  const r = await request<CasefileRes>('/casefile/accept', 'POST', { deliverable, agentName });
  return { dossier: r.casefile, newOrders: r.newOrders ?? 0, skippedOrders: r.skippedOrders ?? 0 };
}

export async function toggleOrder(orderId: string): Promise<Dossier | null> {
  if (IS_MOCK) {
    const d = loadLocal();
    if (!d) return null;
    d.orders = d.orders.map((o) => (o.id === orderId ? { ...o, done: !o.done } : o));
    saveLocal(d);
    return d;
  }
  const r = await request<CasefileRes>(`/casefile/orders/${orderId}`, 'PATCH', {});
  return r.casefile;
}

/** 用户手动补一条今日军令（自己的安排也是真实数据）。 */
export async function addOrder(text: string): Promise<Dossier | null> {
  const normalized = normalizeOrderText(text);
  if (!normalized) return refreshDossier();
  if (IS_MOCK) {
    const d = loadLocal();
    if (!d) return d;
    const date = today();
    if (!d.orders.some((o) => o.date === date && normalizeOrderText(o.text) === normalized)) {
      d.orders = [{ id: `${Date.now()}-m`, text: normalized, from: '我', tag: '军令 · 自定', date, done: false }, ...d.orders];
    }
    saveLocal(d);
    return d;
  }
  const r = await request<CasefileRes>('/casefile/orders', 'POST', { text: normalized });
  return r.casefile;
}

export async function removeOrder(orderId: string): Promise<Dossier | null> {
  if (IS_MOCK) {
    const d = loadLocal();
    if (!d) return null;
    d.orders = d.orders.filter((o) => o.id !== orderId);
    saveLocal(d);
    return d;
  }
  const r = await request<CasefileRes>(`/casefile/orders/${orderId}`, 'DELETE');
  return r.casefile;
}

export async function saveBackfill(values: DailyBackfill): Promise<Dossier | null> {
  if (IS_MOCK) {
    const d = loadLocal();
    if (!d) return null;
    d.backfill[today()] = { ...values, savedAt: new Date().toISOString() };
    saveLocal(d);
    return d;
  }
  const r = await request<CasefileRes>('/casefile/backfill', 'PUT', values);
  return r.casefile;
}

/** 发起复盘（M2 PR-8）：落一条复盘账（服务端快照当日军令/回填事实），返回连续复盘天数。
 *  mock 模式无复盘账本，返回 null；失败静默（不阻塞进入复盘对话）。 */
export async function startReview(layer: 'day' | 'week' | 'month' = 'day'): Promise<number | null> {
  if (IS_MOCK || !getToken()) return null;
  try {
    const r = await request<{ streak: number }>('/casefile/review', 'POST', { layer });
    return r.streak;
  } catch {
    return null;
  }
}

// ============ 纯函数（对已加载的案卷做视图计算，页面口径不变） ============

export function ordersOf(d: Dossier | null, date: string): DossierOrder[] {
  return d ? d.orders.filter((o) => o.date === date) : [];
}

export function pendingOrdersOf(d: Dossier | null, date: string): DossierOrder[] {
  return ordersOf(d, date).filter((o) => !o.done);
}

export function doneOrdersOf(d: Dossier | null, date: string): DossierOrder[] {
  return ordersOf(d, date).filter((o) => o.done);
}

// 近 7 天军令（周计划视图：按日期倒序分组）
export function recentOrders(d: Dossier | null, days = 7): { date: string; orders: DossierOrder[] }[] {
  if (!d) return [];
  const map = new Map<string, DossierOrder[]>();
  d.orders.forEach((o) => {
    if (!map.has(o.date)) map.set(o.date, []);
    map.get(o.date)!.push(o);
  });
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, days)
    .map(([date, orders]) => ({ date, orders }));
}

export function todayProgress(d: Dossier | null): { total: number; done: number; percent: number } {
  const orders = ordersOf(d, today());
  const done = orders.filter((o) => o.done).length;
  return { total: orders.length, done, percent: orders.length ? Math.round((done / orders.length) * 100) : 0 };
}

// 组装「今日复盘」的对话开场：带上真实军令完成情况与回填数据，交给经营参谋生成复盘。
export function buildReviewPrompt(d: Dossier | null): string {
  const date = today();
  const orders = ordersOf(d, date);
  const bf = d?.backfill[date];
  const lines: string[] = [`帮我做 ${date} 的执行复盘。`];
  if (d) lines.push(`当前案卷：《${d.title}》。`);
  if (orders.length) {
    lines.push('今日军令完成情况：');
    orders.forEach((o) => lines.push(`- [${o.done ? '已完成' : '未完成'}] ${o.text}`));
  } else {
    lines.push('今天没有生成军令。');
  }
  if (bf && (bf.leads || bf.consults || bf.deals)) {
    lines.push(`今天记录的数据：线索 ${bf.leads || 0}，咨询 ${bf.consults || 0}，成交 ${bf.deals || 0}。`);
  } else {
    lines.push('今天还没有记录数据。');
  }
  lines.push('请判断今天的主要问题，并给出明天的 1-3 条军令。');
  return lines.join('\n');
}
