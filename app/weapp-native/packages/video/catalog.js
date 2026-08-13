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
    description: '纪实倡导片。走遍全国的实体店主群像，讲那些凌晨亮灯的坚持。',
    estDurationSec: 162,
    avatarSecHint: 38,
    creditHint: 68,
    segmentCount: 14,
    coverTone: 'warm',
    tailLabel: '结尾：为实体发声计划',
    tailDurationSec: 10,
    variables: { shopName: '巷口修鞋铺', street: '学院路', years: '十二年', ownerName: '张姐' },
    segments: [
      { no: 1, text: '百分之九十的实体店在边缘挣扎，但有的店却逆势生长。', role: ROLE.AVATAR },
      { no: 2, text: '我们走遍全国，发现那些活得好的老板：要么凌晨四点还在揉面，只为一口让人惦记的老味道；', role: ROLE.BROLL, hint: '这里放：清晨备货或街景空镜' },
      { no: 3, text: '要么对着手机一遍遍练习，把冰冷的屏幕捂热成新的门店。', role: ROLE.BROLL, hint: '这里放：店主对着手机练习' },
      { no: 4, text: '都说实体生意难做，这话不假。', role: ROLE.BROLL },
      { no: 5, text: '电商自媒体的洪流，卷走了太多熟悉的身影。', role: ROLE.BROLL, hint: '这里放：冷清的街道或空店面' },
      { no: 6, text: '但绝处，总能逢生，这些滚烫的人生，这些城市的烟火气，不该沉默！', role: ROLE.BROLL },
      { no: 7, text: '我们团队发起百位实体创业者计划，想用镜头，把那些滚烫的人生，讲给世界听。', role: ROLE.AVATAR },
      { no: 8, text: '记录下平凡岗位上的不凡，每一家凌晨亮灯的小店背后，是咬牙的坚持；', role: ROLE.BROLL, hint: '这里放：凌晨亮灯的小店' },
      { no: 9, text: '每一个轰鸣的车间里，藏着对品质的死磕；', role: ROLE.BROLL, hint: '这里放：车间机器运转特写' },
      { no: 10, text: '每一个本土品牌的名字，都写满了从线下到线上的突围故事。', role: ROLE.BROLL, hint: '这里放：本土品牌招牌' },
      { no: 11, text: '这些故事很小，汇聚起来，就是刺破寒冬的光。', role: ROLE.BROLL, hint: '这里放：微光/灯火的空镜' },
      { no: 12, text: '这些故事就发生在你每天路过的街角，它们正在消失，像从未存在过。', role: ROLE.BROLL, hint: '这里放：你每天路过的街角' },
      { no: 13, text: '但今天，你能让故事活下去，把那些滚烫的人生，讲给世界听。', role: ROLE.AVATAR },
      { no: 14, text: '当你按下录制键，奇迹正在发生：你拯救了王阿姨的豆腐摊，视频播放量换来了新顾客的长队，', role: ROLE.BROLL, hint: '这里放：顾客排队或摊位忙碌' },
      { no: 15, text: '你点燃了张叔眼里的光，机械厂故事引来海外订单。', role: ROLE.BROLL, hint: '这里放：车间或工人特写' },
      { no: 16, text: '加入为实体发声计划，不是要你当网红，而是邀请你成为城市故事的守护者，实体经济的点灯人，平凡生活的英雄。', role: ROLE.BROLL },
      { no: 17, text: '用你的声音，替沉默的实体发声，让每部手机，都成为照亮街角的火把，', role: ROLE.BROLL, hint: '这里放：手机拍摄的画面' },
      { no: 18, text: '当十万支火把点燃，整座城市将不再有黑暗的角落。', role: ROLE.BROLL, hint: '这里放：城市夜景灯火' },
      { no: 19, text: '别等到熟悉的店铺消失才后悔。', role: ROLE.BROLL, hint: '这里放：卷闸门紧闭的店面' },
      { no: 20, text: '此刻，你指尖的温度，能融化冰封的招牌。', role: ROLE.BROLL, hint: '这里放：招牌特写' },
      { no: 21, text: '这不是商业计划，而是一场人文运动，让技术有了心跳，让奋斗有了观众，让城市有了记忆！', role: ROLE.AVATAR },
      { no: 22, text: '结尾：为实体发声计划', role: ROLE.TAIL, durationSec: 10, replaceable: true },
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
