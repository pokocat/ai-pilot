// 「快出片」包内模板目录。
//
// 这里是端内可体验模板的唯一事实源：模板列表、详情与 mock 项目骨架都从这里取，
// 避免接口未启动时首页变成空白，也避免多个模板实际上共用同一份脚本。
const { ROLE } = require('./model');

const clone = (value) => JSON.parse(JSON.stringify(value));

const BUILTIN_TEMPLATES = [
  {
    id: 'ct_shiti',
    name: '为实体发声',
    industry: '实体商家',
    themeKey: 'advocacy',
    description: '2 分 42 秒纪实倡导片。暖光街景、褪色招牌，讲你守着这家店的这些年。',
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
  {
    id: 'ct_kaimen',
    name: '今天开门了',
    industry: '本地生活',
    themeKey: 'daily',
    description: '1 分钟日更款。开门、备货、招呼客人，随手拍的素材就能出片。',
    estDurationSec: 80,
    avatarSecHint: 12,
    creditHint: 32,
    segmentCount: 8,
    coverTone: 'morning',
    tailLabel: '结尾：门店信息卡',
    tailDurationSec: 8,
    variables: { shopName: '巷口修鞋铺', street: '学院路', ownerName: '张姐', openTime: '早上七点' },
    segments: [
      { no: 1, text: '早上七点，巷口修鞋铺今天开门了。', role: ROLE.AVATAR },
      { no: 2, text: '先扫门口，再把常用的锤子和针线摆顺手。', role: ROLE.BROLL, hint: '这里放：开门和整理工具' },
      { no: 3, text: '第一位客人送来一双开胶的运动鞋，说下午要穿。', role: ROLE.BROLL, hint: '这里放：接鞋和检查鞋底' },
      { no: 4, text: '清胶、上胶、压实，急活也不能少一道工序。', role: ROLE.BROLL, hint: '这里放：修补过程的三个特写' },
      { no: 5, text: '中午前又来了两位老街坊，坐下就聊起这条街的变化。', role: ROLE.BROLL, hint: '这里放：店内中景或顾客背影' },
      { no: 6, text: '小店的一天没有大事，都是把眼前的小事做好。', role: ROLE.BROLL, hint: '这里放：柜台、工具和门外街景' },
      { no: 7, text: '路过学院路，鞋子有点小毛病，就来找我。', role: ROLE.AVATAR },
      { no: 8, text: '结尾：门店信息卡', role: ROLE.TAIL, durationSec: 8, replaceable: true },
    ],
  },
  {
    id: 'ct_shouyi',
    name: '这门手艺',
    industry: '手艺人',
    themeKey: 'craft',
    description: '讲你手上的活儿。特写镜头为主，出镜少、成本低。',
    estDurationSec: 105,
    avatarSecHint: 16,
    creditHint: 40,
    segmentCount: 10,
    coverTone: 'craft',
    tailLabel: '结尾：手艺人群像',
    tailDurationSec: 14,
    variables: { shopName: '巷口修鞋铺', street: '学院路', years: '十二年', ownerName: '张姐' },
    segments: [
      { no: 1, text: '这把小锤子跟了我十二年，分量我闭着眼都认得。', role: ROLE.AVATAR },
      { no: 2, text: '修鞋先看磨损，不同的脚法，鞋底留下的痕迹也不同。', role: ROLE.BROLL, hint: '这里放：翻看鞋底磨损' },
      { no: 3, text: '旧线要一针针拆，留下的针孔才能继续用。', role: ROLE.BROLL, hint: '这里放：拆线的手部特写' },
      { no: 4, text: '皮子要顺着纹路裁，差一毫米，贴上去就不服帖。', role: ROLE.BROLL, hint: '这里放：裁皮和比对边缘' },
      { no: 5, text: '最考功夫的是走线，手上要稳，心里不能急。', role: ROLE.BROLL, hint: '这里放：穿针、拉线、收紧' },
      { no: 6, text: '机器能快一点，但最后的边角还得靠手感。', role: ROLE.BROLL, hint: '这里放：机器与手工交替' },
      { no: 7, text: '修好的鞋不一定像新的，但一定还能陪主人走很远。', role: ROLE.BROLL, hint: '这里放：修前修后对比' },
      { no: 8, text: '这门手艺不响亮，却能把舍不得丢的东西留下来。', role: ROLE.BROLL, hint: '这里放：顾客接过鞋的瞬间' },
      { no: 9, text: '只要还有人需要，我就把这盏灯继续亮着。', role: ROLE.AVATAR },
      { no: 10, text: '结尾：手艺人群像', role: ROLE.TAIL, durationSec: 14, replaceable: true },
    ],
  },
];

function templateMeta(template) {
  if (!template) return null;
  const result = clone(template);
  delete result.variables;
  delete result.segments;
  return result;
}

function listBuiltInTemplates() {
  return BUILTIN_TEMPLATES.map(templateMeta);
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
};
