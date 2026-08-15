// 影像主导模式（photo route）测试：风格库完整性 / prompt 拼装器 / 路线归一门禁 / 三层回落链。
//
// 分组对应实现的四块：
//   ① styleLibrary：12 档 typed 常量的完整性（key 唯一、色值合法、必填字段在位、骨架里不许自带 no-text）
//   ② imagePrompt：拼装器 —— **三个调研发现全在这一组**（负空间子句进正文 / no-text 置尾 /
//      禁用词剥除 + 景别互斥），任一条回归都会让生成图从「海报」退化成「一张普通图」
//   ③ posterRoute：路线归一与三条门禁（未配供应商 / 用户传了本人照片 / subject 为空）
//   ④ worker 三层回落链（注入 stub，不打真 LLM、不打真供应商、不起浏览器）：
//      photo 失败 → graphic **复用同一篇宣言** → 仍败 → 模板
//   cd server && npm test
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';
import { grantCredits } from '../src/services/credits.js';
import { setFeatureFlag, setFeatureFlagPayload, __clearFeatureCache } from '../src/services/featureFlag.js';
import { runJobOnce, MAX_ATTEMPTS, type CreativeWorkerDeps } from '../src/services/creative/worker.js';
import { CREATIVE_FLAG_ID } from '../src/services/creative/config.js';
import { POSTER_SKILL_KEY } from '../src/services/creative/jobs.js';
import { updateArtifactPrices } from '../src/services/artifactPricing.js';
import {
  POSTER_STYLES, POSTER_STYLE_KEYS, POSTER_STYLE_LIST, SAFE_ZONES, SAFE_ZONE_HINTS,
  SCENE_DEFAULT_STYLE, normalizeStyleKey, styleCatalogDigest,
} from '../src/services/creative/styleLibrary.js';
import {
  assembleImagePrompt, sanitizeSubject, shotSizesIn, expandSlots,
  mergeArtDirection, composeImageBody, normalizeArtDirection, artDirectionNote, lexiconEn,
  ART_DIRECTION_KEYS, MAX_AD_CHARS,
  BANNED_QUALITY_WORDS, BASE_NEGATIVES, NO_TEXT_CLAUSE, RATIO_SUFFIX, SUBJECT_SLOT,
} from '../src/services/creative/imagePrompt.js';
import { photoRouteAllowed, resolvePosterRoute } from '../src/services/creative/posterRoute.js';
import { directionFor } from '../src/services/creative/directions.js';
import type { PosterDirectionKey } from '../../shared/contracts';
import { CANVAS_PLACEHOLDER } from '../src/services/creative/canvasSanitize.js';
import { putCreativeObject } from '../src/services/creative/storage.js';
import { AI_MARK_TEXT, CANVAS_CLASS } from '../src/services/creative/templates.js';
import {
  generateCanvasPoster,
  type CanvasEngineOutcome, type CanvasPoster, type CompleteTextFn, type CanvasRenderFn,
} from '../src/services/creative/canvasEngine.js';
import type { PosterManifesto } from '../src/services/creative/manifesto.js';
import { hotelOtaBrief } from './fixtures/posterBriefs.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const BRIEF = hotelOtaBrief();
const HEX = /^#[0-9A-Fa-f]{6}$/;

/* ───────────────── ① 风格库完整性 ───────────────── */

describe('影像风格库 · 12 档完整性（档案是 prompt 的唯一真源，缺一个字段就少一层保护）', () => {
  test('12 档、key 唯一、且 key 与 Record 的键一致', () => {
    assert.equal(POSTER_STYLE_KEYS.length, 12);
    assert.equal(new Set(POSTER_STYLE_KEYS).size, 12, 'key 必须唯一');
    for (const k of POSTER_STYLE_KEYS) {
      assert.equal(POSTER_STYLES[k].key, k, `档案自身的 key 要和 Record 的键一致：${k}`);
    }
    assert.equal(POSTER_STYLE_LIST.length, 12);
  });

  test('palette 全是合法 #RRGGBB 且 3–5 色（排版层直接取它当标题色，脏值会渲染成透明）', () => {
    for (const s of POSTER_STYLE_LIST) {
      assert.ok(s.palette.length >= 3 && s.palette.length <= 5, `${s.key} 色板数量：${s.palette.length}`);
      for (const c of s.palette) assert.match(c, HEX, `${s.key} 色值非法：${c}`);
    }
  });

  test('每档必有 structure.negativeSpace 与 safeZone（这两个字段是海报与普通图的分界）', () => {
    for (const s of POSTER_STYLE_LIST) {
      assert.ok(s.structure.negativeSpace.trim().length > 40, `${s.key} 负空间子句太短，起不到禁入侵作用`);
      assert.ok(SAFE_ZONES.includes(s.safeZone), `${s.key} safeZone 不在白名单：${s.safeZone}`);
      assert.ok(SAFE_ZONE_HINTS[s.safeZone], `${s.safeZone} 缺少给排版层的 px 区间说明`);
      // 禁入侵子句必须真的写了「不许有什么」，否则只是一句「这里留白」——模型会把阴影塞进去
      assert.match(s.structure.negativeSpace, /\bno\b/i, `${s.key} 负空间子句缺少显式排除项（no …）`);
    }
  });

  // 行动区是本次重构新增的结构位：叠层要在成品图上放二维码/CTA，而模型不知道那块地要留出来。
  // 缺了它就回到「码压在主体上」——那是量测器量不出来、只能靠提示词说死的一类事故。
  test('每档必有 structure.actionZone，且与安全区一样带显式禁入侵词', () => {
    for (const s of POSTER_STYLE_LIST) {
      assert.ok(s.structure.actionZone.trim().length > 40, `${s.key} 缺行动区结构位（二维码/CTA 没有落点）`);
      assert.match(
        s.structure.actionZone,
        /action area/i,
        `${s.key} 行动区没说清它是干什么用的（叠层据此避让）`,
      );
      const r = assembleImagePrompt({ style: s, subject: 'a founder', brief: BRIEF });
      assert.ok(r.prompt.includes(s.structure.actionZone.slice(0, 40)), `${s.key} 行动区没进正文`);
    }
  });

  // ★ 本次重构的核心不变量：负空间子句**不许自带颜色**。
  //   它一旦写死 `pure unbroken black`，方案把 backdrop 改成「沉稳深灰」也白改 ——
  //   合成出来的 prompt 会一边说深灰、一边说纯黑，模型按后一句画。
  test('structure.negativeSpace 不含具体颜色词（颜色跟 backdrop 走，否则覆盖必然失效）', () => {
    const COLOUR = /\b(black|white|grey|gray|navy|umber|crimson|gold|blue|green|red|teal|ivory|bone)\b/i;
    for (const s of POSTER_STYLE_LIST) {
      const hit = s.structure.negativeSpace.match(COLOUR);
      assert.equal(
        hit, null,
        `${s.key} 负空间子句写死了颜色「${hit?.[0]}」：方案改了 backdrop 也会被这句话拽回去`,
      );
      assert.match(
        s.structure.negativeSpace,
        /backdrop tone|out of focus|evenly lit|unoccupied/i,
        `${s.key} 负空间子句要么指向 backdrop 基调、要么只描述形状，不能凭空少一句`,
      );
    }
  });

  test('每档必有中文名 / 场景 / 主体提示 / 排版气质 / 来源（少一个就有一处没人能维护的黑盒）', () => {
    for (const s of POSTER_STYLE_LIST) {
      for (const [field, v] of [
        ['name', s.name], ['scene', s.scene], ['subjectHint', s.subjectHint],
        ['typographyHints', s.typographyHints], ['source', s.source],
      ] as const) {
        assert.ok(String(v).trim().length > 0, `${s.key}.${field} 不能为空`);
      }
      assert.ok(s.structure.negatives.length > 0, `${s.key} 缺风格专属负向词`);
    }
  });

  test('structure.opening 含唯一 {SUBJECT} 槽；档案里**不许自带 no-text 与画幅**（那两句由拼装器置尾）', () => {
    for (const s of POSTER_STYLE_LIST) {
      assert.ok(s.structure.opening.includes(SUBJECT_SLOT), `${s.key} 缺 ${SUBJECT_SLOT} 槽`);
      // 字段化之后不该再有任何 {LABEL} 槽：可替换的东西已经是 defaults 字段了，
      // 留着花括号说明这一档没拆干净，那段内容会被 expandSlots 直接删掉。
      const all = [
        s.structure.opening.split(SUBJECT_SLOT).join(''),
        s.structure.camera, s.structure.negativeSpace, s.structure.actionZone,
        ...Object.values(s.defaults),
      ].join(' ');
      const braces = all.match(/\{[^}]*\}/g) ?? [];
      assert.deepEqual(braces, [], `${s.key} 残留槽位（应已拆成 defaults 字段）：${braces.join(',')}`);
      assert.ok(
        !all.toLowerCase().includes(NO_TEXT_CLAUSE),
        `${s.key} 档案自带了 no-text：它必须由拼装器放在正文最末，写在档案里会被负空间子句挤到中段`,
      );
      assert.ok(!all.includes(RATIO_SUFFIX), `${s.key} 档案不该自带画幅后缀`);
    }
  });

  test('defaults 七个字段全部在位（可为空串，但键不许缺——缺一个就是一处静默失效的覆盖点）', () => {
    for (const s of POSTER_STYLE_LIST) {
      for (const k of ART_DIRECTION_KEYS) {
        assert.equal(typeof s.defaults[k], 'string', `${s.key}.defaults.${k} 缺失或类型不对`);
      }
      // 背景与光线是每一档都必须有主张的两项：合成时它们决定留白区长什么样。
      assert.ok(s.defaults.backdrop.trim().length > 10, `${s.key} 缺 backdrop 缺省`);
      assert.ok(s.defaults.lighting.trim().length > 10, `${s.key} 缺 lighting 缺省`);
    }
  });

  test('scene → 默认档映射覆盖四个场景且都落在白名单内', () => {
    for (const scene of ['personal_brand', 'event', 'service', 'product'] as const) {
      const k = SCENE_DEFAULT_STYLE[scene];
      assert.ok(POSTER_STYLE_KEYS.includes(k), `${scene} 的默认档不在白名单：${k}`);
      assert.equal(normalizeStyleKey('不存在的档', scene), k, '非法 styleKey 必须回退到 scene 默认档');
      assert.equal(normalizeStyleKey(k, scene), k, '合法 styleKey 原样保留');
    }
  });

  test('档案摘要（进宣言提示词）列全 12 档的 key 与中文名', () => {
    const digest = styleCatalogDigest();
    for (const s of POSTER_STYLE_LIST) {
      assert.ok(digest.includes(s.key) && digest.includes(s.name), `摘要缺 ${s.key}`);
    }
  });
});

/* ───────────────── ② 拼装器（三个调研发现） ───────────────── */

const STYLE = POSTER_STYLES.mono_authority_portrait;

describe('影像 prompt 拼装器 · 槽位与负向合并', () => {
  test('{SUBJECT} 被填入；{LABEL: 内容} 去掉花括号只留内容（字面 {} 发给生图模型没有意义）', () => {
    const r = assembleImagePrompt({ style: STYLE, subject: 'a composed tax advisor in her forties', brief: BRIEF });
    assert.ok(r.prompt.includes('a composed tax advisor in her forties'));
    assert.ok(!/[{}]/.test(r.prompt), `不许有残留花括号：${r.prompt}`);
    assert.ok(r.prompt.includes('a plain dark shirt or jacket'), '带默认值的槽位内容要留下来');
  });

  test('expandSlots 删掉无内容空槽（不把 {PROP} 这种字面量发出去）', () => {
    assert.equal(expandSlots(`x {SUBJECT} y {PROP} z`, 'A').replace(/\s+/g, ' ').trim(), 'x A y z');
  });

  test('负向 = 风格专属 + 通用基座 + brief 排除项，去重且保序', () => {
    const brief = hotelOtaBrief({ negativePrompt: '霓虹灯, text, 手绘涂鸦' });
    const r = assembleImagePrompt({ style: STYLE, subject: 'a lawyer', brief });
    const list = r.negativePrompt.split(', ');
    assert.equal(list[0], STYLE.structure.negatives[0], '风格专属排在最前（更贴题）');
    for (const w of BASE_NEGATIVES) assert.ok(list.includes(w), `通用基座缺 ${w}`);
    assert.ok(list.includes('霓虹灯') && list.includes('手绘涂鸦'), 'brief 的排除项必须带上（用户显式要求）');
    assert.equal(list.filter((x) => x === 'text').length, 1, '重复词只留一个');
  });

  test('subject 里的花括号被清掉（模型爱把槽位语法抄回来，抄回来就会套嵌）', () => {
    const r = assembleImagePrompt({ style: STYLE, subject: '{WARDROBE: a red suit} a founder', brief: BRIEF });
    assert.ok(!/[{}]/.test(r.prompt));
  });
});

describe('影像 prompt 拼装器 · 发现①：负空间禁入侵子句必须进正文', () => {
  test('每一档的 structure.negativeSpace 都出现在 prompt 正文里（不是只塞负向框）', () => {
    for (const s of POSTER_STYLE_LIST) {
      const r = assembleImagePrompt({ style: s, subject: 'a founder', brief: BRIEF });
      const head = s.structure.negativeSpace.slice(0, 40);
      assert.ok(r.prompt.includes(head), `${s.key} 的负空间子句没进正文`);
      assert.ok(
        !r.negativePrompt.includes(head),
        `${s.key}：带空间条件的约束放负向框基本无效，它的位置是正文`,
      );
    }
  });

  test('负空间子句排在 no-text 之前（它描述画面内容，属于正文主体）', () => {
    const r = assembleImagePrompt({ style: STYLE, subject: 'a lawyer', brief: BRIEF });
    assert.ok(
      r.prompt.indexOf(STYLE.structure.negativeSpace.slice(0, 30)) < r.prompt.indexOf(NO_TEXT_CLAUSE),
      '顺序错了就等于把最该压轴的一句挤到中段',
    );
  });
});

describe('影像 prompt 拼装器 · 发现②：no-text 必须是正文最后一句', () => {
  test('每一档都以「no text … + 3:4」收尾，且 no-text 只出现一次', () => {
    for (const s of POSTER_STYLE_LIST) {
      const r = assembleImagePrompt({ style: s, subject: 'a founder', brief: BRIEF });
      assert.ok(r.prompt.endsWith(`${NO_TEXT_CLAUSE}. ${RATIO_SUFFIX}`), `${s.key} 收尾不对：${r.prompt.slice(-80)}`);
      const hits = r.prompt.toLowerCase().split(NO_TEXT_CLAUSE).length - 1;
      assert.equal(hits, 1, `${s.key}：no-text 重复 ${hits} 次（骨架里又写了一遍？）`);
    }
  });

  test('负向框里也有 text/lettering（两道闸并存，但正文那句才是主力）', () => {
    const r = assembleImagePrompt({ style: STYLE, subject: 'a lawyer', brief: BRIEF });
    assert.ok(r.negativePrompt.includes('text') && r.negativePrompt.includes('lettering'));
  });
});

describe('影像 prompt 拼装器 · 发现③：禁用词剥除与景别互斥', () => {
  test('禁用质量词被剥除（2026 年的模型对它们已不响应，甚至反向降质）', () => {
    const r = assembleImagePrompt({
      style: STYLE,
      subject: 'a masterpiece 8k highly detailed award-winning portrait of a stunning lawyer',
      brief: BRIEF,
    });
    for (const w of ['masterpiece', '8k', 'highly detailed', 'award-winning', 'stunning']) {
      assert.ok(!r.prompt.toLowerCase().includes(w), `${w} 没被剥掉`);
      assert.ok(r.strippedWords.includes(w), `剥了什么词要留痕（进资产 metadata）：${w}`);
    }
    assert.ok(r.subject.includes('lawyer'), '剥词不能把主体本身剥掉');
    assert.ok(!/\s{2,}|, ,|^,|,$/.test(r.subject), `剥词后要收拾标点残骸：「${r.subject}」`);
  });

  test('禁用词表里每一个词都真的会被剥掉（不留没落实的清单）', () => {
    for (const w of BANNED_QUALITY_WORDS) {
      const r = sanitizeSubject(`a lawyer, ${w}, standing still`);
      assert.ok(r.strippedWords.includes(w), `${w} 在清单里却没被剥`);
      assert.ok(!r.subject.toLowerCase().includes(w), `${w} 仍留在 subject 里`);
    }
  });

  test('景别互斥：骨架已有景别 → subject 里的景别全剥（骨架的那个是我们调过的）', () => {
    // mono_authority_portrait 的骨架里是 tight head-and-shoulders
    assert.ok(shotSizesIn(STYLE.structure.camera).length >= 1, '这一档相机语法本来就该有一个景别词');
    const r = assembleImagePrompt({ style: STYLE, subject: 'extreme close-up of a lawyer, full body', brief: BRIEF });
    assert.ok(r.strippedShotSizes.includes('extreme close-up'), `实际剥了：${r.strippedShotSizes.join(',')}`);
    assert.ok(r.strippedShotSizes.includes('full body'));
    assert.ok(!r.subject.toLowerCase().includes('close-up'));
    assert.ok(!r.subject.toLowerCase().includes('full body'));
    assert.ok(r.prompt.includes('head-and-shoulders'), '骨架自己的景别不许被动到');
  });

  test('景别互斥：骨架没有景别 → 只留 subject 里的第一个（一条 prompt 恒一个景别）', () => {
    const r = sanitizeSubject('a wide shot of a founder, also a close-up', []);
    assert.ok(r.subject.includes('wide shot'), `第一个要留下：「${r.subject}」`);
    assert.ok(!r.subject.includes('close-up'));
    assert.deepEqual(r.strippedShotSizes, ['close-up']);
  });

  test('medium close-up 不会被拆成 medium + close-up 两处命中（先长后短匹配）', () => {
    assert.deepEqual(shotSizesIn('a medium close-up of a founder'), ['medium close-up']);
    const r = sanitizeSubject('a medium close-up of a founder', ['medium shot']);
    assert.deepEqual(r.strippedShotSizes, ['medium close-up']);
    assert.ok(!/medium|close/.test(r.subject), `不许留下半个词：「${r.subject}」`);
  });

  // 剥词不能只是把词删掉：`a masterpiece close-up of a lawyer` 剥完剩 `a of a lawyer`，
  // 拼进骨架就是 "portrait of a of a lawyer" —— 模型读到一个坏句子，画质随之下降。
  test('剥词后不留悬空冠词/介词，接缝处也不出现重复的 of', () => {
    const r = assembleImagePrompt({
      style: STYLE, subject: 'a masterpiece close-up of a composed tax advisor in her forties', brief: BRIEF,
    });
    assert.equal(r.subject, 'a composed tax advisor in her forties');
    assert.ok(!/\bof of\b|\ba of\b|\ba a\b/i.test(r.prompt), `接缝处有语病：${r.prompt.slice(0, 120)}`);
    assert.match(r.prompt, /portrait of a composed tax advisor/);
  });

  test('整段只剩一个冠词 → 视为空 subject（交给路线门禁③降级，不拼一条没有主体的 prompt）', () => {
    assert.equal(sanitizeSubject('a masterpiece').subject, '');
  });

  test('12 档全部拼出通顺的开头（骨架 + subject 接缝处不许有语病）', () => {
    for (const s of POSTER_STYLE_LIST) {
      const r = assembleImagePrompt({ style: s, subject: 'a composed tax advisor in her forties', brief: BRIEF });
      assert.ok(!/\bof of\b|\ba a\b|\bin in\b|\s,|,,/i.test(r.prompt), `${s.key} 有语病：${r.prompt.slice(0, 120)}`);
    }
  });

  test('干净的 subject 不被动到（卫生只该剥噪声，不该改写主体）', () => {
    const clean = 'a composed Chinese woman in her forties, a tax advisor';
    const r = sanitizeSubject(clean, shotSizesIn(STYLE.structure.camera));
    assert.equal(r.subject, clean);
    assert.deepEqual(r.strippedWords, []);
    assert.deepEqual(r.strippedShotSizes, []);
  });
});

/* ───────────────── ②' 方案优先：字段合成器 ───────────────── */

/**
 * **等价还原守卫**：字段化之前，每档是一整段 `imagePromptSkeleton`。
 * 下面这张表是那段文案在 2026-08-15 拆分**当天**的关键子句快照 —— 逐字摘自旧骨架，
 * 不是重新想出来的描述。合成器在「方案什么都没说」时必须还原出语义等价的提示词，
 * 也就是这些子句必须一条不少地出现在默认合成结果里。
 *
 * 它守的是拆分本身：拆错一个字段（把 `Lighting` 段落丢了、把服装拆没了）在别的用例里
 * 看不出来 —— prompt 仍然通顺、仍然以 no-text 收尾，只是这一档不再是这一档了。
 */
const LEGACY_CLAUSES: Record<string, string[]> = {
  quiet_luxury_grey: [
    'undyed ivory or oatmeal cashmere', 'seated at a low stone table',
    'vast near-empty gallery-like room', 'broad soft window light from camera right',
    'two-stop falloff into the corners', 'high-key desaturated grade with warm undertone',
    'subtle 400-speed grain', 'medium format 80mm', 'waist-up framing',
  ],
  baroque_icon_gold: [
    'heavy crimson and deep-green velvet with gold thread embroidery', 'a white lamb',
    'near-black umber void', 'single candlelit key high from camera left at 45 degrees',
    'hard chiaroscuro', 'sfumato skin transitions', 'aged varnish', 'centred half-length figure',
  ],
  editorial_black_gold: [
    'a sharply tailored black suit', 'hands in pockets', 'black seamless studio backdrop',
    'rich true black point', 'hard focused key from top left through a small softbox',
    'brushed-brass vertical element', 'crisp commercial retouch', '85mm at f/4', 'chest-up framing',
  ],
  neo_chinese_void: [
    'loose raw-silk tea robe in bone white', 'rice-paper screen wall', 'one bare plum branch',
    'pale diffused north light', 'low saturation celadon and mist grey', 'fine paper grain',
    'xieyi-style asymmetric balance', 'small subject placed in the lower right',
  ],
  documentary_film_grain: [
    'mid-gesture, unaware of the camera', 'their own workshop, kitchen', 'available light only',
    'Kodak Portra 400 emulation', 'organic grain', 'unretouched pores and flyaway hair',
    '35mm at f/2', 'medium shot',
  ],
  luxury_magazine_cover: [
    'a monochrome sculptural coat', 'seamless paper backdrop in warm bone white',
    'beauty dish key slightly above and on axis', 'saturated but controlled colour',
    'tack-sharp fabric weave', 'medium format 110mm at f/8', 'three-quarter body',
  ],
  airy_japanese_light: [
    'a white cotton shirt', 'bright pale room, one sheer white curtain', 'a single glass vase',
    'backlit by a hazy window', 'soft veiling flare', 'Fujifilm Pro 400H emulation',
    '50mm at f/1.8', 'medium close-up',
  ],
  cyber_tech_blue: [
    'a dark technical jacket', 'dark data-hall corridor', 'faint volumetric haze',
    'cyan practical rim from behind camera left', 'deep navy-to-black gradient',
    'crisp micro-contrast', '50mm at f/2.2', 'chest-up framing',
  ],
  retro_hongkong: [
    'a silk qipao or an open-collar shirt', 'green fluorescent tube overhead',
    'magenta neon spill from the right', 'expired-film colour shift', 'crushed teal shadows',
    'gate weave', 'anamorphic 40mm at f/2', 'medium shot',
  ],
  glossy_3d_trend: [
    'single hero object floating slightly above a soft curved backdrop',
    'glossy soft-touch plastic', 'one brushed chrome accent',
    'large HDRI studio softbox from the front top', 'Octane-grade clean render',
    'hero centred low in the frame', 'generous headroom',
  ],
  mono_authority_portrait: [
    'a plain dark shirt or jacket', 'direct steady gaze', 'mid-grey painted wall',
    'one large softbox at camera left 45 degrees', 'a catchlight in both eyes',
    'silver-gelatin tonality', '85mm at f/2.8', 'head-and-shoulders',
  ],
  surreal_object_metaphor: [
    'only subject, placed on a wide seamless surface', 'large empty studio field in warm bone grey',
    'single hard sun-like source high from camera right', 'gallery still-life realism',
    'matte surfaces', '100mm macro at f/8', 'the object small in the lower third',
  ],
};

describe('字段合成器 · 等价还原（方案什么都没说时，必须还原出与旧骨架语义等价的提示词）', () => {
  test('12 档的关键子句一条不少地出现在默认合成结果里', () => {
    for (const s of POSTER_STYLE_LIST) {
      const r = assembleImagePrompt({ style: s, subject: 'a composed founder', brief: BRIEF });
      const missing = (LEGACY_CLAUSES[s.key] ?? []).filter((c) => !r.prompt.includes(c));
      assert.deepEqual(missing, [], `${s.key} 拆分时丢了这些子句：${missing.join(' | ')}`);
      assert.ok(LEGACY_CLAUSES[s.key]?.length, `${s.key} 没有等价还原快照，加档时必须补上`);
    }
  });

  test('默认合成不产生空标签（某档没有 props/mood 时不许留下 "Props: ." 这种断句）', () => {
    for (const s of POSTER_STYLE_LIST) {
      const r = assembleImagePrompt({ style: s, subject: 'a founder', brief: BRIEF });
      assert.ok(!/:\s*\./.test(r.prompt), `${s.key} 有空标签：${r.prompt}`);
      assert.ok(!/\s{2,}|,,/.test(r.prompt), `${s.key} 有多余空白：${r.prompt}`);
    }
  });
});

describe('字段合成器 · 方案优先（ad 有值用 ad，空则回落缺省）', () => {
  const AD = (v: Record<string, { zh: string; en: string }>) => normalizeArtDirection(v);

  // ★ 这就是那条实证缺陷的回归用例：宣言承诺「沉稳深灰」，而旧实现把 black 写死在骨架
  //   与负空间子句里，承诺永远到不了生图模型。
  test('ad.backdrop=沉稳深灰 → 合成含 charcoal/deep grey，且缺省的 pure/true black 全部消失', () => {
    const style = POSTER_STYLES.editorial_black_gold;
    const r = assembleImagePrompt({
      style, subject: 'a tax advisor', brief: BRIEF,
      artDirection: AD({ backdrop: { zh: '沉稳深灰', en: '' } }),
    });
    assert.match(r.prompt, /charcoal|deep grey|deep gray/i, `深灰没进提示词：${r.prompt}`);
    assert.ok(!/rich true black point/i.test(r.prompt), '缺省背景没被顶掉');
    assert.ok(!/pure unbroken black/i.test(r.prompt), '负空间子句仍把留白区钉成纯黑——覆盖等于白做');
    assert.deepEqual(r.overriddenFields, ['backdrop'], '只覆盖了 backdrop，其余字段不许被连坐');
    // 只给中文时英文由词表补出来；zh 位原样留着给客户看。
    assert.ok(r.note.includes('沉稳深灰'), `给客户看的那句话必须念的是原话：${r.note}`);
  });

  test('未覆盖的字段逐条回落该档缺省（覆盖是逐字段的，不是整块替换）', () => {
    const style = POSTER_STYLES.editorial_black_gold;
    const r = assembleImagePrompt({
      style, subject: 'a tax advisor', brief: BRIEF,
      artDirection: AD({ backdrop: { zh: '沉稳深灰', en: 'charcoal deep grey' } }),
    });
    for (const c of ['hard focused key from top left', 'crisp commercial retouch', 'a sharply tailored black suit']) {
      assert.ok(r.prompt.includes(c), `没聊到的字段必须留着缺省：${c}`);
    }
  });

  test('ad 全空 = 与不传 ad 逐字相同（"聊了但什么都没说" 不该改变任何一个字）', () => {
    const style = POSTER_STYLES.quiet_luxury_grey;
    const base = assembleImagePrompt({ style, subject: 'a founder', brief: BRIEF });
    const empty = assembleImagePrompt({
      style, subject: 'a founder', brief: BRIEF,
      artDirection: AD({ backdrop: { zh: '', en: '' }, lighting: { zh: '', en: '' } }),
    });
    assert.equal(empty.prompt, base.prompt);
    assert.deepEqual(empty.overriddenFields, []);
    assert.equal(empty.note, '', '没聊到任何字段时不许对客户许诺画面');
  });

  test('structure 与技术合规位不可被覆盖（相机语法/负空间/no-text/画幅/负向框）', () => {
    const style = POSTER_STYLES.mono_authority_portrait;
    const r = assembleImagePrompt({
      style, subject: 'a lawyer', brief: BRIEF,
      artDirection: AD({
        backdrop: { zh: '暖橙', en: 'warm orange wall' },
        lighting: { zh: '硬光', en: 'hard flash' },
        mood: { zh: '热闹', en: 'busy and loud' },
      }),
    });
    assert.ok(r.prompt.includes(style.structure.camera), '相机语法被动了 → 安全区就对不上排版层');
    assert.ok(r.prompt.includes(style.structure.negativeSpace.slice(0, 40)), '负空间子句被动了');
    assert.ok(r.prompt.endsWith(`${NO_TEXT_CLAUSE}. ${RATIO_SUFFIX}`), 'no-text 与画幅必须仍在最末');
    for (const w of BASE_NEGATIVES) assert.ok(r.negativePrompt.includes(w), `通用负向基座缺 ${w}`);
    // 覆盖的字段真的进去了（否则上面几条都是空断言）
    assert.ok(r.prompt.includes('warm orange wall') && r.prompt.includes('hard flash'));
  });

  test('graphic 路线（无风格档）只合成方案说过的字段，不凭空借用任何一档的缺省', () => {
    const merged = mergeArtDirection(null, AD({ palette: { zh: '低饱和暖灰', en: 'low saturation warm grey' } }));
    assert.deepEqual(merged.fields.map((f) => f.key), ['palette']);
    assert.equal(merged.fields[0].source, 'ad');
    assert.match(artDirectionNote(merged), /低饱和暖灰/);
  });

  test('中文摘要只念方案聊过的字段（缺省是骨架的事，念出来就是替方案许它没许过的诺）', () => {
    const style = POSTER_STYLES.mono_authority_portrait;
    const merged = mergeArtDirection(style, AD({ lighting: { zh: '柔暖侧光', en: 'soft warm side light' } }));
    const note = artDirectionNote(merged, style.name);
    assert.ok(note.includes('黑白权威肖像') && note.includes('柔暖侧光'));
    assert.ok(!note.includes('softbox') && !note.includes('mid-grey'), `缺省不许出现在给客户看的话里：${note}`);
  });
});

describe('字段合成器 · AD 值的卫生与归一（模型填的是不可信文本）', () => {
  test('禁用质量词与景别词一律剥掉（景别归 structure.camera 所有）', () => {
    const ad = normalizeArtDirection({
      backdrop: { zh: '深灰墙面', en: 'a masterpiece 8k close-up of a deep grey wall' },
    });
    assert.ok(ad.backdrop, '整段不该被剥空');
    assert.ok(!/masterpiece|8k|close-up/i.test(ad.backdrop!.en), `没剥干净：${ad.backdrop!.en}`);
    assert.ok(ad.backdrop!.en.includes('deep grey wall'));
  });

  test('两边都空的字段整个缺席（不许用空对象冒充「聊过」）', () => {
    const ad = normalizeArtDirection({ backdrop: { zh: '', en: '' }, mood: null, palette: '  ' });
    assert.deepEqual(Object.keys(ad), []);
  });

  // 只认标量：嵌套对象 String() 出来是 "[object Object]"，那串东西会顶掉一个调好的缺省，
  // 比丢掉这个字段糟得多（画面会照着一句无意义的话画）。
  test('字段值是嵌套对象/数组时整条丢弃，绝不让 "[object Object]" 进 prompt', () => {
    const ad = normalizeArtDirection({ backdrop: { zh: { deep: 'grey' }, en: ['a', 'b'] }, lighting: { nested: 1 } });
    assert.deepEqual(Object.keys(ad), []);
    const r = assembleImagePrompt({
      style: POSTER_STYLES.editorial_black_gold, subject: 'a founder', brief: BRIEF, artDirection: ad,
    });
    assert.ok(!r.prompt.includes('object Object'), r.prompt);
    assert.ok(r.prompt.includes('rich true black point'), '丢弃脏字段后必须回落缺省');
  });

  test('只给字符串也认（模型常把 {zh,en} 写成一句话），并按词表补出英文', () => {
    const ad = normalizeArtDirection({ backdrop: '深灰', lighting: '柔暖光' });
    assert.equal(ad.backdrop?.zh, '深灰');
    assert.match(ad.backdrop!.en, /charcoal|grey/i);
    assert.match(ad.lighting!.en, /soft warm light/i);
  });

  test('词表命中不了的中文原样透传（不做机器翻译，也不许丢字段）', () => {
    assert.equal(lexiconEn('像一场晚宴散场'), '像一场晚宴散场');
    const ad = normalizeArtDirection({ mood: '像一场晚宴散场' });
    assert.equal(ad.mood?.en, '像一场晚宴散场');
  });

  test('超长字段被截断（一句短描述，不许写小作文稀释整条 prompt）', () => {
    const ad = normalizeArtDirection({ backdrop: { zh: '深'.repeat(400), en: '' } });
    assert.ok((ad.backdrop?.zh.length ?? 0) <= MAX_AD_CHARS, `没截断：${ad.backdrop?.zh.length}`);
  });

  test('composeImageBody 保留 {SUBJECT} 槽（填 subject 是拼装器最后一步的事）', () => {
    const style = POSTER_STYLES.cyber_tech_blue;
    assert.ok(composeImageBody(style, mergeArtDirection(style, {})).includes(SUBJECT_SLOT));
  });
});

/* ───────────────── ③ 路线归一与门禁 ───────────────── */

const SUBJECT = 'a composed tax advisor in her forties';

describe('tier 权威路线 · 标准零生图 / 高级不降级', () => {
  test('standard 即使供应商可用且模型给了 subject，也只能走 graphic', () => {
    const r = resolvePosterRoute({
      visualConfigured: true,
      brief: BRIEF,
      modelStyleKey: 'quiet_luxury_grey',
      modelSubject: SUBJECT,
    });
    assert.equal(r.mode, 'graphic');
    assert.match(r.reason, /标准档契约/);
    assert.equal(photoRouteAllowed({ premium: false, visualConfigured: true, hasPortraitAsset: false }), false);
  });

  test('premium 门禁齐备时走 photo；供应商或 subject 缺失时明确不可用', () => {
    const premium = hotelOtaBrief({ tier: 'premium', directionKey: 'photo_product' });
    const ok = resolvePosterRoute({
      visualConfigured: true,
      brief: premium,
      modelStyleKey: 'glossy_3d_trend',
      modelSubject: 'a polished brass hotel key',
    });
    assert.equal(ok.mode, 'photo');
    assert.match(ok.reason, /高级档契约/);
    assert.equal(resolvePosterRoute({ visualConfigured: false, brief: premium, modelSubject: SUBJECT }).mode, 'graphic');
    assert.equal(resolvePosterRoute({ visualConfigured: true, brief: premium, modelSubject: '' }).mode, 'graphic');
  });

  // 存量单兼容：directionKey 是后加的字段，改动前建的在途单里没有它。
  // directionFor 曾是裸下标 → 未知 key 抛 TypeError，被上层吞成「AI 引擎失败」。
  test('未知 / 缺失 directionKey：directionFor 不抛，回落到标准档图形方向', () => {
    for (const bogus of [undefined, null, '', 'photo_unknown', 42]) {
      const d = directionFor(bogus as unknown as PosterDirectionKey);
      assert.equal(d.tier, 'standard', `directionKey=${String(bogus)} 应落到标准档默认方向`);
      assert.ok(d.artDirection.length > 0, '回落方向必须是完整定义，不能是半个对象');
      assert.equal(d.requiresPortrait, undefined, '兜底方向不能要求本人照片（老单未必有）');
    }
    // 路线归一里也用它取 styleKeys —— 老单走到这一步不许炸
    assert.equal(
      resolvePosterRoute({
        visualConfigured: true,
        brief: { ...BRIEF, directionKey: undefined as unknown as PosterDirectionKey },
        modelSubject: SUBJECT,
      }).mode,
      'graphic',
    );
  });
});

/* ───────────────── ④ canvasEngine 的 photo 变体提示词（stub，不打 LLM 不起浏览器） ───────────────── */

describe('排版层 · photo 变体提示词（全幅铺底 + 安全区叠层）', () => {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>t</title>`
    + `<style>html,body{margin:0}.${CANVAS_CLASS}{width:540px;height:720px;overflow:hidden;position:relative}</style>`
    + `</head><body><div class="${CANVAS_CLASS}"><h1>${BRIEF.headline}</h1><div>${AI_MARK_TEXT}</div></div></body></html>`;

  const manifesto: PosterManifesto = {
    movement: '静默权威',
    paragraphs: ['第一段：留白是结构。', '第二段：色彩承担信息。', '第三段：工艺感来自反复推敲。'],
    palette: ['#FFFFFF', '#7A7A7A', '#000000'],
    reference: '专家 IP 的可信感',
    artDirection: {},
    route: { mode: 'photo', styleKey: 'mono_authority_portrait', subject: SUBJECT },
  };

  /**
   * 跑一轮引擎，回收两轮提示词（stub 渲染恒干净 → 创作 + 无条件打磨共两次调用）。
   * 显式关掉视觉评审：这一组钉的是 **photo 变体提示词**本身，评审开着会在中间插一次看图调用，
   * 把 calls[1] 从「打磨轮」挪成「评审轮」——那测的就不是这里要测的东西了。
   */
  async function prompts(photo: boolean): Promise<{ system: string; user: string }[]> {
    const calls: { system: string; user: string }[] = [];
    const complete: CompleteTextFn = async (system, user) => { calls.push({ system, user }); return html; };
    const render: CanvasRenderFn = async () => ({
      buffer: Buffer.from('png'), width: 1080, height: 1440, violations: [], measured: true, bodyText: BRIEF.headline,
    });
    const r = await generateCanvasPoster({
      brief: BRIEF,
      manifesto,
      assets: photo ? { visualUrl: 'data:image/png;base64,AAA' } : {},
      ...(photo ? { photoStyle: POSTER_STYLES.mono_authority_portrait } : {}),
    }, { complete, render, moderateText: async () => true, critique: async () => null });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    return calls;
  }

  test('photo：提示词写死全幅铺底规则（object-fit:cover + 不许二次裁切）与主视觉占位符', async () => {
    const [first, polish] = await prompts(true);
    assert.ok(first.system.includes(CANVAS_PLACEHOLDER.visual), '要告诉模型主视觉占位符叫什么');
    assert.match(first.system, /object-fit:cover/);
    assert.match(first.system, /不许把它缩成一张卡片/);
    assert.match(first.system, /transform:scale/, '二次裁切会把人脸切掉，必须显式禁止');
    // 2026-08-12 预发实测：模型守住了"铺底"，却又在版面中间插了一张同源白边小图，像贴歪的拍立得。
    // "必须铺底" ≠ "只能用一次"，两条都要写。
    assert.match(first.system, /只能出现一次/, '占位符复用会让画面像贴错素材');
    assert.match(first.system, /缩略图、相框、卡片/, '把复用的具体形态点名，模型才躲得开');
    assert.ok(polish.system.includes('object-fit:cover'), '打磨轮不许丢掉背景层规则');
    assert.ok(first.user.includes(CANVAS_PLACEHOLDER.visual), '素材清单里要有主视觉');
  });

  test('photo：安全区换算成 px 区间进提示词（枚举名让模型自己猜边界 = 标题压脸）', async () => {
    const [first] = await prompts(true);
    const zone = SAFE_ZONE_HINTS[POSTER_STYLES.mono_authority_portrait.safeZone];
    assert.ok(first.system.includes(zone), `安全区说明没进 system：${zone}`);
    assert.ok(first.user.includes(zone), '用户侧上下文也要有（前后轮看到的事实必须一致）');
    assert.match(first.system, /绝不许压在人物面部或主体上/, '这一项量测器量不出来，只能靠提示词');
  });

  test('photo：把这一档的排版气质与色板喂下去（不是让模型自由发挥）', async () => {
    const [first] = await prompts(true);
    const style = POSTER_STYLES.mono_authority_portrait;
    assert.ok(first.system.includes(style.typographyHints));
    assert.ok(first.system.includes(style.palette[0]));
    assert.ok(first.user.includes(style.name) && first.user.includes(style.key));
  });

  test('photo：明确要求排版层**收手**（不再铺几何图案跟主视觉抢画面）', async () => {
    const [first] = await prompts(true);
    assert.match(first.system, /克制的排版叠层/);
    assert.match(first.system, /不要\*\*再铺满几何图案|不要.{0,4}再铺满几何图案/);
    assert.doesNotMatch(first.system, /用重复的图案与精确的形作画/, 'graphic 那段是互斥替换，不许两段同时在场');
  });

  test('graphic：一个字都不提主视觉（老路径提示词不受影响）', async () => {
    const [first, polish] = await prompts(false);
    for (const p of [first.system, first.user, polish.system]) {
      assert.ok(!p.includes(CANVAS_PLACEHOLDER.visual), '没有主视觉时提示词里不许出现它的占位符');
      assert.ok(!p.includes('object-fit:cover'), '不许把 photo 的背景层规则漏给 graphic');
    }
    assert.match(first.system, /用重复的图案与精确的形作画/, 'graphic 段照旧');
  });
});

/* ───────────────── ⑤ worker 三层回落链 + 后台契约 ───────────────── */

const MANIFESTO_DOC: PosterManifesto = {
  movement: '静默权威',
  paragraphs: ['第一段：留白是结构。', '第二段：色彩承担信息。', '第三段：工艺感来自反复推敲。'],
  palette: ['#FFFFFF', '#7A7A7A', '#000000'],
  reference: '专家 IP 的可信感',
  artDirection: {},
  route: { mode: 'photo', styleKey: 'mono_authority_portrait', subject: SUBJECT },
};

function posterHtml(): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>t</title>`
    + `<style>html,body{margin:0}.${CANVAS_CLASS}{width:540px;height:720px;overflow:hidden;position:relative}</style>`
    + `</head><body><div class="${CANVAS_CLASS}"><h1>${BRIEF.headline}</h1>`
    + `<div>${AI_MARK_TEXT}</div></div></body></html>`;
}

function poster(): CanvasPoster {
  return {
    buffer: Buffer.from('png'), mimeType: 'image/png', width: 1080, height: 1440,
    html: posterHtml(), rounds: 2, violationsFixed: 0, violations: [],
    polishReverted: false, rebuildTriggered: false, visualCritiques: 0, critiquePassed: false, aiMarkInjected: false,
  };
}

/**
 * 注入一套 stub。`composeOk` 决定每次排版成功还是失败：
 * 传 'photo-only' = 只有影像版成功，'graphic-only' = 只有图形版成功（即 photo 排版失败），'none' = 都失败。
 */
function deps(o: {
  photoVisual?: 'ok' | 'submit_failed' | 'moderation_blocked';
  composeOk: 'photo-only' | 'graphic-only' | 'none';
}): { deps: CreativeWorkerDeps; calls: { manifesto: number; visual: number; compose: ('photo' | 'graphic')[] } } {
  const calls = { manifesto: 0, visual: 0, compose: [] as ('photo' | 'graphic')[] };
  const d: CreativeWorkerDeps = {
    manifesto: async () => { calls.manifesto += 1; return MANIFESTO_DOC; },
    photoVisual: async () => {
      calls.visual += 1;
      if (o.photoVisual === 'submit_failed') return { error: '主视觉未生成：供应商未返回图片' };
      if (o.photoVisual === 'moderation_blocked') return { error: '主视觉未通过图片审核' };
      return { assetId: 'stub_visual_asset', providerLabel: 'openai_images', dataUri: 'data:image/png;base64,AAA' };
    },
    compose: async (input): Promise<CanvasEngineOutcome> => {
      const kind = input.photoStyle ? 'photo' : 'graphic';
      calls.compose.push(kind);
      const ok = o.composeOk === 'photo-only' ? kind === 'photo'
        : o.composeOk === 'graphic-only' ? kind === 'graphic'
          : false;
      return ok
        ? { ok: true, poster: poster() }
        : { ok: false, reason: `${kind} 版三轮仍违规：text_overlap`, rounds: 3, violations: [], lastHtml: posterHtml() };
    },
  };
  return { deps: d, calls };
}

async function posterUser(credits = 200): Promise<{ token: string; tenantId: string }> {
  const token = await login(uniquePhone(), '影像路线用户');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  await prisma.userAgent.create({ data: { userId: token, agentKey: 'poster', source: 'admin_grant' } });
  await grantCredits(user.tenantId, token, credits, '测试充值');
  return { token, tenantId: user.tenantId };
}

async function createJob(token: string, key: string, over: Record<string, unknown> = {}): Promise<string> {
  const r = await api('POST', '/api/creative/posters', {
    token,
    body: {
      brief: {
        scene: 'service', goal: '让本地酒店老板来聊直客运营', audience: '单体酒店与民宿老板',
        headline: '不再靠 OTA 活着', subheadline: '直客占比做到 45%',
        proofPoints: ['服务 60 家单体酒店'], cta: '扫码领诊断', ratio: '3:4', ...over,
      },
      idempotencyKey: key,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.jobId;
}

/** 抢占并执行一单（worker 的 claim 逻辑另有用例覆盖，这里只要把状态推到 running 再跑管线）。 */
async function runOne(jobId: string, d: CreativeWorkerDeps): Promise<void> {
  await prisma.creativeJob.update({
    where: { id: jobId },
    data: { status: 'running', startedAt: new Date(), progress: 'philosophy', attempts: { increment: 1 } },
  });
  await runJobOnce(jobId, d);
}

/** 配好图片供应商；是否使用只由 tier 决定。 */
async function enablePhotoRoute(): Promise<void> {
  await setFeatureFlag(CREATIVE_FLAG_ID, true);
  await setFeatureFlagPayload(CREATIVE_FLAG_ID, {
    visual: { enabled: true, baseUrl: 'https://img.example/v1', model: 'seedream-4' },
  });
  __clearFeatureCache();
}

type ResultJson = {
  engine?: string; aiMode?: string; styleKey?: string; rounds?: number; directionKey?: string;
  photoError?: string; aiEngineError?: string; visualAssetId?: string | null; templateKey?: string;
};

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

describe('tier 权威执行与免费 revise 复用', () => {
  beforeEach(async () => {
    await cleanBusiness();
    await seedBaseline();
    await enablePhotoRoute();
  });

  test('standard 全程只走 graphic，供应商已配置也不调用 photoVisual', async () => {
    const { token } = await posterUser();
    const jobId = await createJob(token, 'tier-standard-graphic', { directionKey: 'graphic_symbol' });
    const { deps: d, calls } = deps({ photoVisual: 'ok', composeOk: 'graphic-only' });
    await runOne(jobId, d);
    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'succeeded');
    assert.equal((job.resultJson as ResultJson).aiMode, 'graphic');
    assert.equal(calls.visual, 0, 'standard 无论配置如何都不得调用图片供应商');
    assert.deepEqual(calls.compose, ['graphic']);
  });

  // 存量在途单：requestJson.brief 是建单当时的快照，directionKey 引入之前建的单里没有它。
  // 不补齐的话，路线归一处 `directionFor(brief.directionKey).styleKeys` 抛 TypeError →
  // 被 runJobOnce 吞成 INTERNAL（premium 存量单失败退款、standard 静默降模板）。
  test('老格式单（brief 缺 directionKey）：执行输入被补齐默认方向，AI 路径照常走通', async () => {
    const { token } = await posterUser();
    const jobId = await createJob(token, 'legacy-no-direction');
    const row = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    const req = row.requestJson as { brief: Record<string, unknown> };
    const { directionKey: _dropped, ...legacyBrief } = req.brief;
    assert.ok(_dropped, '前提：新单本来是有 directionKey 的，这里刻意抹掉造老单');
    await prisma.creativeJob.update({ where: { id: jobId }, data: { requestJson: { ...req, brief: legacyBrief } } });

    const { deps: d, calls } = deps({ photoVisual: 'ok', composeOk: 'graphic-only' });
    await runOne(jobId, d);

    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'succeeded', `老单不该崩在方向定义上：${job.errorCode} ${job.errorMessage}`);
    const r = job.resultJson as ResultJson;
    assert.equal(r.engine, 'ai', 'template_fallback 就是「AI 链崩了」的信号');
    assert.equal(r.aiMode, 'graphic');
    assert.equal(r.directionKey, 'graphic_symbol', 'scene=service + 标准档 + 无本人照片 → 图形默认方向');
    assert.equal(calls.visual, 0);
  });

  test('premium 主视觉失败不跨档回落 graphic', async () => {
    const { token } = await posterUser();
    const jobId = await createJob(token, 'tier-premium-fail', { tier: 'premium', directionKey: 'photo_product' });
    const { deps: d, calls } = deps({ photoVisual: 'submit_failed', composeOk: 'graphic-only' });
    await runOne(jobId, d);
    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'pending', '首轮失败进入既有重试机制');
    assert.equal(job.errorCode, 'PREMIUM_VISUAL_FAILED');
    assert.deepEqual(calls.compose, [], '不得拿 graphic 当高级产物交付');
  });

  test('layoutEngine=template 也不能绕过 premium 主视觉契约', async () => {
    await setFeatureFlagPayload(CREATIVE_FLAG_ID, {
      layoutEngine: 'template',
      visual: { enabled: true, baseUrl: 'http://127.0.0.1:9/v1', model: 'demo-model' },
    });
    __clearFeatureCache();
    const { token } = await posterUser();
    const jobId = await createJob(token, 'tier-premium-template-fail', {
      tier: 'premium', directionKey: 'photo_scene',
    });
    const { deps: d } = deps({ photoVisual: 'ok', composeOk: 'graphic-only' });
    await runOne(jobId, d);
    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'pending', '首轮失败进入既有重试机制');
    assert.equal(job.errorCode, 'PREMIUM_VISUAL_FAILED');
    assert.equal(await prisma.creativeAsset.count({ where: { jobId, kind: 'poster_png' } }), 0,
      '高级价任务不得交付纯排版模板');
  });

  test('layoutEngine=template 的 standard 仍然零图片供应商调用', async () => {
    await setFeatureFlagPayload(CREATIVE_FLAG_ID, {
      layoutEngine: 'template',
      visual: { enabled: true, baseUrl: 'http://127.0.0.1:9/v1', model: 'demo-model' },
    });
    __clearFeatureCache();
    const { token } = await posterUser();
    const jobId = await createJob(token, 'tier-standard-template', { directionKey: 'graphic_bold_type' });
    const { deps: d } = deps({ photoVisual: 'submit_failed', composeOk: 'none' });
    await runOne(jobId, d);
    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'succeeded', `${job.errorCode} ${job.errorMessage}`);
    assert.equal((job.resultJson as ResultJson).visualAssetId, null);
    assert.equal(await prisma.creativeAsset.count({ where: { jobId, kind: 'visual' } }), 0);
  });

  test('premium 免费改字复用父单主视觉与风格，不再调用图片供应商', async () => {
    const { token, tenantId } = await posterUser();
    const parentId = await createJob(token, 'revise-parent', { tier: 'premium', directionKey: 'photo_product' });
    const ossKey = `test/creative/revise/${parentId}.png`;
    await putCreativeObject(ossKey, Buffer.from('source-visual'), 'image/png');
    const visual = await prisma.creativeAsset.create({
      data: {
        jobId: parentId, tenantId, userId: token, kind: 'visual', ossKey, mimeType: 'image/png', bytes: 13,
        metadataJson: { styleKey: 'glossy_3d_trend', subject: 'a polished brass hotel key' },
      },
    });
    await prisma.creativeJob.update({ where: { id: parentId }, data: { status: 'succeeded', completedAt: new Date() } });
    const revised = await api('POST', `/api/creative/jobs/${parentId}/revise`, {
      token,
      body: { headline: '直客增长新答案', idempotencyKey: 'revise-reuse-visual' },
    });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    const childId = revised.body.jobId;
    const { deps: d, calls } = deps({ photoVisual: 'ok', composeOk: 'photo-only' });
    await runOne(childId, d);
    const child = await prisma.creativeJob.findUniqueOrThrow({ where: { id: childId } });
    assert.equal(child.status, 'succeeded', `${child.errorCode} ${child.errorMessage}`);
    assert.equal(child.creditCost, 0);
    assert.equal(calls.visual, 0, '免费改字不得重新调用图片供应商');
    assert.deepEqual(calls.compose, ['photo']);
    assert.equal((child.resultJson as ResultJson).visualAssetId, visual.id);
    const req = child.requestJson as { sourceVisualStyleKey?: string; sourceVisualSubject?: string };
    assert.equal(req.sourceVisualStyleKey, 'glossy_3d_trend');
    assert.equal(req.sourceVisualSubject, 'a polished brass hotel key');
  });

  test('premium 原主视觉记录还在但文件已丢失 → revise 建单前拒绝并引导换方向', async () => {
    const { token, tenantId } = await posterUser();
    const parentId = await createJob(token, 'revise-missing-file-parent', {
      tier: 'premium', directionKey: 'photo_scene',
    });
    await prisma.creativeAsset.create({
      data: {
        jobId: parentId, tenantId, userId: token, kind: 'visual',
        ossKey: `test/creative/missing/${parentId}.png`, mimeType: 'image/png', bytes: 99,
        metadataJson: { styleKey: 'documentary_film_grain', subject: 'a hotel lobby at sunrise' },
      },
    });
    await prisma.creativeJob.update({ where: { id: parentId }, data: { status: 'succeeded', completedAt: new Date() } });
    const before = await prisma.creativeJob.count();
    const revised = await api('POST', `/api/creative/jobs/${parentId}/revise`, {
      token,
      body: { headline: '换一句标题', idempotencyKey: 'revise-missing-file' },
    });
    assert.equal(revised.status, 422, JSON.stringify(revised.body));
    assert.equal(revised.body.code, 'SOURCE_VISUAL_MISSING');
    assert.match(revised.body.error, /换方向/);
    assert.equal(await prisma.creativeJob.count(), before, '原文件不存在时不该先建一张必失败的免费任务');
  });

  test('不限量 premium regenerate：chargedAt 为空仍是收费重出语义，必须重新调用图片供应商', async () => {
    const { token, tenantId } = await posterUser(0);
    await grantCredits(tenantId, token, -1, '测试不限量');
    const parentId = await createJob(token, 'unlimited-regen-parent', {
      tier: 'premium', directionKey: 'photo_product',
    });
    await prisma.creativeJob.update({ where: { id: parentId }, data: { status: 'succeeded', completedAt: new Date() } });

    const regenerated = await api('POST', `/api/creative/jobs/${parentId}/regenerate`, {
      token,
      body: { directionKey: 'photo_scene', idempotencyKey: 'regen:unlimited-child' },
    });
    assert.equal(regenerated.status, 200, JSON.stringify(regenerated.body));
    const childBefore = await prisma.creativeJob.findUniqueOrThrow({ where: { id: regenerated.body.jobId } });
    assert.equal(childBefore.creditCost, 25, '不限量仍记录名义成本');
    assert.equal(childBefore.chargedAt, null, '不限量没有真实扣款');
    assert.equal((childBefore.requestJson as { operation?: string }).operation, 'regenerate');

    const { deps: d, calls } = deps({ photoVisual: 'ok', composeOk: 'photo-only' });
    await runOne(childBefore.id, d);
    const child = await prisma.creativeJob.findUniqueOrThrow({ where: { id: childBefore.id } });
    assert.equal(child.status, 'succeeded', `${child.errorCode} ${child.errorMessage}`);
    assert.equal(calls.visual, 1, 'regenerate 必须重出主视觉，不能被 chargedAt=null 误判为免费改字');
  });

  test('premium 单价显式为 0 的 regenerate：按 operation 执行重出，不按零费用误判 revise', async () => {
    await updateArtifactPrices({ [POSTER_SKILL_KEY]: { premium: 0 } });
    __clearFeatureCache();
    const { token } = await posterUser();
    const parentId = await createJob(token, 'zero-price-regen-parent', {
      tier: 'premium', directionKey: 'photo_product',
    });
    await prisma.creativeJob.update({ where: { id: parentId }, data: { status: 'succeeded', completedAt: new Date() } });

    const regenerated = await api('POST', `/api/creative/jobs/${parentId}/regenerate`, {
      token,
      body: { idempotencyKey: 'custom-zero-price-key' },
    });
    assert.equal(regenerated.status, 200, JSON.stringify(regenerated.body));
    const childBefore = await prisma.creativeJob.findUniqueOrThrow({ where: { id: regenerated.body.jobId } });
    assert.equal(childBefore.creditCost, 0);
    assert.equal(childBefore.chargedAt, null, '零价任务没有真实扣款时间');
    assert.equal((childBefore.requestJson as { operation?: string }).operation, 'regenerate');

    const { deps: d, calls } = deps({ photoVisual: 'ok', composeOk: 'photo-only' });
    await runOne(childBefore.id, d);
    const child = await prisma.creativeJob.findUniqueOrThrow({ where: { id: childBefore.id } });
    assert.equal(child.status, 'succeeded', `${child.errorCode} ${child.errorMessage}`);
    assert.equal(calls.visual, 1, '零价是运营定价，不等于 revise');
  });

  // 建单侧的 SOURCE_VISUAL_MISSING 拦不住**在途单与历史数据**：它们进 worker 时，建单闸门早已
  // 成为过去。没有 worker 侧那道硬闸，这种单会真去调图片供应商出图，还按重试策略调三次 ——
  // 而它 creditCost=0，一分钱没收。
  test('免费 revise 单（无来源主视觉、未扣费）：worker 硬闸零供应商调用 + 失败无退款流水', async () => {
    const { token } = await posterUser();
    const parentId = await createJob(token, 'orphan-revise-parent', { tier: 'premium', directionKey: 'photo_product' });
    await prisma.creativeJob.update({ where: { id: parentId }, data: { status: 'succeeded', completedAt: new Date() } });

    // 手工造一张「改造前遗留」的在途免费单：有父单、没扣费、requestJson 里也没有来源主视觉。
    const parent = await prisma.creativeJob.findUniqueOrThrow({ where: { id: parentId } });
    const parentRequest = parent.requestJson as { operation?: string; brief: Record<string, unknown> };
    const { operation: _newField, ...legacyRequest } = parentRequest;
    const orphan = await prisma.creativeJob.create({
      data: {
        tenantId: parent.tenantId, userId: parent.userId, agentKey: parent.agentKey, skillKey: parent.skillKey,
        kind: parent.kind, status: 'pending', engine: parent.engine, parentJobId: parentId,
        requestJson: legacyRequest as object, idempotencyKey: 'orphan-revise-child',
        creditCost: 0, chargedAt: null,
      },
      select: { id: true },
    });

    const ledgerBefore = await prisma.creditLedger.count({ where: { userId: token } });
    const { deps: d, calls } = deps({ photoVisual: 'ok', composeOk: 'photo-only' });
    for (let i = 0; i < MAX_ATTEMPTS; i++) await runOne(orphan.id, d);

    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: orphan.id } });
    assert.equal(job.status, 'failed', `${job.errorCode} ${job.errorMessage}`);
    assert.equal(job.errorCode, 'SOURCE_VISUAL_MISSING', '既有口径，不新造错误码');
    assert.equal(calls.visual, 0, '★ 免费单一次都不许碰图片供应商');
    assert.deepEqual(calls.compose, [], '闸门在排版之前就收口');
    assert.equal(job.refundedAt, null, 'creditCost=0 从未扣费，没有可退的东西');
    assert.equal(await prisma.creditLedger.count({ where: { userId: token } }), ledgerBefore, '不产生任何资金流水');
    assert.equal(await prisma.creativeAsset.count({ where: { jobId: orphan.id } }), 0);
  });

  // 高级档终态退款：拿不到主视觉就既不交付、也不收这笔钱。这条断言此前只活在
  // describe.skip 的旧套件里（随类型演进一起失效），必须在活跃套件里有一条推到终态的用例。
  test('premium 主视觉持续失败 → 耗尽重试后 failed + 全额退款 + 零成品资产', async () => {
    const { token } = await posterUser();
    const jobId = await createJob(token, 'tier-premium-refund', { tier: 'premium', directionKey: 'photo_character' });
    const created = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(created.creditCost, 25, '建单按高级价扣');
    assert.ok(created.chargedAt, '预扣即实扣');

    const { deps: d, calls } = deps({ photoVisual: 'submit_failed', composeOk: 'graphic-only' });
    for (let i = 0; i < MAX_ATTEMPTS; i++) await runOne(jobId, d);

    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'failed', `重试耗尽必须落终态：${job.errorCode} ${job.errorMessage}`);
    assert.equal(job.attempts, MAX_ATTEMPTS);
    assert.equal(job.errorCode, 'PREMIUM_VISUAL_FAILED');
    assert.ok(job.refundedAt, '★ 用户没拿到他买的东西，25 钻必须退');
    assert.equal(
      await prisma.creditLedger.count({ where: { userId: token, delta: 25, reason: { contains: '海报成品图' } } }),
      1,
      '退款流水恰好一条（既不漏退也不重复退）',
    );
    assert.deepEqual(calls.compose, [], '全程不得拿 graphic 当高级产物交付');
    assert.equal(await prisma.creativeAsset.count({ where: { jobId } }), 0, '零资产落库（含半成品）');
  });
});
