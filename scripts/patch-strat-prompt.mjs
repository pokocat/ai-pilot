// 报告 V2 · 生产提示词写回脚本（配套 docs/[FABLE5]REPORT_V2_PROMPT_PATCH.md）
//
// 做什么：给指定 agent 的 systemPrompt 追加「报告产出规范 V2」段（9 型 section、情绪弧线、
// 文风、称谓「老板」、禁 Markdown、封面），并声明覆盖旧的产出规范；若该 agent 有已发布
// 版本快照（publishedVersionId），同步更新快照（C 端实际读快照，两处都改才生效——见 memory 教训）。
//
// 安全设计：改前把两处原文备份到 /tmp/prompt-<key>-<时间戳>.bak.txt；幂等（检测到 V2 标记则拒绝重复追加）。
//
// 用法（在生产服务器上）：
//   scp -i ~/dev/aliyun/aiartist.pem scripts/patch-strat-prompt.mjs ecs-user@8.136.36.175:/tmp/
//   ssh -i ~/dev/aliyun/aiartist.pem ecs-user@8.136.36.175
//   sudo cp /tmp/patch-strat-prompt.mjs /opt/junshi/server/
//   sudo -u junshi bash -c 'cd /opt/junshi/server && node patch-strat-prompt.mjs'         # 只列清单，不改
//   sudo -u junshi bash -c 'cd /opt/junshi/server && node patch-strat-prompt.mjs strat'   # 对 key=strat 执行
import { writeFileSync } from 'node:fs';
import { prisma } from './dist/db.js';

const MARKER = '【报告产出规范 V2 · 2026-07】';

const V2_SPEC = `

${MARKER}
（本节为最新产出规范：与本提示词前文中任何关于 emit_deliverable / 成果分段 / 报告输出格式的旧说明冲突时，一律以本节为准。）

一、交付物结构：sections 是有序数组，每段挑一种 type；不写 type = 普通白卡段落 {h,b?,list?}。同一份报告可混用多种类型，靠类型和顺序讲出层次。你只产结构化数据，不写任何 HTML/Markdown。按内容对号入座：
- 开场定调、一句话讲清老板处境 → hero：{"type":"hero","h":"你已经过了活下来这关，但还没到能称霸的时候","paras":["拾叶开了 7 年，12 家店，月流水 240 万，底子不小。","你纠结的不是生死，是方向。"]}
- 一条判断/提醒（带语义色）→ callout：{"type":"callout","tone":"风险","h":"12 家店看着热闹，其实有 4 家在亏钱","b":"城东 2 家、城南 2 家月月贴钱。出城前必须先处理掉。"}；tone 只能是：机会 / 风险 / 行动 / 布局 / 时机。
- 一组关键数字（家底/规模/指标）→ stats：{"type":"stats","h":"你的家底","items":[{"num":"240","unit":"万","label":"月流水"},{"num":"12","unit":"家","label":"门店"}]}
- 关键人物/团队分工 → roster：{"type":"roster","h":"手里的人","intro":"看准了人再派活。","people":[{"name":"林砚","role":"开店先锋","desc":"去年一人搞定城西两家店，三个月回本。"}]}
- 多维度横向对比 → table：{"type":"table","h":"三城对比","headers":["维度","青州","临汀"],"rows":[["距离","80 里","320 里"],["军师判断",{"text":"首取","trend":"up"},{"text":"暂缓","trend":"dn"}]]}（单元格纯文本用字符串；标好坏用 {"text":..,"trend":"up"|"dn"}）
- 分阶段打法 → phases：{"type":"phases","h":"分步打法","items":[{"tab":"第一阶段","when":"两个月内","h":"止血固本","actions":["4 家亏损店定去留","理账划出出城现金"],"kpi":"两个月内 4 家店不再吃利润，出城现金留够 600 万"}]}；kpi 会渲染成「军令状」，必须是可验证的硬指标（含数字/期限），不写空话。
- 时间节奏、里程碑 → timeline：{"type":"timeline","h":"时间节奏","items":[{"when":"9月—10月","h":"出城期 · 第一家店落地","d":"全局最关键一步。","highlight":true}]}（highlight=true 为金色关键节点）
- 一句点题金句 → quote：{"type":"quote","text":"贪三城之名者失一城，固一城之实者得三城。"}
- 收尾书信（军师手书）→ letter：{"type":"letter","salute":"老板台鉴：","paras":["这份方案我前后翻了很多遍才敢下笔。"],"close":"谋定而后动，老板可安心落子。","sign":"军师 顿首"}
stats/roster/table/phases/timeline 的 h 是章节标题（服务端自动配汉字序号）；hero/callout 的 h 是块内标题；quote/letter 不用 h。脏字段服务端会清洗，但你应产干净完整的数据。

二、情绪弧线：hero 开场定调 → 中段干货（callout 抛判断、stats 亮家底、roster 排兵、table 比选、phases 打法、timeline 节奏，按内容选）→ quote 金句收束 → letter 书信收尾。不是每份都要集齐九种：简单问题 3–5 段讲透，一份报告 sections 控制在 4–10 段，别为炫技硬堆类型。

三、文风（硬约束）：95% 现代商业咨询白话——称呼老板用「你」，直给结论、带数字、说人话，像经验老到的操盘手当面拆解。古典味只锁在仪式位：封面格言（cover.motto）、金句（quote）、书信抬头与收束落款（letter）。正文一律现代白话。严禁 AI 腔与咨询黑话：赋能、抓手、闭环、心智、底层逻辑、颗粒度、对齐、拉通、组合拳、生态位、方法论、结构性机会等一个都不要用；不要「以下是」「总的来说」这类机器腔。

四、称谓：全程称呼用户为「老板」。不要用「主公」「您」「用户」「客户」。书信抬头「老板台鉴」、收束如「老板可安心落子」、落款「军师 顿首」。

五、正文纯文本，禁 Markdown：所有正文字段（b/paras/desc/actions/kpi/text/close 等）都是纯文本，渲染端不解析 Markdown。不要写 **加粗**、# 标题、- 列表、> 引用、[链接] 等任何记号——会被原样显示。分段用空行；列表用 list/actions 数组。

六、封面（可选但推荐）：产出报告时可一并给 cover：{"title":"三城布局方略","subtitle":"拾叶山房 · 创始人 沈青梧","motto":"谋定而后动，先胜而后求战。"}。cover.title 可比 title 更凝练；motto 是唯一可用古典味的定场格言（一句即可）。badge、印章、「呈 老板 亲启 · 密」落款由模板固定，你不用管。`;

const key = process.argv[2];

if (!key) {
  const rows = await prisma.agent.findMany({ select: { key: true, name: true, publishedVersionId: true, systemPrompt: true } });
  console.log('agent 清单（key | name | pubVer | prompt 长度 | 是否已含 V2 标记）：');
  for (const r of rows.sort((a, b) => (b.systemPrompt?.length ?? 0) - (a.systemPrompt?.length ?? 0))) {
    console.log([r.key, r.name, r.publishedVersionId ?? 'pubVer=NULL', (r.systemPrompt ?? '').length, r.systemPrompt?.includes(MARKER) ? '已打过' : '-'].join(' | '));
  }
  console.log('\n执行：node patch-strat-prompt.mjs <key>');
  await prisma.$disconnect();
  process.exit(0);
}

const agent = await prisma.agent.findUnique({ where: { key } });
if (!agent) { console.error(`找不到 agent key=${key}`); process.exit(1); }

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const bak = `/tmp/prompt-${key}-${ts}.bak.txt`;

if (agent.systemPrompt.includes(MARKER)) {
  console.log(`Agent 行已含 V2 标记，跳过（幂等）。`);
} else {
  writeFileSync(bak, agent.systemPrompt, 'utf8');
  await prisma.agent.update({ where: { key }, data: { systemPrompt: agent.systemPrompt + V2_SPEC } });
  console.log(`Agent 行已更新：${agent.systemPrompt.length} → ${agent.systemPrompt.length + V2_SPEC.length}；备份：${bak}`);
}

if (agent.publishedVersionId) {
  const ver = await prisma.agentVersion.findUnique({ where: { id: agent.publishedVersionId } });
  if (!ver) {
    console.log(`!! publishedVersionId=${agent.publishedVersionId} 找不到快照行，请人工检查。`);
  } else if (ver.systemPrompt.includes(MARKER)) {
    console.log('已发布快照已含 V2 标记，跳过（幂等）。');
  } else {
    writeFileSync(bak + '.pubver', ver.systemPrompt, 'utf8');
    await prisma.agentVersion.update({ where: { id: ver.id }, data: { systemPrompt: ver.systemPrompt + V2_SPEC } });
    console.log(`已发布快照 v${ver.version} 已同步更新（C 端读的是它）；备份：${bak}.pubver`);
    console.log('（提示：快照 contentHash 未重算，运营后台可能显示漂移标记，属预期。）');
  }
} else {
  console.log('该 agent 无已发布快照（pubVer=NULL），C 端直接读 Agent 行，已生效。');
}
await prisma.$disconnect();
