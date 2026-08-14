import type {
  PosterDirectionKey,
  PosterDirectionOption,
  PosterScene,
  PosterTier,
} from '../../../../shared/contracts';
import type { PosterStyleKey } from './styleLibrary.js';

export interface PosterDirectionDefinition extends PosterDirectionOption {
  /** 注入宣言与画布创作提示词的正向母题；负向 anti-slop 清单不因它放松。 */
  artDirection: string;
  /** premium 方向允许模型选择的图片风格子集。 */
  styleKeys?: PosterStyleKey[];
}

export const POSTER_DIRECTIONS: Record<PosterDirectionKey, PosterDirectionDefinition> = {
  graphic_bold_type: {
    key: 'graphic_bold_type', tier: 'standard', name: '强标题视觉',
    desc: '让一句主张成为画面主角，靠字号、字形和留白制造冲击。',
    artDirection: '视觉主角必须是主标题本身。建立一个极端清晰的字号尺度差与单一对齐轴；让字形切分、留白和少量色域形成记忆点，不用信息卡片堆层级。',
  },
  graphic_symbol: {
    key: 'graphic_symbol', tier: 'standard', name: '品牌图形',
    desc: '从业务里提炼一个专属符号，用图形母题建立辨识度。',
    artDirection: '从行业气质或核心主张提炼一个独有的几何母题，并以尺度变化、重复、裁切形成视觉主角。母题只选一个，不能退化成通用渐变球、随机光环或装饰图标拼盘。',
  },
  graphic_portrait: {
    key: 'graphic_portrait', tier: 'standard', name: '本人形象',
    desc: '使用你上传的本人照片，让人物与标题共同建立信任。',
    requiresPortrait: true,
    artDirection: '用户本人照片是唯一人物主角。保留真实面貌与主体完整性，用明确裁切、留白和编辑式排印建立可信度；不得再画第二张脸，也不得把人像缩成普通资料卡。',
  },
  photo_character: {
    key: 'photo_character', tier: 'premium', name: '人物意象',
    desc: '用 AI 演绎一个角色与气场，适合表达专业感或情绪张力。',
    note: 'AI 演绎人物，不是本人',
    artDirection: '全幅主视觉以一个 AI 演绎人物为唯一视觉主角，用姿态、光线和环境讲清气场；文字退居安全区，不做人物资料卡或双人拼贴。',
    styleKeys: [
      'quiet_luxury_grey', 'baroque_icon_gold', 'editorial_black_gold', 'neo_chinese_void',
      'documentary_film_grain', 'luxury_magazine_cover', 'airy_japanese_light',
      'retro_hongkong', 'mono_authority_portrait',
    ],
  },
  photo_product: {
    key: 'photo_product', tier: 'premium', name: '产品大片',
    desc: '用材质、光线和空间把产品或服务成果拍成主角。',
    artDirection: '全幅主视觉只聚焦一个产品、成果物或具有代表性的业务物件；用材质细节、受控光线和空间关系建立高级感，不出现无关人物抢主体。',
    styleKeys: ['glossy_3d_trend', 'surreal_object_metaphor', 'quiet_luxury_grey', 'cyber_tech_blue'],
  },
  photo_scene: {
    key: 'photo_scene', tier: 'premium', name: '场景叙事',
    desc: '用一个有真实感的场景，把活动、服务或品牌故事讲出来。',
    artDirection: '全幅主视觉以一个能读出时间、地点或行动的场景为主角，使用纪实瞬间或克制的空间叙事；画面只能有一个故事焦点，避免素材拼贴与舞台式大合影。',
    styleKeys: ['documentary_film_grain', 'neo_chinese_void', 'airy_japanese_light', 'retro_hongkong', 'cyber_tech_blue'],
  },
};

export const POSTER_DIRECTION_KEYS = Object.keys(POSTER_DIRECTIONS) as PosterDirectionKey[];

export function isPosterDirectionKey(v: unknown): v is PosterDirectionKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(POSTER_DIRECTIONS, v);
}

export function defaultDirectionKey(
  tier: PosterTier,
  scene: PosterScene,
  hasPortrait: boolean,
): PosterDirectionKey {
  if (tier === 'standard') return hasPortrait ? 'graphic_portrait' : scene === 'personal_brand' ? 'graphic_bold_type' : 'graphic_symbol';
  if (scene === 'personal_brand') return 'photo_character';
  if (scene === 'product' || scene === 'service') return 'photo_product';
  return 'photo_scene';
}

/**
 * directionKey 是后加进 brief 的字段，改动前建的在途单读不到合法值。
 * 宣言 / 哲学 / 画布 / 路线归一四处都拿它裸下标取方向定义，未知 key 会抛 TypeError 并被上层
 * 吞成「AI 引擎失败」（premium 失败退款、standard 静默降模板）。这里兜住：永不 throw。
 */
const FALLBACK_DIRECTION_KEY: PosterDirectionKey = 'graphic_bold_type';

export function directionFor(key: PosterDirectionKey): PosterDirectionDefinition {
  return POSTER_DIRECTIONS[key] ?? POSTER_DIRECTIONS[FALLBACK_DIRECTION_KEY];
}

export function directionOptions(tier?: PosterTier): PosterDirectionOption[] {
  return POSTER_DIRECTION_KEYS
    .map((key) => POSTER_DIRECTIONS[key])
    .filter((item) => !tier || item.tier === tier)
    .map(({ artDirection: _artDirection, styleKeys: _styleKeys, ...item }) => item);
}
