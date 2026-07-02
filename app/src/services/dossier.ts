import Taro from '@tarojs/taro';
import { getToken } from './token';
import type { Deliverable } from '../../../shared/contracts';

// 战略案卷 · 前端本地实现（执行闭环的第一版承接）。
// 「认可方案 → 案卷 → 今日军令 → 打卡 → 数据回填 → 复盘」先在前端跑通：
// 数据按登录用户隔离存本地 storage；后端建模（任务/回填/提醒）就绪后整体切 api，页面口径不变。
// 注意：军令内容全部来自用户认可的真实成果或用户手动录入，不预置任何业务结论。

export interface DossierOrder {
  id: string;
  text: string;
  from: string;        // 来源军师名（如 军师 / 增长操盘手）
  tag: string;         // 军令类别徽标（如 军令 · 增长）
  date: string;        // YYYY-MM-DD（属于哪一天的军令）
  done: boolean;
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

function storageKey(): string {
  return `${KEY_PREFIX}${getToken() || 'guest'}`;
}

export function today(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function loadDossier(): Dossier | null {
  try {
    const raw = Taro.getStorageSync(storageKey());
    if (!raw) return null;
    return typeof raw === 'string' ? (JSON.parse(raw) as Dossier) : (raw as Dossier);
  } catch {
    return null;
  }
}

function save(d: Dossier) {
  d.updatedAt = new Date().toISOString();
  try { Taro.setStorageSync(storageKey(), JSON.stringify(d)); } catch { /* noop */ }
}

// 从认可的成果中提取「可执行动作」：优先取标题含 行动/动作/下一步/清单/计划/建议 的分节列表，
// 兜底取任意列表分节；最多 3 条作为今日军令。
function extractOrders(d: Deliverable): { text: string }[] {
  const actionHint = /行动|动作|下一步|清单|计划|建议|怎么做|7 ?天|30 ?天/;
  const listSections = d.sections.filter((s) => s.list && s.list.length);
  const preferred = listSections.filter((s) => actionHint.test(s.h));
  const source = (preferred.length ? preferred : listSections).flatMap((s) => s.list || []);
  return source.slice(0, 3).map((text) => ({ text }));
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

// 认可方案 → 生成/更新案卷。同一案卷持续累积军令；新方案覆盖判断与风险。
export function acceptDeliverable(deliverable: Deliverable, agentName: string): Dossier {
  const now = new Date().toISOString();
  const existing = loadDossier();
  const orders = extractOrders(deliverable).map((o, i) => ({
    id: `${Date.now()}-${i}`,
    text: o.text,
    from: agentName,
    tag: `军令 · ${agentName}`,
    date: today(),
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
  save(dossier);
  return dossier;
}

// 方案首段正文作为案卷主判断。
function firstJudgment(d: Deliverable): string {
  const withBody = d.sections.find((s) => s.b);
  return withBody?.b || d.title || '';
}

export function toggleOrder(orderId: string): Dossier | null {
  const d = loadDossier();
  if (!d) return null;
  d.orders = d.orders.map((o) => (o.id === orderId ? { ...o, done: !o.done } : o));
  save(d);
  return d;
}

// 用户手动补一条今日军令（自己的安排也是真实数据）。
export function addOrder(text: string): Dossier | null {
  const d = loadDossier();
  if (!d || !text.trim()) return d;
  d.orders = [{
    id: `${Date.now()}-m`,
    text: text.trim(),
    from: '我',
    tag: '军令 · 自定',
    date: today(),
    done: false,
  }, ...d.orders];
  save(d);
  return d;
}

export function removeOrder(orderId: string): Dossier | null {
  const d = loadDossier();
  if (!d) return null;
  d.orders = d.orders.filter((o) => o.id !== orderId);
  save(d);
  return d;
}

export function saveBackfill(values: DailyBackfill): Dossier | null {
  const d = loadDossier();
  if (!d) return null;
  d.backfill[today()] = { ...values, savedAt: new Date().toISOString() };
  save(d);
  return d;
}

export function ordersOf(d: Dossier | null, date: string): DossierOrder[] {
  return d ? d.orders.filter((o) => o.date === date) : [];
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
    lines.push(`今日数据回填：线索 ${bf.leads || 0}，咨询 ${bf.consults || 0}，成交 ${bf.deals || 0}。`);
  } else {
    lines.push('今日数据未回填。');
  }
  lines.push('请判断今天的主要问题，并给出明天的 1-3 条军令。');
  return lines.join('\n');
}
