// 报告 V2 · 生产提示词写回脚本 —— 第二轮：组件使用密度铁律 + 三新组件（gauge/matrix/gantt）
// 配套文档：docs/[FABLE5]REPORT_V2_PROMPT_PATCH.md（V6.1 追加修订 · 2026-07-22）
//
// 说明：本脚本取代上一轮「9 型 V2 追加脚本」（git a809916，如仍需补 9 型可从历史取回）。
// 上一轮把 9 型/情绪弧线/文风/称谓/封面 追加进 systemPrompt；本轮在其基础上「按锚点插入」
// 一段《报告组件使用密度铁律》+《三新组件使用时机与字段》，根治「整份报告全是白卡文字墙」。
//
// 目标 agent 不写死（2026-07-03 起 V6 主 prompt 已从 strat 迁到 general，见 memory
// strat-v6-embedding）：脚本扫描全部 agent（草稿 + 已发布快照），凡含九型特征串
// （SIGNATURE）者列为候选——恰一个则选它；零个或多个必须显式 --agent=<key> 指定。
//
// 写回路径：更新 Agent 草稿行后，若该 agent 有已发布快照（publishedVersionId != NULL），
// 优先走 ./dist/services/agentVersions.js 的 publishDraft(<key>) 正式发布新版本
// （保留版本链，可 rollbackToVersion 回滚）；publishDraft 不可用时回退为
// 「草稿 + 快照双 UPDATE」并 console.warn（与 07-19 手工路径等价，无版本链）。
//
// 安全设计：
//   - 改前把待改文本原样备份到 /tmp/strat-prompt.backup.<时间戳>.txt（草稿行）
//     与 /tmp/strat-prompt.backup.<时间戳>.pubver.txt（快照，若有）。
//   - 幂等：检测到本轮标志串（MARKER）则拒绝重复插入。
//   - 锚点缺失兜底：任一 ANCHORS 都找不到时，append 到 prompt 末尾并 console.warn（不静默）。
//   - --dry-run：只打印 diff 摘要（候选清单 / 锚点命中 / 插入位置 / 新旧长度），不写库。
//
// 用法（在生产服务器上，纯 node + @prisma/client + 已构建 dist，无其它依赖）：
//   scp -i ~/dev/aliyun/aiartist.pem scripts/patch-strat-prompt.mjs ecs-user@8.136.36.175:/tmp/
//   ssh -i ~/dev/aliyun/aiartist.pem ecs-user@8.136.36.175
//   sudo cp /tmp/patch-strat-prompt.mjs /opt/junshi/server/
//   sudo -u junshi node /opt/junshi/server/patch-strat-prompt.mjs --dry-run           # 预演
//   sudo -u junshi node /opt/junshi/server/patch-strat-prompt.mjs                     # 写回（候选唯一时）
//   sudo -u junshi node /opt/junshi/server/patch-strat-prompt.mjs --agent=general     # 显式指定目标
import { writeFileSync } from 'node:fs';
import { prisma } from './dist/db.js';

// 目标特征串：主 prompt 的「【产出格式】只输出结构化分段」尾段（2026-07-22 生产实测唯一命中
// general；上一轮九型修订从未写回 DB，「情绪弧线」在线上不存在，勿用作特征）。
const SIGNATURE = '【产出格式】';

// 幂等标志串：systemPrompt 已含此串则视为本轮已打过，拒绝重复插入。
const MARKER = '组件使用密度铁律';

// 锚点（按优先级尝试，第一个命中者即在其「所在段落」之后插入）。
// 2026-07-22 生产实测（general 草稿=pub_v3，17230 字）：上一轮九型修订从未写回，
// 「情绪弧线/军师手书」均不存在；prompt 末尾结构为【产出格式】段 →【数字铁律】段收尾。
// 首选锚点即【产出格式】——密度铁律插在它之后、数字铁律之前，语义最顺。
// 注意不要用「封面」当锚点：它在前部命理叙事段（@~3896）就会误中。
// 全部落空时兜底 append 到 prompt 末尾（见下方 console.warn）。
const ANCHORS = [
  '【产出格式】',      // 末尾产出规范段（实测存在），插在其段落之后
  '【数字铁律】',      // 兜底：插在数字铁律段之后（即 prompt 末尾），可接受
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
const AGENT_ARG = (process.argv.find((a) => a.startsWith('--agent=')) ?? '').slice('--agent='.length) || null;

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

// —— ① 定位目标 agent：扫描草稿 + 已发布快照，含九型特征串者为候选 ——
const agents = await prisma.agent.findMany({
  select: { key: true, name: true, systemPrompt: true, publishedVersionId: true },
});
const candidates = [];
for (const a of agents) {
  const draftHit = (a.systemPrompt ?? '').includes(SIGNATURE);
  let pubHit = false;
  if (a.publishedVersionId) {
    const ver = await prisma.agentVersion.findUnique({
      where: { id: a.publishedVersionId },
      select: { systemPrompt: true, version: true },
    });
    pubHit = (ver?.systemPrompt ?? '').includes(SIGNATURE);
  }
  if (draftHit || pubHit) candidates.push({ ...a, draftHit, pubHit });
}

console.log(`候选（草稿或快照含「${SIGNATURE}」）：`);
for (const c of candidates) {
  console.log(`  - ${c.key} / ${c.name} · 草稿 ${c.systemPrompt.length} 字 · pubVer=${c.publishedVersionId ?? 'NULL'} · 草稿命中=${c.draftHit} 快照命中=${c.pubHit}`);
}

let targetKey = null;
if (AGENT_ARG) {
  targetKey = AGENT_ARG;
  console.log(`目标：--agent 显式指定 ${targetKey}`);
} else if (candidates.length === 1) {
  targetKey = candidates[0].key;
  console.log(`目标：候选唯一，自动选定 ${targetKey}`);
} else {
  console.error(`候选数=${candidates.length}（非 1），无法自动选定。请用 --agent=<key> 显式指定后重跑。`);
  await prisma.$disconnect();
  process.exit(1);
}

const agent = await prisma.agent.findUnique({ where: { key: targetKey } });
if (!agent) {
  console.error(`找不到 agent key=${targetKey}`);
  await prisma.$disconnect();
  process.exit(1);
}

console.log(`\n目标 agent：${agent.key} / ${agent.name}；publishedVersionId=${agent.publishedVersionId ?? 'NULL（C 端读 Agent 行）'}`);
console.log(DRY_RUN ? '模式：--dry-run（只打印，不写库）' : '模式：写库');

const ts = new Date().toISOString().replace(/[:.]/g, '-');

// —— ② Agent 草稿行插入 ——
let draftChanged = false;
if (agent.systemPrompt.includes(MARKER)) {
  console.log(`\n[草稿行] 已含标志串「${MARKER}」，跳过插入（幂等）。`);
} else {
  const res = insertPatch(agent.systemPrompt);
  printSummary('草稿行', agent.systemPrompt, res);
  if (!DRY_RUN) {
    const bak = `/tmp/strat-prompt.backup.${ts}.txt`;
    writeFileSync(bak, agent.systemPrompt, 'utf8');
    await prisma.agent.update({ where: { key: targetKey }, data: { systemPrompt: res.next, draftDirty: true } });
    console.log(`[草稿行] 已写回；备份：${bak}`);
  }
  draftChanged = true;
}

// —— ③ 发布：有快照走 publishDraft 正式成版（可回滚）；不可用则回退双 UPDATE ——
if (!agent.publishedVersionId) {
  console.log('\n[发布] 该 agent 无已发布快照（pubVer=NULL），C 端直接读草稿行，无需发布。');
} else if (!draftChanged && !DRY_RUN) {
  console.log('\n[发布] 草稿未变（已幂等跳过），不发布。若快照缺本轮修订请人工检查（草稿含 MARKER 而快照不含时，直接跑 publishDraft 即可）。');
} else if (DRY_RUN) {
  console.log(`\n[发布] --dry-run：写库后将调用 publishDraft('${targetKey}') 正式发布新版本（保留版本链，可 rollbackToVersion 回滚）。`);
} else {
  // 快照备份（发布前留档，便于逐字节对比）
  const ver = await prisma.agentVersion.findUnique({ where: { id: agent.publishedVersionId } });
  if (ver) {
    const bak = `/tmp/strat-prompt.backup.${ts}.pubver.txt`;
    writeFileSync(bak, ver.systemPrompt ?? '', 'utf8');
    console.log(`[发布] 当前快照 v${ver.version} 已备份：${bak}`);
  }
  try {
    const { publishDraft } = await import('./dist/services/agentVersions.js');
    const out = await publishDraft(targetKey, { label: 'V6.1 组件密度铁律+三新组件' });
    console.log(`[发布] publishDraft 成功：version ${out.version}（${out.versionId}）changed=${out.changed}`);
    console.log(`[发布] 变更摘要：${out.changeSummary}`);
    console.log(`[发布] 回滚：rollbackToVersion('${targetKey}', '${agent.publishedVersionId}')（原快照）。`);
  } catch (e) {
    console.warn(`!! publishDraft 不可用（${e?.message ?? e}），回退为快照直改（无版本链，运营后台可能显示漂移标记）。`);
    if (ver && !(ver.systemPrompt ?? '').includes(MARKER)) {
      const res = insertPatch(ver.systemPrompt ?? '');
      printSummary(`快照 v${ver.version}（C 端读它）`, ver.systemPrompt ?? '', res);
      await prisma.agentVersion.update({ where: { id: ver.id }, data: { systemPrompt: res.next } });
      console.log(`[发布·回退] 快照 v${ver.version} 已直改写回。`);
    } else {
      console.log('[发布·回退] 快照已含标志串或不存在，跳过。');
    }
  }
}

if (DRY_RUN) console.log('\n--dry-run 结束：未写库。');
await prisma.$disconnect();
