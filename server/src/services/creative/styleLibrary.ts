// 影像主导路线（photo route）的**风格档案库**：12 档，typed 常量。
//
// 与 md 底稿的关系：`server/src/creative/canvas-design/poster-style-library.md` 是人类可读底稿
// （研究蒸馏产物 + 来源标注），本文件是它的代码侧唯一真源。**运行时不读那份 md**
// （生产镜像只含 dist/），改一边必须同步改另一边。
//
// ★ 2026-08-15「方案优先」重构：整段 `imagePromptSkeleton` 已拆成 `structure` + `defaults` 两块。
//   拆分理由是一条实证缺陷：骨架把背景/光线/色彩写死在整段文案里（编辑部黑金写死
//   `black seamless backdrop / rich true black point / pure unbroken black`），于是军师跟客户聊定的
//   「沉稳深灰 + 柔暖光」永远进不了生图提示词——用户看到的方案与产出结构性脱节。
//   现在的口径：
//     · structure = 构图骨架 / 主体位置 / 相机语法 / 负空间形状与占比 / 行动区 / 风格专属负向词，
//       **不可被方案覆盖**（它们是这一档之所以是这一档的原因，也是叠层能落字的前提）；
//     · defaults  = backdrop / lighting / palette / material / props / mood / figure，
//       **可被方案覆盖**（方案没聊到的字段才用这里的缺省）。
//   ⚠️ 因此 structure.negativeSpace **不许出现具体颜色词**：留白区的颜色跟着 backdrop 走
//     （写 `in the backdrop tone`），否则覆盖了 backdrop 也还会被这句话拽回黑色。
//
// 两处刻意偏离底稿原文（底稿头部也记了同一条）：
//   ① **主体槽位统一归一成 `{SUBJECT}`**。原文里 `quiet_luxury_grey` 写 `{SUBJECT}`、
//      `glossy_3d_trend` 写 `{SUBJECT_OBJECT}`、`surreal_object_metaphor` 写 `{METAPHOR_OBJECT: …}`，
//      但那是同一个位置（这张图的主角）。拼装器只认一个槽名，才可能对 12 档写同一套单测。
//      「这一档的主角该是什么」由 `subjectHint` 交代（进宣言提示词，让模型写对 subject）。
//   ② **原文里 `{LABEL: 默认值}` 的槽位内容已按字段落到 `defaults`**（`{WARDROBE: 象牙白开司米}`
//      的内容进 `defaults.figure`）。把字面 `{}` 发给生图模型没有意义；原文的花括号是给人看的
//      「这里可替换」标记，而「可替换」现在由 defaults 覆盖机制真正实现了。
//      structure 里除 `{SUBJECT}` 外**不允许再有任何槽位**——完整性单测钉住这一条。
//
// 三个调研发现在本文件的落点（另两个在 imagePrompt.ts）：
//   · `structure.negativeSpace` 是**必填**字段，且拼装器把它拼进 prompt **正文**（不是只放负向框）——
//     「声明了留白但没有显式禁入侵子句」是海报与普通图的唯一分界，模型会把阴影边缘、道具轮廓、
//     渐变条带塞进留白区。
//   · `structure.negatives` 只写**风格专属忌讳**；通用基座在 imagePrompt.ts 的 BASE_NEGATIVES，
//     拼装时合并。两处分开是为了让「加一档」不必抄一遍 20 个通用负向词。
import type { PosterScene } from '../../../../shared/contracts';

/**
 * 文字安全区的机器标识（供渲染层定位）。取值与底稿 `safe_zone` 字段一一对应。
 * `right_third` / `bottom_40` 当前 12 档没有用到，但它们是底稿声明的合法取值，保留以免加档时又改一遍类型。
 */
export const SAFE_ZONES = [
  'left_third', 'right_third', 'top_40', 'top_30', 'bottom_35', 'bottom_40',
  'upper_two_thirds', 'left_half', 'upper_quarter', 'above_lower_third',
] as const;
export type SafeZone = (typeof SAFE_ZONES)[number];

/**
 * 安全区 → 画布坐标区间的人话说明（540×720 逻辑画布，与 CANVAS 同口径）。
 *
 * 为什么要换算成 px：排版层是 LLM 写 HTML/CSS，给它 `left_third` 这种枚举名它得自己猜边界，
 * 而猜错的代价是标题压在人脸上（这一项量测器量不出来，只能靠提示词说死）。
 */
export const SAFE_ZONE_HINTS: Record<SafeZone, string> = {
  left_third: '画布左侧三分之一（x ≈ 0–180px）',
  right_third: '画布右侧三分之一（x ≈ 360–540px）',
  top_40: '画布上部 40%（y ≈ 0–288px）',
  top_30: '画布上部 30%（y ≈ 0–216px）',
  bottom_35: '画布下部 35%（y ≈ 468–720px）',
  bottom_40: '画布下部 40%（y ≈ 432–720px）',
  upper_two_thirds: '画布上部三分之二（y ≈ 0–480px）',
  left_half: '画布左半幅（x ≈ 0–270px）',
  upper_quarter: '画布顶部四分之一（y ≈ 0–180px）',
  above_lower_third: '下三分之一以上的整片区域（y ≈ 0–480px）',
};

export const POSTER_STYLE_KEYS = [
  'quiet_luxury_grey', 'baroque_icon_gold', 'editorial_black_gold', 'neo_chinese_void',
  'documentary_film_grain', 'luxury_magazine_cover', 'airy_japanese_light', 'cyber_tech_blue',
  'retro_hongkong', 'glossy_3d_trend', 'mono_authority_portrait', 'surreal_object_metaphor',
] as const;
export type PosterStyleKey = (typeof POSTER_STYLE_KEYS)[number];

/**
 * **可被方案覆盖**的表现字段。字段名全库统一：manifesto 的 artDirection、
 * imagePrompt.mergeArtDirection、canvasEngine 的中文摘要用的都是这七个名字，
 * 名字对不上就等于覆盖静默失效（正是本次要修的那类缺陷）。
 *
 * 每个值都是一段可直接进 prompt 的英文短语（不带 `Environment:` 这类前缀，前缀由合成器统一加）。
 * 空串表示这一档在这个维度上没有主张 —— 合成时整段略过，不留空标签。
 */
export interface PosterStyleDefaults {
  /** 背景基调（原骨架的 Environment 段）。留白区的颜色也跟着它走。 */
  backdrop: string;
  /** 光质与方向（原骨架的 Lighting 段）。 */
  lighting: string;
  /** 色彩关系与调色（原骨架 Finish 段里的调色部分）。注意与 PosterStyle.palette（十六进制色板）不是一回事。 */
  palette: string;
  /** 材质质感（原骨架 Finish 段里的质感/胶片/渲染部分）。 */
  material: string;
  /** 道具与陪体。 */
  props: string;
  /** 情绪。原骨架没写情绪词的档留空——不替它编。 */
  mood: string;
  /** 人物气质（服装 / 动作 / 神态）。物件类风格恒为空串。 */
  figure: string;
}

/**
 * **不可被方案覆盖**的结构位。方案能改画面长什么样，不能改这一档的骨头：
 * 改了构图与相机语法，安全区就对不上排版层，叠层会压到主体上。
 */
export interface PosterStyleStructure {
  /** 体裁 + 主体开场，含唯一槽位 `{SUBJECT}`。 */
  opening: string;
  /** 相机语法与主体在画面里的位置（景别只在这里出现一次，见 imagePrompt 发现③）。 */
  camera: string;
  /**
   * 负空间形状/占比 + 显式禁入侵子句。**不许出现具体颜色词**（用 `in the backdrop tone` 指代），
   * 否则覆盖 backdrop 之后这句话会把画面拽回骨架原本的颜色。
   */
  negativeSpace: string;
  /** 行动区：叠层放二维码 / CTA 的那一小块，必须与主体错开。空串表示这一档不预留。 */
  actionZone: string;
  /** 风格专属忌讳（通用基座见 imagePrompt.BASE_NEGATIVES，拼装时合并去重）。 */
  negatives: string[];
}

export interface PosterStyle {
  key: PosterStyleKey;
  /** UI 展示名（后台任务台与配置页都用它，别在前端另建一份目录）。 */
  name: string;
  /** 一句话：什么行业 / 什么诉求的老板用（进宣言提示词，模型据此选档）。 */
  scene: string;
  /** 主角该是什么（人像 / 物件 / 隐喻物）。photo 路线的 subject 槽由模型填，这句是它的约束。 */
  subjectHint: string;
  /** 文字安全区机器标识（渲染层定位用）。 */
  safeZone: SafeZone;
  /** 不可覆盖的结构位。 */
  structure: PosterStyleStructure;
  /** 可覆盖的表现字段缺省值（方案没聊到的字段才用它）。 */
  defaults: PosterStyleDefaults;
  /** 给排版层的字体/字重/走向建议（进 canvasEngine 的 photo 变体提示词）。 */
  typographyHints: string;
  /** 3–5 色，供排版层取标题色与色块（必须是 #RRGGBB）。与 defaults.palette 不是一回事。 */
  palette: string[];
  /** 模式蒸馏出处（合规与可追溯：我们蒸馏了什么模式、没有复制谁的 prompt）。 */
  source: string;
}

/**
 * 12 档档案。字段顺序与底稿一致，便于逐档对读。
 * structure/defaults 里**刻意不写** `no text anywhere in the image` 与 `3:4` ——
 * 那两句由拼装器统一追加在最后（调研发现②：no-text 必须是正文最后一句，写在档案里就会被
 * 负空间子句挤到中间）。档案里若混进 no-text，完整性单测会红。
 */
export const POSTER_STYLES: Record<PosterStyleKey, PosterStyle> = {
  quiet_luxury_grey: {
    key: 'quiet_luxury_grey',
    name: '静奢空间摄影',
    scene: '高客单一对一服务的信任建立——形象顾问、家办/财富顾问、高端家居与整理师、女性成长私教；诉求是「贵而不喧」',
    subjectHint: '一位气质克制的主人公（真人肖像感，半身）',
    safeZone: 'left_third',
    structure: {
      opening: 'Full-bleed editorial photograph of {SUBJECT}',
      camera: 'Camera: medium format 80mm, eye level, waist-up framing, subject placed in the right third.',
      negativeSpace:
        'The entire left third of the frame is bare wall in the backdrop tone — one flat even tone, no props, '
        + 'no furniture edge, no shadow line and no surface texture detail crossing into it, held clear as typography space.',
      actionZone:
        'Inside that reserved band, the lower left corner stays equally flat and unoccupied as a small action area '
        + 'kept completely empty — nothing drawn inside it.',
      negatives: [
        'visible patterns on the reserved wall', 'wide-angle facial distortion', 'glamour retouch',
        'HDR glow', 'oversaturated colour', 'busy background',
      ],
    },
    defaults: {
      backdrop: 'a vast near-empty gallery-like room, warm grey micro-cement walls, nothing else',
      lighting: 'broad soft window light from camera right, two-stop falloff into the corners, gentle wraparound shadow, no hard specular highlights',
      palette: 'high-key desaturated grade with warm undertone',
      material: 'fine natural skin texture retained, editorial retouch, subtle 400-speed grain',
      props: 'one linen curtain, a single sculptural chair',
      mood: '',
      figure: 'wearing undyed ivory or oatmeal cashmere with no visible branding, seated at a low stone table, hands resting on a go board',
    },
    typographyHints: '大字号衬线主标（思源宋体 / Noto Serif，Light–Medium），字距放宽，左对齐压在留白上；副标用极细无衬线小字。忌金色、描边、任何投影。',
    palette: ['#EDEAE4', '#D6D1C8', '#A9A29A', '#6E6862', '#2C2A28'],
    source: '用户参考图 ① + Midjourney「quiet luxury / luxury fashion editorial」社区模式（ImagineBuddy 风格页、Medium《Advanced Midjourney Photography Prompts》系列）；布光采用 prompt-architects 的「光源 + 方向 + 情绪」三段式写法。',
  },

  baroque_icon_gold: {
    key: 'baroque_icon_gold',
    name: '巴洛克圣像金',
    scene: '需要「殿堂感 / 仪式感」的高客单发布——年度大课、私域高阶社群招募、珠宝与艺术品、心理疗愈与灵性成长 IP',
    subjectHint: '一位半身居中的主人公（油画肖像感）',
    safeZone: 'bottom_35',
    structure: {
      opening: 'Baroque devotional oil painting of {SUBJECT}',
      camera: 'Composition: centred half-length figure, head in the upper third.',
      negativeSpace:
        'The bottom 35% of the frame falls away into empty unlit shadow in the backdrop tone — no fabric detail, '
        + 'no hands, no props, no visible canvas texture — one flat plane reserved for the title block.',
      actionZone:
        'The lower right corner of that plane stays the flattest part of it, kept free of brush detail as a small '
        + 'action area kept completely empty — nothing drawn inside it.',
      negatives: [
        'modern clothing', 'plastic 3D render look', 'cartoon face', 'neon colour',
        'flat even lighting', 'religious text on scrolls',
      ],
    },
    defaults: {
      backdrop: 'a near-black umber void, one fold of dark drapery at the upper left',
      lighting: 'single candlelit key high from camera left at 45 degrees, hard chiaroscuro, deep occluded shadow, warm gold rim on cheekbone and shoulder',
      palette: 'deep umber ground with crimson and gilded gold accents',
      material: 'Caravaggio-school modelling, sfumato skin transitions, canvas weave and fine craquelure visible, aged varnish, museum oil texture',
      props: 'holding a white lamb',
      mood: '',
      figure: 'in heavy crimson and deep-green velvet with gold thread embroidery, a thin gilded halo behind the head',
    },
    typographyHints: '金色 / 香槟色衬线（宋体或 Didone 感），居中，字距宽；可加一条极细金线分隔主副标。忌无衬线、忌荧光色、忌左右不对称。',
    palette: ['#0B0A08', '#2A1E12', '#7A4A21', '#C9A227', '#EDE0C2'],
    source: '用户参考图 ② + PromptHero / PromptDen 的 baroque-chiaroscuro 类目共有模式（单烛光 45 度键光、暗棕虚空、金线刺绣天鹅绒、sfumato + craquelure 材质词）。',
  },

  editorial_black_gold: {
    key: 'editorial_black_gold',
    name: '编辑部黑金',
    scene: '峰会 / 私董会 / 高端招募 / 新品发布；财富、商业战略、并购类顾问的权威叙事',
    subjectHint: '一位站姿利落的主人公（胸上景真人肖像感）',
    safeZone: 'top_40',
    structure: {
      opening: 'High-contrast editorial photograph of {SUBJECT}',
      camera: 'Camera: 85mm at f/4, eye level, chest-up framing, subject sitting in the lower right.',
      // ★ 原文写死 `pure unbroken black`：那句话让「背景改成沉稳深灰」这类方案承诺永远兑现不了。
      //   现在只描述形状与禁入侵，颜色跟 backdrop 走。
      negativeSpace:
        'The upper left 40% of the frame stays one unbroken flat field in the backdrop tone with zero detail, '
        + 'no light spill and no gradient banding — a solid field for headline type.',
      actionZone:
        'The lower left corner stays in the same flat backdrop tone, free of rim light and props, as a small action area '
        + 'kept completely empty — nothing drawn inside it.',
      negatives: [
        // 原为 `muddy grey blacks`：背景被方案改成深灰时那条负向词会跟方案打架，改成只否定「浑浊」。
        'muddy backdrop tone', 'gradient banding', 'lens flare crossing the empty area', 'busy props',
        'harsh HDR', 'blown highlights', 'cheap plastic gold sheen', 'floating dust particles in the reserved zone',
      ],
    },
    defaults: {
      backdrop: 'a black seamless studio backdrop with a rich true black point and no ambient fill',
      lighting: 'hard focused key from top left through a small softbox, strong low-key falloff, a thin warm gold rim separating the shoulder from the background, controlled specular on the metal only',
      palette: 'gold-toned highlights against a deep neutral base',
      material: 'crisp commercial retouch',
      props: 'a single brushed-brass vertical element just behind the shoulder',
      mood: '',
      figure: 'in a sharply tailored black suit, hands in pockets, weight on one leg',
    },
    typographyHints: '超粗无衬线（思源黑体 Heavy）或高对比宋体做主标；金色细无衬线做副标与序号；可用金色细线做栏目分隔。',
    palette: ['#000000', '#14110C', '#6B5424', '#C6A34E', '#F2E7CE'],
    source: 'designwiz 商务/活动海报类目的「navy-silver base + bold accent + elegant serif」模式；即梦 20 组海报帖的「金属质感立体字体 + 中央聚焦」维度；PromptHero editorial photography 类目的硬光棚拍布光词汇。',
  },

  neo_chinese_void: {
    key: 'neo_chinese_void',
    name: '新中式留白',
    scene: '茶 / 中医 / 书法 / 国学 / 高端养生 / 律所文化气质；以「稳、静、有根」为卖点的顾问与培训师',
    subjectHint: '一位小小的主人公置于画面右下（东方极简摄影感）',
    safeZone: 'upper_two_thirds',
    structure: {
      opening: 'Oriental minimalist photograph of {SUBJECT}',
      camera: 'Camera: 40mm, eye level, small subject placed in the lower right, vast empty upper field.',
      negativeSpace:
        'The upper two thirds is left empty in the backdrop tone carrying at most a faint gradient — no branches, '
        + 'no seal marks, no wall texture and no shadow intruding — held clear for vertical calligraphic type.',
      actionZone:
        'The lower left corner stays equally empty and shadow-free, a small reserved action area — nothing drawn inside it.',
      negatives: [
        'calligraphy strokes', 'seal stamps', 'red lanterns', 'dragons', 'kitsch chinoiserie',
        'gold ornament', 'cluttered antiques', 'oversaturated red', 'cherry blossoms',
      ],
    },
    defaults: {
      backdrop: 'a rice-paper screen wall in bone white, a slate stone surface, everything else emptied out',
      lighting: 'pale diffused north light, very low contrast, soft ink-like shadow pooling directly under the objects only',
      palette: 'low saturation celadon and mist grey, a faint ink-wash gradient bleeding down from the top edge',
      material: 'fine paper grain',
      props: 'one bare plum branch',
      mood: 'still air, xieyi-style asymmetric balance',
      figure: 'in a loose raw-silk tea robe in bone white, pouring tea or holding a brush',
    },
    typographyHints: '竖排宋体 / 楷体主标，自右上起竖排最贴气质，字距疏；朱红小色块或细印章形做点睛。忌粗黑体、忌横排居中。',
    palette: ['#F6F4EF', '#DCE3DC', '#9FB0A8', '#4A5550', '#8C2B22'],
    source: 'CSDN / 知乎「中国风 Midjourney 关键词」体系的五要素框架（ink wash painting、xieyi 强调留白意境、gongbi 强调勾线）+ 新中式水墨海报模式中的「大面积留白 + 低饱和青绿雾蓝 + 竖版」共性。',
  },

  documentary_film_grain: {
    key: 'documentary_film_grain',
    name: '纪实胶片',
    scene: '匠人、餐饮、实体门店、手作、健身教练、装修与维修服务；诉求是「真实、可信、有人味」，最适合抗「AI 味」质疑的行业',
    subjectHint: '一位正在干活的主人公（抓拍纪实感，不看镜头）',
    safeZone: 'upper_quarter',
    structure: {
      opening: 'Candid documentary photograph of {SUBJECT} at work',
      camera: 'Camera: 35mm at f/2, slight motion blur at the hands, shot slightly off-axis, medium shot.',
      negativeSpace:
        "Keep the wall above the subject's shoulder unoccupied and softly out of focus across the top quarter of the frame "
        + '— no hanging tools, no signage, no window frame — tonally even enough for type to sit on.',
      actionZone:
        'The lower right corner keeps a small patch of plain unlit surface, no clutter and no highlight, as an action area '
        + 'kept completely empty — nothing drawn inside it.',
      negatives: [
        'shop signage', 'studio backdrop', 'beauty retouch', 'posed smile at camera', 'HDR',
        'teal-and-orange grade', 'hanging objects in the reserved zone',
      ],
    },
    defaults: {
      backdrop: 'inside their own workshop, kitchen or shopfront, real working clutter pushed to one side of the frame',
      lighting: 'available light only — late afternoon sun through a dusty window, a hot highlight on the forearm, open shade filling the face',
      palette: 'Kodak Portra 400 emulation, warm true skin tones',
      material: 'organic grain, mild halation, unretouched pores and flyaway hair, RAW look',
      props: '',
      mood: '',
      figure: 'mid-gesture, unaware of the camera',
    },
    typographyHints: '中等粗细无衬线（思源黑体 Regular/Medium）主标 + 手写感副标；小字号、贴边放置，像图片说明（caption）而非海报标题。忌华丽衬线与金色。',
    palette: ['#E8DCC8', '#C99A6A', '#8A6A4F', '#4A3B30', '#2A2320'],
    source: 'Midjourney 写实摄影社区共识模式（指定胶片型号 + ISO + organic grain pattern；--style raw；candid 破摆拍感）+ 知乎「最逼真照片提示词汇总」中的机身/胶片对照表 + immll 光线镜头词表。',
  },

  luxury_magazine_cover: {
    key: 'luxury_magazine_cover',
    name: '奢侈品杂志封面',
    scene: '品牌升级、创始人形象重塑、时尚 / 美业 / 珠宝 / 高端零售的年度主视觉',
    subjectHint: '一位时装封面感的主人公（四分之三身）',
    safeZone: 'top_30',
    structure: {
      opening: 'Fashion cover photograph of {SUBJECT}',
      camera: 'Camera: medium format 110mm at f/8, eye level, three-quarter body, subject centred but shifted low in the frame.',
      negativeSpace:
        'The top 30% of the seamless backdrop is left completely clean and evenly lit in the backdrop tone — no shadow '
        + 'gradient, no hair strays crossing it, no vignette — the masthead zone.',
      actionZone:
        'The lower right corner of the paper stays clean and shadow-free, a small reserved action area — nothing drawn inside it.',
      negatives: [
        'masthead', 'barcode', 'waxy skin', 'cluttered set', 'distracting jewellery glare',
        'wide-angle facial distortion', 'second cast shadow', 'backdrop seams',
      ],
    },
    defaults: {
      backdrop: 'a seamless paper backdrop in warm bone white',
      lighting: 'beauty dish key slightly above and on axis, tight soft key with a crisp shadow under the jaw, subtle silver rim from behind, exactly one deliberate hard cast shadow on the paper in the whole scene',
      palette: 'saturated but controlled colour',
      material: 'flawless editorial skin retouch that still keeps texture, tack-sharp fabric weave',
      props: '',
      mood: '',
      figure: 'in a monochrome sculptural coat, still confident posture, chin level',
    },
    typographyHints: '超大衬线 / 高对比 Didone 感主标，允许被人物肩头少量遮挡（刊头压图是这一档的语法）；细无衬线小字做栏目；全大写英文 + 中文宋体混排。',
    palette: ['#F5F2EE', '#D9C7BC', '#B4423A', '#2E2A27', '#0D0C0B'],
    source: "Vogue / Harper's Bazaar 风格 Midjourney 社区模式（beauty dish 软键光 + 银色轮廓光 + seamless backdrop + editorial skin retouch）+ PromptBase / imaginebuddy 高端时装类目的中画幅长焦小光圈组合。",
  },

  airy_japanese_light: {
    key: 'airy_japanese_light',
    name: '清透日系',
    scene: '亲子 / 教育 / 心理咨询 / 花艺 / 轻食 / 女性向课程与社群；诉求是「温柔、无压迫感、被理解」',
    subjectHint: '一位神情放松的主人公（中近景，不摆拍）',
    safeZone: 'top_40',
    structure: {
      opening: 'Soft natural-light photograph of {SUBJECT}',
      camera: 'Camera: 50mm at f/1.8, shallow focus, medium close-up, subject sitting low in the frame.',
      negativeSpace:
        'The upper 40% washes out to an empty gradient in the backdrop tone with no objects, no curtain folds '
        + 'and no window mullions — soft and even enough to carry light-weight type.',
      actionZone:
        'The upper right corner of that washed field stays the most even part of it, free of flare, as a small action area '
        + 'kept completely empty — nothing drawn inside it.',
      negatives: [
        'heavy shadow', 'dark moody grade', 'saturated colour', 'busy patterns', 'harsh flash',
        'strong vignette', 'curtain folds in the reserved zone',
      ],
    },
    defaults: {
      backdrop: 'a bright pale room, one sheer white curtain, everything washing toward white',
      lighting: 'backlit by a hazy window, blown-out highlight bloom behind the head, soft veiling flare, almost no shadow contrast, high key',
      palette: 'Fujifilm Pro 400H emulation, cool-clean cast, low contrast',
      material: 'slight lens haze, fine grain',
      props: 'a single glass vase',
      mood: 'airy',
      figure: 'gentle unposed expression, in a white cotton shirt, looking slightly away, holding a glass',
    },
    typographyHints: '细无衬线（思源黑体 Light）或细圆体，小字号 + 大字距，居中或左上；点缀极细英文小字。忌粗黑、忌金属质感、忌描边。',
    palette: ['#FFFFFF', '#F2F5F7', '#DCE6E4', '#C8B9B0', '#6F7A7C'],
    source: '日系空气感人像社区模式（逆光 backlight + high key + veiling flare + Fujifilm Pro 400H）+ 知乎 Midjourney 人像提示词框架「摄影主题 + 内容 + 角度 + 焦点 + 光线 + 时间 + 胶片 + 写实词 + 画幅」。',
  },

  cyber_tech_blue: {
    key: 'cyber_tech_blue',
    name: '赛博科技蓝',
    scene: 'SaaS / 智能制造 / AI 服务商 / 行业技术峰会；技术型顾问与解决方案商',
    subjectHint: '一位沉静的技术型主人公（胸上景）',
    safeZone: 'left_third',
    structure: {
      opening: 'Cinematic tech portrait of {SUBJECT}',
      camera: 'Camera: 50mm at f/2.2, slightly low angle, chest-up framing, subject in the right third.',
      negativeSpace:
        'The left 40% is a smooth gradient in the backdrop tone with a single soft glow falloff — no light bars, '
        + 'no cables, no HUD elements, no particles — a quiet field for the headline.',
      actionZone:
        'The lower left corner of that field stays the darkest and flattest part of it, glow-free, as a small action area '
        + 'kept completely empty — nothing drawn inside it.',
      negatives: [
        'HUD text', 'floating code', 'numbers', 'circuit-board clutter', 'neon pink cyberpunk kitsch',
        'lens flare streaks over the empty zone', 'glowing wireframe overlays',
      ],
    },
    defaults: {
      backdrop: 'a dark data-hall corridor, out-of-focus cool blue light bars receding into depth, faint volumetric haze, a reflective dark floor',
      lighting: 'cyan practical rim from behind camera left, cool blue fill, one small warm accent to keep the skin alive, low-key with clean blacks',
      palette: 'deep navy-to-black gradient, restrained glow',
      material: 'crisp micro-contrast, no grain',
      props: '',
      mood: '',
      figure: 'in a dark technical jacket, arms folded, calm and still',
    },
    typographyHints: '现代无衬线（Inter / 思源黑体 Medium）主标 + 等宽小字做数据感副标；青蓝发光细线做分隔；标题可加极细描边。忌宋体、忌金色。',
    palette: ['#05070D', '#0E1B33', '#1F4E8C', '#35A8E0', '#E6F3FF'],
    source: '科技发布会 / keynote 海报类目的共有模式（dark navy gradient、subtle glow behind title、ample negative space、Apple-keynote aesthetic）+ 即梦 20 组海报帖赛博朋克档的「蓝紫 + 金属灰 + 中央聚焦」；已剔除该档常见的霓虹粉俗套。',
  },

  retro_hongkong: {
    key: 'retro_hongkong',
    name: '复古港风',
    scene: '餐饮 / 酒吧 / 夜经济 / 怀旧零售 / 摄影与穿搭 IP / 地方生活服务；诉求是「有氛围、有故事、值得拍照打卡」',
    subjectHint: '一位有故事感的主人公（港片剧照感，中景）',
    safeZone: 'left_third',
    structure: {
      opening: '1990s Hong Kong film still of {SUBJECT}',
      camera: 'Camera: anamorphic 40mm at f/2, framed through a doorway, slight dutch tilt, medium shot.',
      negativeSpace:
        'An unlit wall panel occupies the left edge for a third of the frame width — deep, flat and detail-free '
        + 'in the backdrop tone, no signage and no neon spill reaching it — so vertical type can sit on it.',
      actionZone:
        'The lower left corner of that panel stays the flattest part of it, free of colour spill, as a small action area '
        + 'kept completely empty — nothing drawn inside it.',
      negatives: [
        'Chinese signage', 'neon lettering', 'shop banners', 'modern smartphones', 'modern LED panels',
        'clean digital look', 'over-clean skin', 'cosplay costume feel', 'neon reflection in the reserved panel',
      ],
    },
    defaults: {
      backdrop: 'a tiled stair landing, a rain-wet alley or a diner booth',
      lighting: 'mixed practicals — a green fluorescent tube overhead, magenta neon spill from the right, warm tungsten from below, heavy colour crosstalk across the skin',
      palette: 'expired-film colour shift, crushed teal shadows',
      material: 'visible grain and gate weave, faint vertical smear on the highlights',
      props: '',
      mood: 'nostalgic',
      figure: 'in a silk qipao or an open-collar shirt, leaning',
    },
    typographyHints: '竖排粗宋体或复古美术字（隶书 / 魏碑感），高饱和红或青；可叠半透明色块提升可读性；小字用等宽英文。',
    palette: ['#0E1412', '#12463C', '#C7203A', '#E8A33D', '#F0E6D2'],
    source: 'Midlibrary 的 Wong Kar-wai 风格描述（浓郁红 / 深绿 / 霓虹蓝、怀旧氛围）+ 复古港风教程的六段式提示词结构（主体 + 风格 + 色调 + 类型 + 细节 + 优化）+ 过期胶片与 anamorphic 质感词汇。',
  },

  glossy_3d_trend: {
    key: 'glossy_3d_trend',
    name: '3D 潮流',
    scene: '快消 / 新零售 / 门店活动 / 年轻向社群；促销、节点营销、小程序与 App 上新',
    subjectHint: '一件产品或物件作主角（**不要人物**，这一档出人就翻车）',
    safeZone: 'top_40',
    structure: {
      opening: 'Studio 3D render: {SUBJECT} as a single hero object floating slightly above a soft curved backdrop',
      camera: 'Composition: hero centred low in the frame, generous headroom, wide gently curved backdrop.',
      negativeSpace:
        'The curved backdrop above the hero stays an unbroken soft gradient in the backdrop tone across the top 40% '
        + '— no floating props, no cast shadows, no reflections and no orbiting elements enter it.',
      actionZone:
        'The upper right corner of that gradient stays the flattest part of it, kicker-free, as a small action area '
        + 'kept completely empty — nothing drawn inside it.',
      negatives: [
        'human hands', 'human figures', 'cluttered props', 'chromatic noise', 'low-poly artifacts',
        'burnt sharp highlights', 'photoreal skin', 'muddy dark render', 'props drifting into the reserved zone',
      ],
    },
    defaults: {
      backdrop: 'a wide gently curved seamless studio backdrop',
      lighting: 'large HDRI studio softbox from the front top, two coloured gradient kickers left and right, a clean contact shadow beneath the hero, no blown speculars',
      palette: 'clean saturated candy colour',
      material: 'glossy soft-touch plastic, frosted glass, one brushed chrome accent, subtle subsurface glow, Octane-grade clean render, physically accurate reflections, gentle bloom, candy-clean surfaces',
      props: 'a few small geometric props orbiting it at a distance',
      mood: '',
      figure: '',
    },
    typographyHints: '圆润粗无衬线或膨胀感立体字（阿里巴巴普惠体 Heavy / 得意黑），高饱和撞色；可用描边与硬投影。忌衬线、忌细体。',
    palette: ['#FFE066', '#FF7A59', '#6C5CE7', '#2BD9C4', '#FFFFFF'],
    source: 'Promptomania / PromptHero 的 3D-render 类目公认要素（材质 + 光照方案 + 渲染器 + 相机四段）+ 即梦海报帖「毛绒/Q弹材质字体 + 彩色撞色」档的配色逻辑。',
  },

  mono_authority_portrait: {
    key: 'mono_authority_portrait',
    name: '黑白权威肖像',
    scene: '律师 / 财税 / 医生 / 管理咨询 / 讲师；要「可信、克制、不花哨」的专家 IP。调研中发现的最高性价比一档——单光位黑白最不容易出 AI 味翻车',
    subjectHint: '一位目光笃定的专家（紧凑肩上景真人肖像感）',
    safeZone: 'left_half',
    structure: {
      opening: 'Black and white portrait of {SUBJECT}',
      camera: 'Camera: 85mm at f/2.8, eye level, tight head-and-shoulders, subject occupying the right half.',
      negativeSpace:
        'The left half is smooth wall in the backdrop tone falling gently to shadow, entirely featureless — no texture, '
        + 'no second light edge, no shoulder intruding — the block reserved for name and title type.',
      actionZone:
        'The lower left corner of that block stays the most even part of it, free of falloff banding, as a small action area '
        + 'kept completely empty — nothing drawn inside it.',
      negatives: [
        'colour tint', 'sepia', 'skin smoothing', 'glamour glow', 'hard on-camera flash',
        'dramatic fog', 'second catchlight',
      ],
    },
    defaults: {
      backdrop: 'a mid-grey painted wall, nothing else in the scene',
      lighting: 'one large softbox at camera left 45 degrees with a black flag on the right side, deep unfilled shadow side, a catchlight in both eyes',
      palette: 'full tonal range from paper white to true black, silver-gelatin tonality',
      material: 'real skin texture and lines kept, no smoothing, fine grain',
      props: '',
      mood: 'timeless and unadorned',
      figure: 'in a plain dark shirt or jacket, direct steady gaze, hands loosely visible',
    },
    typographyHints: '中粗无衬线全大写英文 + 中文黑体做姓名，字距极宽；细线分隔职称；姓名与职称严格左对齐成一列。忌金色、忌花体、忌居中。',
    palette: ['#FFFFFF', '#C9C9C9', '#7A7A7A', '#3A3A3A', '#000000'],
    source: 'Midlibrary 的 Peter Lindbergh 风格描述（黑白、强对比、自然光、极简背景、close-up framing、raw beauty）+ PromptLibrary 单柔光箱 45 度 / 黑旗遮光 / 85mm f2.8 / 黑背景的布光模式蒸馏。',
  },

  surreal_object_metaphor: {
    key: 'surreal_object_metaphor',
    name: '超现实隐喻静物',
    scene: '不愿露脸的老板，以及方法论 / 理念型主张（「破局」「复利」「第二曲线」「增长飞轮」）。无人像即无肖像风险，也无 AI 人脸翻车风险',
    subjectHint: '一个单一隐喻物（**不要人物**；如一把立着的铜钥匙、一株从裂陶碗里长出的苗）',
    safeZone: 'above_lower_third',
    structure: {
      opening: 'Conceptual still-life photograph: {SUBJECT} as the only subject, placed on a wide seamless surface',
      camera: 'Camera: 100mm macro at f/8, slightly above eye level, the object small in the lower third.',
      negativeSpace:
        "Everything above the lower third is empty graded background in the backdrop tone — the object's cast shadow "
        + 'must not enter it, no secondary props, no dust concentration, no vignette at the edges.',
      actionZone:
        'The upper right corner of that empty field stays the most even part of it, gradient-free, as a small action area '
        + 'kept completely empty — nothing drawn inside it.',
      negatives: [
        'human figure', 'hands', 'cluttered arrangement', 'multiple unexplained floating objects',
        'glossy plastic CGI look', 'busy patterns', 'harsh vignette', 'second light source',
        'reflections in the reserved area',
      ],
    },
    defaults: {
      backdrop: 'a large empty studio field in warm bone grey',
      lighting: 'a single hard sun-like source high from camera right, long directional shadow, gentle gradient falloff across the background',
      palette: 'warm bone grey tonality',
      material: 'gallery still-life realism, matte surfaces, museum-clean, no distracting reflections',
      props: 'faint dust in the air',
      mood: 'quiet drama, exaggerated emptiness above the object',
      figure: '',
    },
    typographyHints: '大字号衬线或极粗黑体承载单句主张（8–12 字最佳），居上或垂直居中；小字做落款与二维码位；可用一条极细线压住标题底部。',
    palette: ['#E4DED2', '#C4B49A', '#8A7A62', '#4A4438', '#1C1A16'],
    source: 'Galaxy.ai / PromptHero 超现实与概念编辑类目的核心模式——「单一隐喻物 + 极简场景 + 材质质感优先于概念本身」（社区共识：概念的质感才是一切）+ designwiz 的「用途 + 艺术运动 + 层级 + 色彩情绪 + 字体气质 + 情绪 + 画幅」海报公式。',
  },
};

export const POSTER_STYLE_LIST: PosterStyle[] = POSTER_STYLE_KEYS.map((k) => POSTER_STYLES[k]);

/**
 * scene → 默认风格档。模型给的 styleKey 不在白名单（或压根没给）时按此回退。
 *
 * 选档理由（不是随手配的）：
 *   · `personal_brand` → 黑白权威肖像：调研里性价比最高的一档，单光位黑白最不容易出 AI 味翻车，
 *     而个人品牌恰恰最怕「一眼假」；
 *   · `event` → 编辑部黑金：峰会/发布会的既定语法，上部 40% 纯黑留白天然适合大标题；
 *   · `service` → 静奢空间摄影：高客单一对一服务的信任建立（顾问类占本产品客群的大头）；
 *   · `product` → 3D 潮流：唯一以「物件」为主角的档（结构位写的也是 hero object），
 *     产品海报套人像档必然违和。
 */
export const SCENE_DEFAULT_STYLE: Record<PosterScene, PosterStyleKey> = {
  personal_brand: 'mono_authority_portrait',
  event: 'editorial_black_gold',
  service: 'quiet_luxury_grey',
  product: 'glossy_3d_trend',
};

export function isPosterStyleKey(v: unknown): v is PosterStyleKey {
  return typeof v === 'string' && (POSTER_STYLE_KEYS as readonly string[]).includes(v);
}

/**
 * 归一 styleKey：白名单外（含空值、模型自造的档名）一律按 scene 回退默认档。
 * **不抛错**：模型选了个不存在的风格不该让付费任务失败，也不该让整条 photo 路线作废。
 */
export function normalizeStyleKey(raw: unknown, scene: PosterScene): PosterStyleKey {
  return isPosterStyleKey(raw) ? raw : SCENE_DEFAULT_STYLE[scene];
}

export function posterStyle(raw: unknown, scene: PosterScene): PosterStyle {
  return POSTER_STYLES[normalizeStyleKey(raw, scene)];
}

/** styleKey → 中文展示名。未知 key 返回空串（对外视图据此决定发不发这个字段）。 */
export function posterStyleName(raw: unknown): string {
  return isPosterStyleKey(raw) ? POSTER_STYLES[raw].name : '';
}

/** 档案清单摘要（进宣言提示词：模型据此选档并写出配得上这一档的 subject）。 */
export function styleCatalogDigest(allowed?: readonly PosterStyleKey[]): string {
  return POSTER_STYLE_LIST
    .filter((s) => !allowed || allowed.includes(s.key))
    .map((s) => `- ${s.key}｜${s.name}：${s.scene}。主体：${s.subjectHint}`)
    .join('\n');
}
