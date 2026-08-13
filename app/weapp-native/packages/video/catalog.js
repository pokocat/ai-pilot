// 「快出片」包内模板目录。
//
// 这里是端内可体验模板的唯一事实源：模板列表、详情与 mock 项目骨架都从这里取，
// 避免接口未启动时首页变成空白，也避免多个模板实际上共用同一份脚本。
const { ROLE, summarize, estimateCredits } = require('./model');

const clone = (value) => JSON.parse(JSON.stringify(value));

const BUILTIN_TEMPLATES = [
  {
    id: 'ct_shiti',
    name: '为实体发声',
    industry: '实体商家',
    themeKey: 'advocacy',
    description: '纪实倡导片。暖光街景、褪色招牌，讲你守着这家店的这些年。',
    estDurationSec: 162,
    avatarSecHint: 38,
    creditHint: 68,
    segmentCount: 14,
    coverTone: 'warm',
    tailLabel: '结尾：集体发声与团队愿景',
    tailDurationSec: 22,
    variables: { shopName: '巷口修鞋铺', street: '学院路', years: '十二年', ownerName: '张姐' },
    segments: [
      { no: 1, text: '大家好，我是巷口修鞋铺的张姐。', role: ROLE.AVATAR },
      { no: 2, text: '在学院路这条街上，我修了十二年鞋。', role: ROLE.AVATAR },
      { no: 3, text: '每天早上七点，卷闸门一拉开，这条街才算醒了。', role: ROLE.BROLL, hint: '这里放：清早开门的门口' },
      { no: 4, text: '来的都是熟客，一双鞋修好，能再穿两年。', role: ROLE.BROLL, hint: '这里放：你手上修鞋的特写' },
      { no: 5, text: '这些年店越来越少，招牌一块块褪了色。', role: ROLE.BROLL, hint: '这里放：老招牌或街景空镜' },
      { no: 6, text: '隔壁的五金店去年关了，再隔壁的裁缝铺也搬走了。', role: ROLE.BROLL, hint: '这里放：卷闸门紧闭的店面' },
      { no: 7, text: '有人问我，怎么不去做点别的。', role: ROLE.BROLL, hint: '这里放：你在店里忙碌的中景' },
      { no: 8, text: '我说，这条街上还有人需要我把鞋修好。', role: ROLE.BROLL, hint: '这里放：顾客取鞋的瞬间' },
      { no: 9, text: '我们没什么大本事，就是把手上的活儿做扎实。', role: ROLE.AVATAR },
      { no: 10, text: '一双鞋，一个招牌，一条街，都是这么撑下来的。', role: ROLE.BROLL, hint: '这里放：街道全景' },
      { no: 11, text: '现在也有年轻人来学这门手艺了。', role: ROLE.BROLL, hint: '这里放：学徒或工具特写' },
      { no: 12, text: '我把摊子摆在这儿，就是想让大家知道，实体店还在。', role: ROLE.BROLL, hint: '这里放：门口全景' },
      { no: 13, text: '有需要的，随时来。', role: ROLE.AVATAR },
      { no: 14, text: '结尾：集体发声与团队愿景', role: ROLE.TAIL, durationSec: 22, replaceable: true },
    ],
  },
];

/**
 * 当前对用户开放的模板白名单 —— **产品决策点，改这里**。
 *
 * 2026-08-12：收敛为只保留《为实体发声》一套。原因是三套模板共用同一个虚构主体
 * （巷口修鞋铺·张姐），对用户是三个壳子一个故事，反而稀释了首页的主行动。
 *
 * ⚠️ AIStar 侧 `ClipOfficialTemplateSeeder` 仍然种着 ct_kaimen / ct_shouyi 两条，
 * 服务端 `/templates` 还会返回它们。端上用本白名单做最终过滤，所以下架不依赖服务端改动；
 * 要彻底清掉服务端数据得另外改 seeder + 清库（跨仓库，见交接书）。
 */
const OFFERED_TEMPLATE_IDS = ['ct_shiti'];

/** 服务端模板列表过白名单；服务端将来上新模板，把 id 加进上面的数组即可。 */
function filterOffered(templates) {
  if (!Array.isArray(templates)) return [];
  return templates.filter((item) => item && OFFERED_TEMPLATE_IDS.indexOf(item.id) >= 0);
}

function templateMeta(template) {
  if (!template) return null;
  const result = clone(template);
  result.scriptSkeleton = { segments: clone(result.segments), variables: Object.keys(result.variables || {}).map((key) => ({ key, placeholder: result.variables[key] })) };

  // 时长 / 出镜秒数 / 预计积分**全部从 segments 推导**，不用手写常量。
  // 起因：这三个数原先是各写各的 —— estDurationSec 早就改成算出来的（84 秒），
  // avatarSecHint=38、creditHint=68 却还是设计稿 2:42 版本的残留，
  // 于是首页主卡出现「成片 1:24，其中出镜 38 秒」这种自相矛盾的三件套。
  // 主卡的全部作用就是给三个可信事实，任何一个对不上，整张卡就不可信。
  const summary = summarize(result.segments);
  result.estDurationSec = summary.totalSec;
  result.avatarSecHint = summary.avatarSec;
  result.creditHint = estimateCredits(result.segments).total;
  result.segmentCount = result.segments.length;
  const tail = result.segments.find((item) => item.role === ROLE.TAIL);
  if (tail) { result.tailLabel = tail.text; result.tailDurationSec = tail.durationSec || 0; }
  delete result.variables;
  delete result.segments;
  return result;
}

function listBuiltInTemplates() {
  return filterOffered(BUILTIN_TEMPLATES.map(templateMeta));
}

function getBuiltInTemplate(id) {
  return templateMeta(BUILTIN_TEMPLATES.find((item) => item.id === id));
}

function getBuiltInProjectSeed(id) {
  const template = BUILTIN_TEMPLATES.find((item) => item.id === id);
  if (!template) return null;
  return {
    template: templateMeta(template),
    variables: clone(template.variables),
    segments: clone(template.segments),
  };
}

module.exports = {
  listBuiltInTemplates,
  getBuiltInTemplate,
  getBuiltInProjectSeed,
  filterOffered,
  OFFERED_TEMPLATE_IDS,
};
