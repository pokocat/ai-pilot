import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { dayOfYear, dateKey, monthDayCn } from '../services/clock.js';

// 每日一句话献策：按日期确定性取一条已启用条目（每天一换），对齐原型 SAYINGS 逻辑。
// 日历派生（一年中第几天 / 推送日期 / 展示日期）一律走 Asia/Shanghai（P1-4）。
export async function sayingRoutes(app: FastifyInstance) {
  app.get('/sayings/today', async () => {
    const all = await prisma.saying.findMany({ where: { enabled: true }, orderBy: { sort: 'asc' } });
    if (!all.length) return { text: '先把自己<em>立于不败</em>，再等对手露出破绽。', date: monthDayCn() };
    const pick = all[dayOfYear() % all.length];
    // 记录推送日期（计入触达可在此扩展）
    await prisma.saying.update({ where: { id: pick.id }, data: { pushedDate: dateKey() } }).catch(() => {});
    return { text: pick.text, date: monthDayCn() };
  });
}
