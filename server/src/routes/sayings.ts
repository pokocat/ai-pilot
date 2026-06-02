import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

// 每日一句话献策：按日期确定性取一条已启用条目（每天一换），对齐原型 SAYINGS 逻辑。
export async function sayingRoutes(app: FastifyInstance) {
  app.get('/sayings/today', async () => {
    const all = await prisma.saying.findMany({ where: { enabled: true }, orderBy: { sort: 'asc' } });
    if (!all.length) return { text: '先把自己<em>立于不败</em>，再等对手露出破绽。', date: fmtToday() };
    const now = new Date();
    const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
    const pick = all[dayOfYear % all.length];
    // 记录推送日期（计入触达可在此扩展）
    await prisma.saying.update({ where: { id: pick.id }, data: { pushedDate: ymd(now) } }).catch(() => {});
    return { text: pick.text, date: fmtToday() };
  });
}

function fmtToday(): string {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
