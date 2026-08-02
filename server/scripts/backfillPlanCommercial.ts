// 为存量套餐补齐稳定商业标识与用户侧用量档位。默认只预览；加 --apply 才写库。
// 不改价格、额度、权益、上下架，只根据当前真实配置归组并生成迁移初值，最终可在运营后台复核。
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

function familyName(name: string): string {
  return name.replace(/[·\s]*(月付|年付)$/u, '').trim() || name.trim();
}

async function main() {
  // Plan 没有 createdAt；用业务排序 + 主键做稳定次排序，确保 dry-run/apply 输出一致。
  const plans = await prisma.plan.findMany({ orderBy: [{ sort: 'asc' }, { id: 'asc' }] });
  if (!plans.length) {
    console.log('没有套餐，无需回填。');
    return;
  }
  const families = new Map<string, typeof plans>();
  for (const plan of plans) {
    const key = plan.planFamilyKey?.trim() || familyName(plan.name);
    const rows = families.get(key) ?? [];
    rows.push(plan);
    families.set(key, rows);
  }
  const paidFamilies = [...families.entries()]
    .filter(([, rows]) => rows.some((p) => p.price >= 0 && !p.hidden))
    .sort(([, a], [, b]) => Math.max(...a.map((p) => p.tokenQuotaPerMonth)) - Math.max(...b.map((p) => p.tokenQuotaPerMonth)));
  const baseline = paidFamilies.find(([, rows]) => rows.some((p) => p.tokenQuotaPerMonth > 0))?.[1]
    .find((p) => p.tokenQuotaPerMonth > 0)?.tokenQuotaPerMonth ?? 0;
  const rankByFamily = new Map(paidFamilies.map(([key], index) => [key, index + 1]));

  const changes = [...families.entries()].flatMap(([key, rows]) => {
    const quota = Math.max(...rows.map((p) => p.tokenQuotaPerMonth));
    const enterprise = rows.some((p) => p.price < 0);
    const ratio = baseline > 0 ? quota / baseline : 0;
    const level = enterprise ? 'custom' : ratio >= 20 ? '20x' : ratio >= 5 ? '5x' : ratio === 1 ? 'standard' : 'custom';
    const label = enterprise ? '专属用量' : level === 'standard' ? '标准用量' : level === '5x' ? '5x 用量' : level === '20x' ? '20x 用量' : '进阶用量';
    const rank = enterprise ? 999 : (rankByFamily.get(key) ?? 0);
    return rows.map((plan) => ({ plan, data: {
      planFamilyKey: plan.planFamilyKey?.trim() || key,
      tierRank: plan.tierRank ?? rank,
      usageLevel: plan.usageLevel?.trim() || level,
      usageLabel: plan.usageLabel?.trim() || label,
    } }));
  });

  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} 套餐商业字段回填，共 ${changes.length} 条`);
  for (const { plan, data } of changes) console.log(`- ${plan.name}: family=${data.planFamilyKey}, tier=${data.tierRank}, usage=${data.usageLabel}`);
  if (!APPLY) {
    console.log('这是试运行，确认归组后加 --apply 执行。');
    return;
  }
  await prisma.$transaction(changes.map(({ plan, data }) => prisma.plan.update({ where: { id: plan.id }, data })));
  console.log('回填完成。请在运营后台复核档位与用户侧用量名称。');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
