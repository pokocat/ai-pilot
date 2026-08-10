// 点兵 PC 的纯 Web 适配层：只重导出 dossier 真接口，并放两个无宿主依赖的日期助手。
// 单独放文件是为了让 exec.tsx 不误引 Taro 页面代码，也便于脚本测试数据源边界。
export {
  addOrder, buildReviewPrompt, ordersOf, recentOrders, refreshDossier, removeOrder, saveBackfill,
  saveGoals, setOrderResult, startReview, today, todayProgress, toggleOrder,
} from '../../services/dossier';
export type { DailyBackfill, Dossier, DossierOrder } from '../../services/dossier';
export { apiSaveBizMetrics as saveBizMetrics };

import { api } from '../../services/api';

export function thisMonday(): string {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function apiSaveBizMetrics(weekStart: string, metrics: Record<string, number>) {
  return api.saveBizMetrics(weekStart, metrics);
}
