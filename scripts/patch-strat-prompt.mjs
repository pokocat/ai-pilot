// 报告 V2 · 生产提示词写回脚本 —— 第二轮：组件使用密度铁律 + 三新组件（gauge/matrix/gantt）
// 配套文档：docs/[FABLE5]REPORT_V2_PROMPT_PATCH.md（V6.1 追加修订 · 2026-07-22）
//
// 说明：本脚本取代上一轮「9 型 V2 追加脚本」（git a809916，如仍需补 9 型可从历史取回）。
// 上一轮把 9 型/情绪弧线/文风/称谓/封面 追加进 systemPrompt；本轮在其基础上「按锚点插入」
// 一段《报告组件使用密度铁律》+《三新组件使用时机与字段》，根治「整份报告全是白卡文字墙」。
//
// 做什么：给 strat agent 的 systemPrompt 在锚点处「插入」本轮修订段；若该 agent 有已发布
// 版本快照（publishedVersionId），同步更新快照（C 端实际读快照，两处都改才生效——见 memory 教训）。
//
// 安全设计：
//   - 改前把待改文本原样备份到 /tmp/strat-prompt.backup.<时间戳>.txt（Agent 行）
//     与 /tmp/strat-prompt.backup.<时间戳>.pubver.txt（快照，若有）。
//   - 幂等：检测到本轮标志串（MARKER）则拒绝重复插入。
//   - 锚点缺失兜底：任一 ANCHORS 都找不到时，append 到 prompt 末尾并 console.warn（不静默）。
//   - --dry-run：只打印 diff 摘要（锚点命中情况 / 插入位置 / 新旧长度 / 上下文预览），不写库。
//
// 用法（在生产服务器上，纯 node + @prisma/client，无其它依赖）：
//   scp -i ~/dev/aliyun/aiartist.pem scripts/patch-strat-prompt.mjs ecs-user@8.136.36.175:/tmp/
//   ssh -i ~/dev/aliyun/aiartist.pem ecs-user@8.136.36.175
//   sudo cp /tmp/patch-strat-prompt.mjs /opt/junshi/server/
//   sudo -u junshi node /opt/junshi/server/patch-strat-prompt.mjs --dry-run   # 先看 diff 摘要，不写库
//   sudo -u junshi node /opt/junshi/server/patch-strat-prompt.mjs             # 确认后写库
//
// 注：@prisma/client 走 /opt/junshi/server 已构建产物；本脚本复用 ./dist/db.js 导出的 prisma 实例。
import { writeFileSync } from 'node:fs';
import { prisma } from './dist/db.js';

// 目标 agent（战略军师）。
const KEY = 'strat';

// 幂等标志串：systemPrompt 已含此串则视为本轮已打过，拒绝重复插入。
const MARKER = '组件使用密度铁律';

// 锚点（按优先级尝试，第一个命中者即在其「所在段落」之后插入）。
// 均取自上一轮修订稿/线上 V6.0 成果规范里较稳定的措辞。以线上实际文本为准；
// 全部落空时兜底 append 到 prompt 末尾（见下方 console.warn）。
const ANCHORS = [
  '情绪弧线',          // 上一轮「二、情绪弧线…」段，密度铁律是其自然延伸，插在其后语义最顺
  '军师手书',          // letter 收尾说明
  '封面（可选',        // 上一轮「六、封面…」段
  '封面',              // 最宽松兜底锚点
];

// —— 待插入正文（可直接粘入 prompt；与文档 V6.1 节逐字一致）——
const PATCH_TEXT = `

【报告${MARKER} · 2026-07-22】
（本节与前文任何关于成果排版、section 选型、报告篇幅的说明冲突时，一律以本节为准。目的：根治「整份报告全是白卡文字墙」。）

七、组件使用密度铁律（硬约束，逐条照做）：
1. 每一章至少放 1 个非白卡组件（stats / table / roster / phases / timeline / gauge / matrix / gantt / callout 任一）。纯 {h,b} 白卡只能做补充说明，不能当主力。
2. 连续白卡不得超过 2 张。写到第 3 段还没上富组件，就把它改成 table / stats / callout 之一。
3. 凡报告里出现成组的数字（家底、规模、指标、评分、占比），必须进 stats 或 table 或 gauge，不许散在正文里用文字罗列。
4. 凡涉及 90 天 / 季度 / 多阶段排期，「先做什么再做什么、各占多久」这类带工期长度的时间安排，必须用 gantt 泳道条画出来；不要再用竖排 timeline 或 table 表达排期。timeline 只留给「里程碑叙事」——几个关键节点的意义与提醒，不承载工期长度。
5. 凡做体检、诊断、打分、健康度评估，必须开 gauge：总分进主盘，各维度进分项横条。不要用纯文字说「这块打 70 分」。
6. 凡涉及 SWOT、优劣势、机会威胁、四类取舍、优先级 / 风险分格，必须用 matrix 四象限承载，不要用 table 或 list 硬凑。

八、三个新组件（gauge / matrix / gantt）的使用时机与字段：

- 体检 / 诊断 / 健康度打分 → gauge（评分盘）：总分放 score（0–100），各维度放 items（每项 label + score，note 写一句人话点评），verdict 是一句总评。
  示例：{"type":"gauge","h":"拾叶经营体检","score":72,"verdict":"底子稳，就是太偏科","items":[{"label":"现金流","score":84,"note":"4 家旺店撑着，短期不慌。"},{"label":"门店质量","score":58,"note":"12 家里有 4 家在亏，拉低整盘。"},{"label":"组织梯队","score":61,"note":"能独当一面的只有林砚一个，断层明显。"},{"label":"品牌势能","score":80,"note":"七年口碑是最值钱的家当。"}]}

- SWOT / 取舍 / 优先级 / 风险分格 → matrix（四象限）：quads 恰 4 个，顺序左上→右上→左下→右下；xLabels / yLabels 标两轴两端；每象限 title + items[]，可给 tone 上语义色。
  示例（经典 SWOT）：{"type":"matrix","h":"出城前的家底盘点","xLabels":["内部","外部"],"yLabels":["有利","不利"],"quads":[{"title":"优势","tone":"机会","items":["七年口碑，老客认账","城西两家店月月盈利，现金稳"]},{"title":"机会","tone":"时机","items":["青州新城开街，头两年租金减半","同城对手还没出省"]},{"title":"劣势","tone":"风险","items":["能独当一面的只有林砚一人","4 家亏损店拖现金"]},{"title":"威胁","tone":"布局","items":["外埠水土不服，首店若败伤士气","供应链拉长，品控难盯"]}]}

- 90 天 / 多阶段排期、作战地图 → gantt（甘特泳道条）：unit 选 周 / 旬 / 月，rows 每条 label + from / to 起止刻度（含），tone 上语义色，note 补一句；total 缺省取最大 to。
  示例（90 天出城排期，按旬）：{"type":"gantt","h":"出城 90 天作战地图","unit":"旬","total":9,"rows":[{"label":"止血：4 家亏损店定去留","from":1,"to":2,"tone":"风险","note":"先砍掉最吃利润的两家。"},{"label":"理账：划出出城现金 600 万","from":1,"to":3,"tone":"行动"},{"label":"选址：青州踩点定首店","from":3,"to":5,"tone":"时机","note":"这一步老板亲自去看。"},{"label":"装修开店：青州首店落地","from":5,"to":8,"tone":"机会"},{"label":"复盘：首店跑通再谈第二城","from":8,"to":9,"tone":"布局"}]}

gauge / matrix / gantt 的 h 都是章节标题（服务端自动配汉字序号）。gauge 的 score、items.score 会被夹到 0–100；matrix 不足 4 象限会补空、超过会截断；gantt 的 from>to 会自动对调、total 过小自动取最大 to——但你应一次给对，别依赖兜底。`;

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * 在 text 的锚点处插入 PATCH_TEXT。
 * 命中锚点：在锚点所在「段落」（下一个 \n\n 前）之后插入；无 \n\n 则在锚点所在行末插入。
 * 全部落空：append 到末尾并 console.warn。
 * 返回 { next, where, anchor }。
 */
function insertPatch(text) {
  for (const anchor of ANCHORS) {
    const at = text.indexOf(anchor);
    if (at === -1) continue;
    // 段落边界：锚点之后的第一个空行
    let cut = text.indexOf('\n\n', at);
    if (cut === -1) {
      // 无空行：退到锚点所在行末
      const nl = text.indexOf('\n', at);
      cut = nl === -1 ? text.length : nl;
    }
    const next = text.slice(0, cut) + PATCH_TEXT + text.slice(cut);
    return { next, where: cut, anchor };
  }
  console.warn(`!! 未命中任何锚点（${ANCHORS.join(' / ')}），兜底 append 到 prompt 末尾。请人工核对插入位置是否合适。`);
  return { next: text + PATCH_TEXT, where: text.length, anchor: null };
}

/** 打印一次改动的 diff 摘要（dry-run 与实写都会打印）。 */
function printSummary(tag, oldText, result) {
  const { next, where, anchor } = result;
  console.log(`\n—— ${tag} ——`);
  console.log(`锚点：${anchor ? `命中「${anchor}」@${where}` : '未命中，末尾 append'}`);
  console.log(`长度：${oldText.length} → ${next.length}（+${next.length - oldText.length}）`);
  const ctxBefore = oldText.slice(Math.max(0, where - 60), where).replace(/\n/g, '⏎');
  const ctxAfter = oldText.slice(where, where + 60).replace(/\n/g, '⏎');
  console.log(`插入点上文：…${ctxBefore}`);
  console.log(`插入点下文：${ctxAfter}…`);
  console.log(`插入内容首行：${PATCH_TEXT.trim().slice(0, 60)}…`);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');

const agent = await prisma.agent.findUnique({ where: { key: KEY } });
if (!agent) {
  console.error(`找不到 agent key=${KEY}`);
  await prisma.$disconnect();
  process.exit(1);
}

console.log(`目标 agent：${agent.key} / ${agent.name}；publishedVersionId=${agent.publishedVersionId ?? 'NULL（C 端读 Agent 行）'}`);
console.log(DRY_RUN ? '模式：--dry-run（只打印，不写库）' : '模式：写库');

// —— ① Agent 工作草稿行 ——
if (agent.systemPrompt.includes(MARKER)) {
  console.log(`\n[Agent 行] 已含标志串「${MARKER}」，跳过（幂等）。`);
} else {
  const res = insertPatch(agent.systemPrompt);
  printSummary('Agent 行', agent.systemPrompt, res);
  if (!DRY_RUN) {
    const bak = `/tmp/strat-prompt.backup.${ts}.txt`;
    writeFileSync(bak, agent.systemPrompt, 'utf8');
    await prisma.agent.update({ where: { key: KEY }, data: { systemPrompt: res.next } });
    console.log(`[Agent 行] 已写回；备份：${bak}`);
  }
}

// —— ② 已发布快照（C 端实际读它；pubVer=NULL 时无此步）——
if (agent.publishedVersionId) {
  const ver = await prisma.agentVersion.findUnique({ where: { id: agent.publishedVersionId } });
  if (!ver) {
    console.log(`\n[快照] publishedVersionId=${agent.publishedVersionId} 找不到快照行，请人工检查。`);
  } else if (ver.systemPrompt.includes(MARKER)) {
    console.log(`\n[快照 v${ver.version}] 已含标志串，跳过（幂等）。`);
  } else {
    const res = insertPatch(ver.systemPrompt);
    printSummary(`快照 v${ver.version}（C 端读它）`, ver.systemPrompt, res);
    if (!DRY_RUN) {
      const bak = `/tmp/strat-prompt.backup.${ts}.pubver.txt`;
      writeFileSync(bak, ver.systemPrompt, 'utf8');
      await prisma.agentVersion.update({ where: { id: ver.id }, data: { systemPrompt: res.next } });
      console.log(`[快照 v${ver.version}] 已同步写回；备份：${bak}`);
      console.log('（提示：快照 contentHash 未重算，运营后台可能显示漂移标记，属预期。）');
    }
  }
} else {
  console.log('\n[快照] 该 agent 无已发布快照（pubVer=NULL），C 端直接读 Agent 行，无需同步。');
}

if (DRY_RUN) console.log('\n--dry-run 结束：未写库。');
await prisma.$disconnect();
