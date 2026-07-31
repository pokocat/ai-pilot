# 军师 · 影像主导海报 风格档案库 v1

> **工程约定**（2026-07-30 落码时补记）：本文件是人类可读底稿，**运行时不要用 `fs` 读取**
> （生产镜像只含 `dist/`，不含 `src/`）。代码侧的唯一真源是
> `server/src/services/creative/styleLibrary.ts`（12 档 typed 常量）与 `imagePrompt.ts`（拼装器）；
> 改档案必须同步改那两个文件，反之亦然，否则视为文档与代码不一致（AGENTS.md §0）。
> 落码时的两处刻意偏离已在 `styleLibrary.ts` 文件头注明：
> ① 主体槽位统一归一成 `{SUBJECT}`（原文里 `{SUBJECT_OBJECT}` / `{METAPHOR_OBJECT}` 是同一个位置）；
> ② 带默认值的槽位（`{WARDROBE: …}` 这类）在拼装时**去掉花括号只留内容**，让最终 prompt 是通顺英文散文
> ——把字面 `{}` 发给生图模型没有意义。
>
> 用途：影像主导路线的风格选型与 prompt 拼装。顶级图片模型（即梦 / Seedream / Midjourney 档）生成**全幅无文字主视觉**，中文标题与信息由确定性渲染层叠加。
> 目标客群：中小企业主的个人品牌 / 服务宣传（顾问、课程、活动、专家 IP）。
> 声明：以下 prompt 骨架均为**模式与词汇的蒸馏重组**，非任何单条社区 prompt 的复制。来源仅标注模式出处。

## 字段约定（代码消费）

每个风格档案为一个 `##` 段，字段固定顺序、固定小标题：

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | snake_case string | 唯一标识 |
| `中文名` | string | UI 展示名 |
| `适用场景` | string | 一句话：什么行业 / 什么诉求的老板用 |
| `safe_zone` | enum | 文字安全区机器标识，供渲染层定位。取值：`left_third` `right_third` `top_40` `top_30` `bottom_35` `bottom_40` `upper_two_thirds` `left_half` `upper_quarter` `above_lower_third` |
| `image_prompt` | string (EN) | prompt 骨架，`{}` 为槽位，末尾固定 `3:4` |
| `负空间指令` | string (EN) | 追加在 image_prompt 之后。**这是海报与普通图的唯一分界，不可省略** |
| `负向清单` | string list | 通用基座（见文末）+ 风格专属忌讳 |
| `排版气质` | string | 给排版层的字体/字重/走向建议 |
| `palette` | hex list | 3–5 色，供渲染层取标题色与色块 |
| `来源` | string | 模式蒸馏出处 |

**全局硬约束**：所有 prompt 正文末尾必须显式写 `no text anywhere in the image` —— 不能只依赖负向框，否则模型极易在留白区自行生成乱码文字，直接毁掉叠加层。

---

## quiet_luxury_grey

### key
`quiet_luxury_grey`

### 中文名
静奢空间摄影

### 适用场景
高客单一对一服务的信任建立——形象顾问、家办/财富顾问、高端家居与整理师、女性成长私教；诉求是"贵而不喧"。

### safe_zone
`left_third`

### image_prompt
```
Full-bleed editorial photograph of {SUBJECT}, wearing {WARDROBE: undyed ivory or oatmeal cashmere, no visible branding}, {ACTION: seated at a low stone table, hands resting on a go board}. Environment: a vast near-empty gallery-like room, warm grey micro-cement walls, one linen curtain, a single sculptural chair, nothing else. Lighting: broad soft window light from camera right, two-stop falloff into the corners, gentle wraparound shadow, no hard specular highlights. Camera: medium format 80mm, eye level, waist-up framing, subject placed in the right third. Finish: high-key desaturated grade with warm undertone, fine natural skin texture retained, editorial retouch, subtle 400-speed grain. no text anywhere in the image. 3:4
```

### 负空间指令
```
The entire left third of the frame is bare wall — one flat even tone, no props, no furniture edge, no shadow line and no surface texture detail crossing into it, held clear as typography space.
```

### 负向清单
`text, lettering, watermark, logo, brand marks, signature, deformed hands, extra fingers, plastic skin, HDR glow, oversaturated colour, busy background, visible patterns on the reserved wall, wide-angle facial distortion, glamour retouch`

### 排版气质
大字号衬线主标（思源宋体 / Noto Serif，Light–Medium），字距放宽，左对齐压在留白上；副标用极细无衬线小字。忌金色、描边、任何投影。

### palette
`#EDEAE4` `#D6D1C8` `#A9A29A` `#6E6862` `#2C2A28`

### 来源
用户参考图 ① + Midjourney "quiet luxury / luxury fashion editorial" 社区模式（ImagineBuddy 风格页、Medium《Advanced Midjourney Photography Prompts》系列）；布光采用 prompt-architects 的「光源 + 方向 + 情绪」三段式写法。

---

## baroque_icon_gold

### key
`baroque_icon_gold`

### 中文名
巴洛克圣像金

### 适用场景
需要"殿堂感 / 仪式感"的高客单发布——年度大课、私域高阶社群招募、珠宝与艺术品、心理疗愈与灵性成长 IP。

### safe_zone
`bottom_35`

### image_prompt
```
Baroque devotional oil painting of {SUBJECT}, {WARDROBE: heavy crimson and deep-green velvet with gold thread embroidery}, holding {PROP: a white lamb}, a thin gilded halo behind the head. Environment: a near-black umber void, one fold of dark drapery at the upper left. Lighting: single candlelit key high from camera left at 45 degrees, hard chiaroscuro, deep occluded shadow, warm gold rim on cheekbone and shoulder. Composition: centred half-length figure, head in the upper third, canvas weave and fine craquelure visible, aged varnish. Finish: Caravaggio-school modelling, sfumato skin transitions, museum oil texture. no text anywhere in the image. 3:4
```

### 负空间指令
```
The bottom 35% of the frame falls away into near-black empty shadow — no fabric detail, no hands, no props, no visible canvas texture — one flat dark plane reserved for the title block.
```

### 负向清单
`text, lettering, watermark, signature, modern clothing, plastic 3D render look, cartoon face, deformed hands, extra fingers, over-symmetrical AI face, neon colour, flat even lighting, cluttered background, religious text on scrolls`

### 排版气质
金色 / 香槟色衬线（宋体或 Didone 感），居中，字距宽；可加一条极细金线分隔主副标。忌无衬线、忌荧光色、忌左右不对称。

### palette
`#0B0A08` `#2A1E12` `#7A4A21` `#C9A227` `#EDE0C2`

### 来源
用户参考图 ② + PromptHero / PromptDen 的 baroque-chiaroscuro 类目共有模式（单烛光 45 度键光、暗棕虚空、金线刺绣天鹅绒、sfumato + craquelure 材质词）。

---

## editorial_black_gold

### key
`editorial_black_gold`

### 中文名
编辑部黑金

### 适用场景
峰会 / 私董会 / 高端招募 / 新品发布；财富、商业战略、并购类顾问的权威叙事。

### safe_zone
`top_40`

### image_prompt
```
High-contrast editorial photograph of {SUBJECT} in {WARDROBE: a sharply tailored black suit}, {ACTION: hands in pockets, weight on one leg}. Environment: black seamless studio backdrop, a single brushed-brass vertical element just behind the shoulder. Lighting: hard focused key from top left through a small softbox, strong low-key falloff, a thin warm gold rim separating the shoulder from the black, controlled specular on the metal only. Camera: 85mm at f/4, eye level, chest-up framing, subject sitting in the lower right. Finish: rich true black point, gold-toned highlights, crisp commercial retouch, no ambient fill. no text anywhere in the image. 3:4
```

### 负空间指令
```
The upper left 40% of the frame stays pure unbroken black with zero detail, no light spill and no gradient banding — a solid field for headline type.
```

### 负向清单
`text, watermark, logo, deformed hands, muddy grey blacks, gradient banding, lens flare crossing the empty area, busy props, harsh HDR, blown highlights, cheap plastic gold sheen, floating dust particles in the reserved zone`

### 排版气质
超粗无衬线（思源黑体 Heavy）或高对比宋体做主标；金色细无衬线做副标与序号；可用金色细线做栏目分隔。

### palette
`#000000` `#14110C` `#6B5424` `#C6A34E` `#F2E7CE`

### 来源
designwiz 商务/活动海报类目的 "navy-silver base + bold accent + elegant serif" 模式；即梦 20 组海报帖的「金属质感立体字体 + 中央聚焦」维度；PromptHero editorial photography 类目的硬光棚拍布光词汇。

---

## neo_chinese_void

### key
`neo_chinese_void`

### 中文名
新中式留白

### 适用场景
茶 / 中医 / 书法 / 国学 / 高端养生 / 律所文化气质；以"稳、静、有根"为卖点的顾问与培训师。

### safe_zone
`upper_two_thirds`

### image_prompt
```
Oriental minimalist photograph of {SUBJECT} in {WARDROBE: a loose raw-silk tea robe in bone white}, {ACTION: pouring tea, holding a brush}. Environment: a rice-paper screen wall, one bare plum branch, a slate stone surface, everything else emptied out. Lighting: pale diffused north light, very low contrast, soft ink-like shadow pooling directly under the objects only. Composition: 40mm, eye level, small subject placed in the lower right, vast empty upper field, xieyi-style asymmetric balance, a faint ink-wash gradient bleeding down from the top edge. Finish: low saturation celadon and mist grey, fine paper grain, still air. no text anywhere in the image. 3:4
```

### 负空间指令
```
The upper two thirds is empty rice-paper white carrying only a faint ink gradient — no branches, no seal marks, no wall texture and no shadow intruding — held clear for vertical calligraphic type.
```

### 负向清单
`text, calligraphy strokes, seal stamps, watermark, logo, red lanterns, dragons, kitsch chinoiserie, gold ornament, cluttered antiques, deformed hands, oversaturated red, cherry blossoms`

### 排版气质
竖排宋体 / 楷体主标，自右上起竖排最贴气质，字距疏；朱红小色块或细印章形做点睛。忌粗黑体、忌横排居中。

### palette
`#F6F4EF` `#DCE3DC` `#9FB0A8` `#4A5550` `#8C2B22`

### 来源
CSDN / 知乎「中国风 Midjourney 关键词」体系的五要素框架（ink wash painting、xieyi 强调留白意境、gongbi 强调勾线）+ 新中式水墨海报模式中的「大面积留白 + 低饱和青绿雾蓝 + 竖版」共性。

---

## documentary_film_grain

### key
`documentary_film_grain`

### 中文名
纪实胶片

### 适用场景
匠人、餐饮、实体门店、手作、健身教练、装修与维修服务；诉求是"真实、可信、有人味"，最适合抗"AI 味"质疑的行业。

### safe_zone
`upper_quarter`

### image_prompt
```
Candid documentary photograph of {SUBJECT} at work, {ACTION: mid-gesture, unaware of the camera}, inside {ENV: their own workshop, kitchen, or shopfront}, real working clutter pushed to one side of the frame. Lighting: available light only — late afternoon sun through a dusty window, a hot highlight on the forearm, open shade filling the face. Camera: 35mm at f/2, slight motion blur at the hands, shot slightly off-axis, medium shot. Finish: Kodak Portra 400 emulation, organic grain, warm true skin tones, mild halation, unretouched pores and flyaway hair, RAW look. no text anywhere in the image. 3:4
```

### 负空间指令
```
Keep the wall above the subject's shoulder unoccupied and softly out of focus across the top quarter of the frame — no hanging tools, no signage, no window frame — tonally even enough for type to sit on.
```

### 负向清单
`text, shop signage, watermark, logo, studio backdrop, beauty retouch, plastic skin, posed smile at camera, HDR, teal-and-orange grade, deformed hands, hanging objects in the reserved zone`

### 排版气质
中等粗细无衬线（思源黑体 Regular/Medium）主标 + 手写感副标；小字号、贴边放置，像图片说明（caption）而非海报标题。忌华丽衬线与金色。

### palette
`#E8DCC8` `#C99A6A` `#8A6A4F` `#4A3B30` `#2A2320`

### 来源
Midjourney 写实摄影社区共识模式（指定胶片型号 + ISO + organic grain pattern；`--style raw`；`candid` 破摆拍感）+ 知乎「最逼真照片提示词汇总」中的机身/胶片对照表 + immll 光线镜头词表。

---

## luxury_magazine_cover

### key
`luxury_magazine_cover`

### 中文名
奢侈品杂志封面

### 适用场景
品牌升级、创始人形象重塑、时尚 / 美业 / 珠宝 / 高端零售的年度主视觉。

### safe_zone
`top_30`

### image_prompt
```
Fashion cover photograph of {SUBJECT} in {WARDROBE: a monochrome sculptural coat}, still confident posture, chin level. Environment: a seamless paper backdrop in {BACKDROP_COLOUR}, one deliberate hard cast shadow on the paper. Lighting: beauty dish key slightly above and on axis, tight soft key with a crisp shadow under the jaw, subtle silver rim from behind, exactly one hard shadow in the scene. Camera: medium format 110mm at f/8, eye level, three-quarter body, subject centred but shifted low in the frame. Finish: flawless editorial skin retouch that still keeps texture, saturated but controlled colour, tack-sharp fabric weave. no text anywhere in the image. 3:4
```

### 负空间指令
```
The top 30% of the seamless backdrop is left completely clean and evenly lit — no shadow gradient, no hair strays crossing it, no vignette — the masthead zone.
```

### 负向清单
`text, masthead, barcode, watermark, logo, deformed hands, extra fingers, waxy skin, cluttered set, distracting jewellery glare, wide-angle facial distortion, second cast shadow, backdrop seams`

### 排版气质
超大衬线 / 高对比 Didone 感主标，允许被人物肩头少量遮挡（刊头压图是这一档的语法）；细无衬线小字做栏目；全大写英文 + 中文宋体混排。

### palette
`#F5F2EE` `#D9C7BC` `#B4423A` `#2E2A27` `#0D0C0B`

### 来源
Vogue / Harper's Bazaar 风格 Midjourney 社区模式（beauty dish 软键光 + 银色轮廓光 + seamless backdrop + editorial skin retouch）+ PromptBase / imaginebuddy 高端时装类目的中画幅长焦小光圈组合。

---

## airy_japanese_light

### key
`airy_japanese_light`

### 中文名
清透日系

### 适用场景
亲子 / 教育 / 心理咨询 / 花艺 / 轻食 / 女性向课程与社群；诉求是"温柔、无压迫感、被理解"。

### safe_zone
`top_40`

### image_prompt
```
Soft natural-light photograph of {SUBJECT}, gentle unposed expression, {WARDROBE: a white cotton shirt}, {ACTION: looking slightly away, holding a glass}. Environment: a bright pale room, one sheer white curtain, a single glass vase, everything washing toward white. Lighting: backlit by a hazy window, blown-out highlight bloom behind the head, soft veiling flare, almost no shadow contrast, high key. Camera: 50mm at f/1.8, slight lens haze, shallow focus, medium close-up, subject sitting low in the frame. Finish: Fujifilm Pro 400H emulation, cool-clean cast, low contrast, fine grain, airy. no text anywhere in the image. 3:4
```

### 负空间指令
```
The upper 40% washes to a near-white empty gradient with no objects, no curtain folds and no window mullions — soft and even enough to carry light-weight type.
```

### 负向清单
`text, watermark, logo, heavy shadow, dark moody grade, saturated colour, deformed hands, plastic skin, busy patterns, harsh flash, strong vignette, curtain folds in the reserved zone`

### 排版气质
细无衬线（思源黑体 Light）或细圆体，小字号 + 大字距，居中或左上；点缀极细英文小字。忌粗黑、忌金属质感、忌描边。

### palette
`#FFFFFF` `#F2F5F7` `#DCE6E4` `#C8B9B0` `#6F7A7C`

### 来源
日系空气感人像社区模式（逆光 backlight + high key + veiling flare + Fujifilm Pro 400H）+ 知乎 Midjourney 人像提示词框架「摄影主题 + 内容 + 角度 + 焦点 + 光线 + 时间 + 胶片 + 写实词 + 画幅」。

---

## cyber_tech_blue

### key
`cyber_tech_blue`

### 中文名
赛博科技蓝

### 适用场景
SaaS / 智能制造 / AI 服务商 / 行业技术峰会；技术型顾问与解决方案商。

### safe_zone
`left_third`

### image_prompt
```
Cinematic tech portrait of {SUBJECT} in {WARDROBE: a dark technical jacket}, arms folded, calm and still. Environment: a dark data-hall corridor, out-of-focus cool blue light bars receding into depth, faint volumetric haze, a reflective dark floor. Lighting: cyan practical rim from behind camera left, cool blue fill, one small warm accent to keep the skin alive, low-key with clean blacks. Camera: 50mm at f/2.2, slightly low angle, chest-up framing, subject in the right third. Finish: deep navy-to-black gradient, restrained glow, crisp micro-contrast, no grain. no text anywhere in the image. 3:4
```

### 负空间指令
```
The left 40% is a smooth dark navy gradient with a single soft glow falloff — no light bars, no cables, no HUD elements, no particles — a quiet field for the headline.
```

### 负向清单
`text, HUD text, floating code, numbers, watermark, logo, circuit-board clutter, neon pink cyberpunk kitsch, lens flare streaks over the empty zone, deformed hands, plastic 3D skin, glowing wireframe overlays`

### 排版气质
现代无衬线（Inter / 思源黑体 Medium）主标 + 等宽小字做数据感副标；青蓝发光细线做分隔；标题可加极细描边。忌宋体、忌金色。

### palette
`#05070D` `#0E1B33` `#1F4E8C` `#35A8E0` `#E6F3FF`

### 来源
科技发布会 / keynote 海报类目的共有模式（dark navy gradient、subtle glow behind title、ample negative space、Apple-keynote aesthetic）+ 即梦 20 组海报帖赛博朋克档的「蓝紫 + 金属灰 + 中央聚焦」；已剔除该档常见的霓虹粉俗套。

---

## retro_hongkong

### key
`retro_hongkong`

### 中文名
复古港风

### 适用场景
餐饮 / 酒吧 / 夜经济 / 怀旧零售 / 摄影与穿搭 IP / 地方生活服务；诉求是"有氛围、有故事、值得拍照打卡"。

### safe_zone
`left_third`

### image_prompt
```
1990s Hong Kong film still of {SUBJECT} in {WARDROBE: a silk qipao or an open-collar shirt}, leaning at {ENV: a tiled stair landing, a rain-wet alley, a diner booth}. Lighting: mixed practicals — a green fluorescent tube overhead, magenta neon spill from the right, warm tungsten from below, heavy colour crosstalk across the skin. Camera: anamorphic 40mm at f/2, framed through a doorway, slight dutch tilt, medium shot. Finish: expired-film colour shift, crushed teal shadows, visible grain and gate weave, faint vertical smear on the highlights, nostalgic. no text anywhere in the image. 3:4
```

### 负空间指令
```
An unlit dark wall panel occupies the left edge for a third of the frame width — deep, flat and detail-free, no signage and no neon spill reaching it — so vertical type can sit on it.
```

### 负向清单
`text, Chinese signage, neon lettering, shop banners, watermark, logo, modern smartphones, modern LED panels, clean digital look, deformed hands, over-clean skin, cosplay costume feel, neon reflection in the reserved panel`

### 排版气质
竖排粗宋体或复古美术字（隶书 / 魏碑感），高饱和红或青；可叠半透明色块提升可读性；小字用等宽英文。

### palette
`#0E1412` `#12463C` `#C7203A` `#E8A33D` `#F0E6D2`

### 来源
Midlibrary 的 Wong Kar-wai 风格描述（浓郁红 / 深绿 / 霓虹蓝、怀旧氛围）+ 复古港风教程的六段式提示词结构（主体 + 风格 + 色调 + 类型 + 细节 + 优化）+ 过期胶片与 anamorphic 质感词汇。

---

## glossy_3d_trend

### key
`glossy_3d_trend`

### 中文名
3D 潮流

### 适用场景
快消 / 新零售 / 门店活动 / 年轻向社群；促销、节点营销、小程序与 App 上新。

### safe_zone
`top_40`

### image_prompt
```
Studio 3D render: {SUBJECT_OBJECT} as a single hero object floating slightly above a soft curved backdrop, {PROP} orbiting it at a distance. Materials: glossy soft-touch plastic, frosted glass, one brushed chrome accent, subtle subsurface glow. Lighting: large HDRI studio softbox from the front top, two coloured gradient kickers left and right, a clean contact shadow beneath the hero, no blown speculars. Composition: hero centred low in the frame, generous headroom, wide gently curved backdrop. Finish: Octane-grade clean render, physically accurate reflections, gentle bloom, candy-clean surfaces. no text anywhere in the image. 3:4
```

### 负空间指令
```
The curved backdrop above the hero stays an unbroken soft colour gradient across the top 40% — no floating props, no cast shadows, no reflections and no orbiting elements enter it.
```

### 负向清单
`text, watermark, logo, human hands, human figures, cluttered props, chromatic noise, low-poly artifacts, burnt sharp highlights, photoreal skin, muddy dark render, props drifting into the reserved zone`

### 排版气质
圆润粗无衬线或膨胀感立体字（阿里巴巴普惠体 Heavy / 得意黑），高饱和撞色；可用描边与硬投影。忌衬线、忌细体。

### palette
`#FFE066` `#FF7A59` `#6C5CE7` `#2BD9C4` `#FFFFFF`

### 来源
Promptomania / PromptHero 的 3D-render 类目公认要素（材质 + 光照方案 + 渲染器 + 相机四段）+ 即梦海报帖「毛绒/Q弹材质字体 + 彩色撞色」档的配色逻辑。

---

## mono_authority_portrait

### key
`mono_authority_portrait`

### 中文名
黑白权威肖像

### 适用场景
律师 / 财税 / 医生 / 管理咨询 / 讲师；要"可信、克制、不花哨"的专家 IP。**调研中发现的最高性价比一档**——单光位黑白最不容易出 AI 味翻车。

### safe_zone
`left_half`

### image_prompt
```
Black and white portrait of {SUBJECT} in {WARDROBE: a plain dark shirt or jacket}, direct steady gaze, hands loosely visible. Environment: a mid-grey painted wall, nothing else in the scene. Lighting: one large softbox at camera left 45 degrees with a black flag on the right side, deep unfilled shadow side, a catchlight in both eyes, full tonal range from paper white to true black. Camera: 85mm at f/2.8, eye level, tight head-and-shoulders, subject occupying the right half. Finish: silver-gelatin tonality, real skin texture and lines kept, no smoothing, fine grain, timeless and unadorned. no text anywhere in the image. 3:4
```

### 负空间指令
```
The left half is smooth mid-grey wall falling gently to shadow, entirely featureless — no texture, no second light edge, no shoulder intruding — the block reserved for name and title type.
```

### 负向清单
`text, watermark, logo, colour tint, sepia, deformed hands, skin smoothing, glamour glow, busy background, hard on-camera flash, dramatic fog, second catchlight, over-symmetrical face`

### 排版气质
中粗无衬线全大写英文 + 中文黑体做姓名，字距极宽；细线分隔职称；姓名与职称严格左对齐成一列。忌金色、忌花体、忌居中。

### palette
`#FFFFFF` `#C9C9C9` `#7A7A7A` `#3A3A3A` `#000000`

### 来源
Midlibrary 的 Peter Lindbergh 风格描述（黑白、强对比、自然光、极简背景、close-up framing、raw beauty）+ PromptLibrary 单柔光箱 45 度 / 黑旗遮光 / 85mm f2.8 / 黑背景的布光模式蒸馏。

---

## surreal_object_metaphor

### key
`surreal_object_metaphor`

### 中文名
超现实隐喻静物

### 适用场景
**不愿露脸的老板**，以及方法论 / 理念型主张（"破局""复利""第二曲线""增长飞轮"）。无人像即无肖像风险，也无 AI 人脸翻车风险。

### safe_zone
`above_lower_third`

### image_prompt
```
Conceptual still-life photograph: {METAPHOR_OBJECT: a single brass key standing upright, a staircase of stacked stone slabs, one sprouting seedling in a cracked ceramic bowl} as the only subject, placed on a wide seamless surface. Environment: a large empty studio field in {BACKDROP_COLOUR}, one long soft cast shadow, faint dust in the air. Lighting: a single hard sun-like source high from camera right, long directional shadow, gentle gradient falloff across the background, quiet drama. Camera: 100mm macro at f/8, slightly above eye level, the object small in the lower third, exaggerated emptiness above it. Finish: gallery still-life realism, matte surfaces, museum-clean, no distracting reflections. no text anywhere in the image. 3:4
```

### 负空间指令
```
Everything above the lower third is empty graded background — the object's cast shadow must not enter it, no secondary props, no dust concentration, no vignette at the edges.
```

### 负向清单
`text, watermark, logo, human figure, hands, cluttered arrangement, multiple unexplained floating objects, glossy plastic CGI look, busy patterns, harsh vignette, second light source, reflections in the reserved area`

### 排版气质
大字号衬线或极粗黑体承载**单句主张（8–12 字最佳）**，居上或垂直居中；小字做落款与二维码位；可用一条极细线压住标题底部。

### palette
`#E4DED2` `#C4B49A` `#8A7A62` `#4A4438` `#1C1A16`

### 来源
Galaxy.ai / PromptHero 超现实与概念编辑类目的核心模式——「单一隐喻物 + 极简场景 + 材质质感优先于概念本身」（社区共识："概念的质感才是一切"）+ designwiz 的「用途 + 艺术运动 + 层级 + 色彩情绪 + 字体气质 + 情绪 + 画幅」海报公式。

---

# 通用增强词表

供拼装器复用。**原则：一个维度只用一个词，用技术名词替代形容词。**

## 质量词

### 有效（保留）
```
professional photography          editorial retouch
sharp focus                       tack-sharp fabric weave
RAW look                          unretouched skin texture
visible pores                     natural skin texture retained
organic film grain                fine grain
silver-gelatin tonality           museum oil texture
physically accurate reflections   crisp micro-contrast
full tonal range                  clean blacks / true black point
```
以及**具名要素**——具体胶片型号、具体机身焦段光圈、具体渲染器、具体流派（Caravaggio-school、xieyi-style）。具名词的信息量远高于任何形容词。

### 已失效 / 反而降质（禁用列表）
```
masterpiece      best quality     8k        4k        ultra HD
highly detailed  hyper detailed   beautiful stunning  gorgeous
breathtaking     amazing          award-winning       super realistic
trending on artstation            intricate details
```
同时禁止**同义堆叠**：`cinematic, dramatic, atmospheric, moody` 四个词说的是同一件事，只留一个。2026 年主流模型（MJ V7+/V8、Seedream 4+）对自然语言长句响应优于关键词汤，堆词会主动拉低成片质量。

## 光线词表

结构固定为 **光源 + 方向 + 情绪/控制** 三段：

**光源**
```
soft window light      north light            hazy backlight
golden hour sun        blue hour              bare hard sun
candlelight            tungsten practical     fluorescent tube
neon spill             beauty dish            large softbox
HDRI studio softbox    mixed practicals       available light only
```

**方向**
```
from camera left 45 degrees    from camera right      top-down
side-lit                       backlit                on-axis
rim light                      kicker from behind     from below
high from camera right         slightly above and on axis
```

**情绪与控制**（这一段决定专业感）
```
chiaroscuro             low-key                high key
two-stop falloff        unfilled shadow side   black flag on the shadow side
soft wraparound shadow  crisp cast shadow      one hard shadow only
volumetric haze         halation               veiling flare
highlight bloom         catchlight in both eyes
gentle gradient falloff heavy colour crosstalk no ambient fill
```

## 镜头词表

**画幅 / 机身感**
```
medium format    35mm film camera    anamorphic
```

**焦段与光圈**（按用途选一，不叠加）
```
35mm f/2       环境叙事、纪实、带场景信息
40mm f/2       半环境，港风与新中式
50mm f/1.8     自然视角、日系、科技肖像
85mm f/2.8     人像标准，肩上景，权威感
110mm f/8      棚拍时装，压缩感 + 全清晰
100mm macro f/8 静物、隐喻物
medium format 80mm  静奢空间，宽而不畸变
```

**视角**
```
eye level        slightly low angle      slightly above eye level
off-axis         framed through a doorway
dutch tilt（仅港风档使用）
```

**景别 —— 每条 prompt 只能出现一个**
```
extreme wide shot → wide shot → full shot → three-quarter body
→ medium shot → medium close-up → close-up
```
混用两个景别指令是社区公认的首要失败原因。

**胶片与色彩仿真**
```
Kodak Portra 400        暖肤色、自然，纪实首选
Kodak Gold 200          怀旧暖黄
Kodak Tri-X 400         黑白高颗粒
Ilford HP5 Plus         黑白，层次细腻
Fujifilm Pro 400H       清透冷调，日系
Ektachrome E100         正片，饱和克制
expired film colour shift  港风、复古偏色
```

## 构图与负空间词表

**主体定位**
```
subject in the left third        subject in the right third
subject occupying the right half subject low in the frame
centred but shifted low          small subject, exaggerated emptiness
head in the upper third
```

**留白声明**
```
negative space at the left third      generous headroom
one flat even tone                    unbroken flat field
featureless wall                      empty graded background
clean seamless backdrop               near-white empty gradient
smooth dark navy gradient             pure unbroken black
the masthead zone left clean          held clear as typography space
```

**禁止侵入子句（关键 —— 决定留白是否真的可用）**

只声明"留白"不够，模型会把阴影边缘、道具轮廓、渐变条带塞进去。必须显式排除：
```
no props, no furniture edge, no shadow line crossing into it
the cast shadow must not enter the reserved area
no surface texture detail in the reserved zone
no gradient banding                no vignette at the edges
no hair strays crossing it         no light spill
no particles, no dust concentration
no signage, no hanging objects
```

**平衡与图形**
```
rule of thirds            xieyi-style asymmetric balance
diagonal lead-in          one hard cast shadow as the only graphic element
faint ink-wash gradient bleeding from the top edge
```

## 通用负向基座

所有档案共用，再叠加各自的风格专属忌讳：
```
text, lettering, typography, watermark, signature, logo, brand marks,
QR code, UI elements, caption bars,
deformed hands, extra fingers, malformed face, over-symmetrical AI face,
plastic skin, waxy skin, oversharpened HDR, compression artifacts,
cluttered background
```

## 参数与投递约定

| 项 | 值 |
|---|---|
| 画幅 | 固定 `3:4`（Midjourney: `--ar 3:4`；即梦/Seedream: 画幅选项 3:4） |
| MJ 摄影档 | `--style raw --stylize 100-150` |
| MJ 编辑/时装档 | `--stylize 150-250` |
| MJ 绘画 / 3D 档 | `--stylize 300-600` |
| MJ 系列一致性 | `--chaos 0-10`；探索用 `25-30` |
| 负向承载 | MJ 用 `--no <清单>`；即梦 / Seedream 用独立负向输入框 |
| 主体数量 | 一条 prompt 一个主体；精确数量诉求不超过 4 |

**模型选择要点**
- **Seedream / 即梦**：对中文语义与"版面留白"理解最好，负空间指令可以直接用中文写区域（如"画面左侧三分之一为空白墙面"），且天生理解海报与艺术图规则不同。但它**擅长渲染文字**——这对我们是风险，`no text` 必须写死在正文里。
- **Midjourney**：摄影质感与光线最强，静奢 / 黑白 / 纪实 / 港风 / 巴洛克五档优先走 MJ；文字必渲染为乱码，反而安全。
- 所有档案的中文标题一律交给渲染层，图片模型只出无字主视觉。

---

# 附：候选扩展方向（未纳入本轮 12 档）

- `wabi_sabi_stone` **侘寂石材静物**：travertine / 亚麻 / 陶土材质 + 单一柔和长影 + 米灰调；适合瑜伽、茶空间、高端民宿、身心疗愈。与 `quiet_luxury_grey` 有约 30% 重叠，可作为其无人像变体。
- `swiss_grid_architecture` **建筑几何留白**：清水混凝土立面 + 极小人物剪影 + 硬阴影几何切割；适合设计、建筑、工程与制造业；留白天然（大面积墙体），但对渲染层的网格对齐要求更高。

## 来源汇总

- [设计师私藏20组海报提示词！即梦AI文字海报封神 — 人人都是产品经理](https://www.woshipm.com/ai/6209685.html)
- [调教出一个 AI 海报设计"私教"：即梦提示词 — 凌顺实验室](https://lingshunlab.com/ai/tame-an-ai-poster-design-coach-step-by-step-guide-to-writing-dreamlike-prompts)
- [Full Guide to Seedream 4.0 — getimg.ai](https://getimg.ai/blog/guide-to-bytedance-seedream-4-ai-image-model)
- [Seedream 4 Prompting Guide — veed.io](https://www.veed.io/learn/seedream-4-prompting-guide)
- [Why Your Midjourney Prompts Don't Work (10 Common Mistakes) — Prompt Architects](https://prompt-architects.com/blog/40-why-midjourney-prompts-dont-work)
- [Midjourney V6.1 Prompts That Work (100 Tested Examples) — pxz.ai](https://pxz.ai/blog/midjourney-prompts-that-actually-work)
- [Midjourney 灯光和相机提示词列表 — immll](https://www.immll.com/newbie/midjourney/569.html)
- [Peter Lindbergh Midjourney style — Andrei Kovalev's Midlibrary](https://midlibrary.io/styles/peter-lindbergh)
- [Wong Kar-wai Midjourney style — Midlibrary](https://midlibrary.io/styles/wong-kar-wai)
- [120 Best AI Poster Prompts — designwiz](https://designwiz.com/blog/120-best-ai-poster-prompts/)
- [Luxury Fashion Editorial Prompt for Midjourney — ImagineBuddy](https://www.imaginebuddy.com/style/luxury-fashion-editorial-midjourney-prompt-for-high-end-magazine-style-portraits)
- [Best Editorial Photography Midjourney Prompts — PromptHero](https://prompthero.com/search?model=Midjourney&q=Editorial+Photography)
- [Best baroque painting Midjourney Prompts — PromptHero](https://prompthero.com/search?model=Midjourney&q=baroque+painting)
- [Best 3D Renders & CGI Prompts — Promptomania](https://promptomania.com/prompts/3d-render-prompts)
- [Awesome-AI-Image-Prompts — GitHub](https://github.com/devanshug2307/Awesome-AI-Image-Prompts)
- [23 Midjourney Prompts for Surrealism — Galaxy.ai](https://blog.galaxy.ai/midjourney-prompts-for-surrealism)
- [强烈推荐：如何在 Midjourney 上打造最逼真的照片（提示词汇总）— 知乎](https://zhuanlan.zhihu.com/p/685854332)
- [AI绘画 | 一篇搞定中国风 — CSDN](https://blog.csdn.net/2401_84250575/article/details/137793672)
- [120+ Stable Diffusion Negative Prompts — ClickUp](https://clickup.com/blog/stable-diffusion-negative-prompts/)
