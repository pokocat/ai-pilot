import type { DecisionView } from './api';

/**
 * 从决策账本里挑「现在最该验证的那一条」——军情页的决策日志卡与军令页复盘的决策验证卡共用。
 *
 * 为什么不直接 `items.find(d => d.status === 'pending')`：
 * `DecisionLedger.items` 的顺序不在契约里。真实服务端是 `orderBy: { seq: 'desc' }`（最新在前），
 * mock 返回的是插入顺序（最旧在前）——同一份代码在本地走查和线上会挑中不同的记录。
 * 所以这里显式排序，不依赖传输层顺序。
 *
 * 排序口径按「能不能现在验」来定，而不是按新旧：
 *   1. 有验证日的排在没有验证日的前面——今天刚下的决策还没到可验证的时候，先催它没意义；
 *   2. 验证日早的在前（已过期的自然排最前，那才是真拖着的那条）；
 *   3. 都没有验证日时按 seq 倒序兜底（拿最新的一条）。
 */
export function pickDecisionToVerify(items: DecisionView[] | undefined | null): DecisionView | null {
  const pending = (items ?? []).filter((d) => d.status === 'pending');
  if (!pending.length) return null;
  return pending.slice().sort((a, b) => {
    const da = a.verifyByDate;
    const db = b.verifyByDate;
    if (da && db) return da < db ? -1 : da > db ? 1 : b.seq - a.seq;
    if (da) return -1; // 有验证日的优先
    if (db) return 1;
    return b.seq - a.seq; // 都没有验证日 → 最新的一条
  })[0];
}
