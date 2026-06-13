import type { Agent } from '../../../shared/contracts';

// 离线兜底：内置智能体注册表（仅公开字段，对齐后端 seed AGENTS）。
// 后端可达时由 GET /agents 覆盖（含真实 owned）；不可达时用它，保证对话/智库/工坊不空白。
export const DEFAULT_AGENTS: Agent[] = [
  {
    "key": "general",
    "name": "军师",
    "role": "通用商业军师",
    "icon": "spark",
    "type": "general",
    "gift": true,
    "billing": "free",
    "price": 0,
    "owned": true,
    "enabled": true,
    "greet": "王总好，我是你的 AI 商业军师。说说你的处境，或直接要一个成果，我来产出。",
    "chips": [
      [
        "target",
        "战略体检"
      ],
      [
        "trend",
        "增长方案"
      ],
      [
        "shield",
        "融资准备"
      ]
    ],
    "memText": "已了解你的<b>企业档案</b>与历史会话",
    "learnText": "持续学习中",
    "deliverableKey": null
  },
  {
    "key": "strat",
    "name": "战略诊断官",
    "role": "定位 · 卡点 · SWOT",
    "icon": "target",
    "type": "advisory",
    "gift": true,
    "billing": "free",
    "price": 0,
    "owned": true,
    "enabled": true,
    "greet": "我是战略诊断官。把你最近的纠结讲给我，我直接产出一份战略诊断。",
    "chips": [
      [
        "target",
        "战略体检"
      ]
    ],
    "memText": "记得你最关注<b>「增长乏力」</b>，已沉淀 2 次诊断",
    "learnText": "记忆已更新",
    "deliverableKey": "战略体检"
  },
  {
    "key": "growth",
    "name": "增长操盘手",
    "role": "获客 · 转化 · 复购 · 定价",
    "icon": "trend",
    "type": "advisory",
    "gift": true,
    "billing": "free",
    "price": 0,
    "owned": true,
    "enabled": true,
    "greet": "我是增长操盘手。告诉我你的增长目标，我给你可执行的路径。",
    "chips": [
      [
        "trend",
        "增长方案"
      ]
    ],
    "memText": "已学习你的<b>客群结构与定价</b>",
    "learnText": "记忆已更新",
    "deliverableKey": "增长方案"
  },
  {
    "key": "intel",
    "name": "竞争情报官",
    "role": "对手 · 赛道 · 机会窗口",
    "icon": "chart",
    "type": "advisory",
    "gift": false,
    "billing": "unlock",
    "price": 12,
    "owned": false,
    "enabled": true,
    "greet": "我是竞争情报官。说说你盯的对手或赛道，我帮你看清局势。",
    "chips": [
      [
        "chart",
        "竞品洞察"
      ]
    ],
    "memText": "持续追踪你的 <b>3 个对手</b>",
    "learnText": "情报已更新",
    "deliverableKey": "竞品洞察"
  },
  {
    "key": "fund",
    "name": "融资参谋",
    "role": "BP · 估值 · 投资人问答",
    "icon": "doc",
    "type": "advisory",
    "gift": true,
    "billing": "free",
    "price": 0,
    "owned": true,
    "enabled": true,
    "greet": "我是融资参谋。把你的融资节奏讲给我，我帮你把故事和数据对齐。",
    "chips": [
      [
        "doc",
        "融资准备"
      ]
    ],
    "memText": "记得你的<b>轮次与期权结构</b>",
    "learnText": "记忆已更新",
    "deliverableKey": "融资准备"
  },
  {
    "key": "model",
    "name": "商业模式设计师",
    "role": "画布 · 盈利模型 · 定价",
    "icon": "layers",
    "type": "advisory",
    "gift": false,
    "billing": "unlock",
    "price": 12,
    "owned": false,
    "enabled": true,
    "greet": "我是商业模式设计师。讲讲你怎么赚钱，我帮你把模式与定价结构理清。",
    "chips": [
      [
        "layers",
        "商业模式画布"
      ]
    ],
    "memText": "已掌握你的<b>收入与成本结构</b>",
    "learnText": "记忆已更新",
    "deliverableKey": "商业模式画布"
  },
  {
    "key": "org",
    "name": "组织人效顾问",
    "role": "架构 · 股权 · 激励 · 人效",
    "icon": "user",
    "type": "advisory",
    "gift": false,
    "billing": "unlock",
    "price": 10,
    "owned": false,
    "enabled": true,
    "greet": "我是组织人效顾问。说说你的团队现状，我给出组织与激励的优化建议。",
    "chips": [
      [
        "user",
        "组织优化建议"
      ]
    ],
    "memText": "了解你的<b>团队规模与关键岗</b>",
    "learnText": "记忆已更新",
    "deliverableKey": "组织优化建议"
  },
  {
    "key": "brand",
    "name": "品牌营销官",
    "role": "海报 · 短视频 · 文案",
    "icon": "image",
    "type": "advisory",
    "gift": false,
    "billing": "unlock",
    "price": 10,
    "owned": false,
    "enabled": true,
    "greet": "我是品牌营销官。告诉我要推什么，我把战略翻译成对外内容。",
    "chips": [
      [
        "image",
        "营销内容"
      ]
    ],
    "memText": "已熟悉你的<b>品牌语气与客群</b>",
    "learnText": "记忆已更新",
    "deliverableKey": "营销内容"
  },
  {
    "key": "ops",
    "name": "经营参谋",
    "role": "经营测算 · 预算 · 复盘",
    "icon": "clock",
    "type": "advisory",
    "gift": false,
    "billing": "unlock",
    "price": 10,
    "owned": false,
    "enabled": true,
    "greet": "我是经营参谋。把你的经营数据口径讲给我，我帮你测算与复盘。",
    "chips": [
      [
        "clock",
        "经营分析"
      ]
    ],
    "memText": "已对齐你的<b>经营指标口径</b>",
    "learnText": "记忆已更新",
    "deliverableKey": "经营分析"
  },
  {
    "key": "ip",
    "name": "企业IP打造官",
    "role": "定位 · 人设 · 内容支柱",
    "icon": "crown",
    "type": "creative",
    "gift": false,
    "billing": "metered",
    "price": 3,
    "owned": true,
    "enabled": true,
    "greet": "我是企业 IP 打造官。告诉我你想立的形象，我帮你把创始人/企业 IP 立起来。",
    "chips": [
      [
        "crown",
        "企业IP打造"
      ]
    ],
    "memText": "已熟悉你的<b>行业身份与风格</b>",
    "learnText": "记忆已更新",
    "deliverableKey": "企业IP打造"
  },
  {
    "key": "promo",
    "name": "企业宣传片导演",
    "role": "叙事 · 分镜 · 制作",
    "icon": "video",
    "type": "creative",
    "gift": false,
    "billing": "unlock",
    "price": 15,
    "owned": false,
    "enabled": true,
    "greet": "我是宣传片导演。说说你想传达什么，我给你一条可拍的宣传片脚本。",
    "chips": [
      [
        "video",
        "企业宣传片"
      ]
    ],
    "memText": "记得你的<b>品牌调性与卖点</b>",
    "learnText": "记忆已更新",
    "deliverableKey": "企业宣传片"
  },
  {
    "key": "poster",
    "name": "海报设计师",
    "role": "主视觉 · 版式 · 物料",
    "icon": "image",
    "type": "creative",
    "gift": false,
    "billing": "unlock",
    "price": 8,
    "owned": false,
    "enabled": true,
    "greet": "我是海报设计师。告诉我要推的主题，我给你一版主视觉与文案。",
    "chips": [
      [
        "image",
        "海报设计"
      ]
    ],
    "memText": "已掌握你的<b>品牌色与版式偏好</b>",
    "learnText": "记忆已更新",
    "deliverableKey": "海报设计"
  },
  {
    "key": "shortvideo",
    "name": "短视频策划",
    "role": "选题 · 钩子 · 脚本",
    "icon": "video",
    "type": "creative",
    "gift": false,
    "billing": "unlock",
    "price": 8,
    "owned": false,
    "enabled": true,
    "greet": "我是短视频策划。给我一个主题，我把它写成有钩子的脚本。",
    "chips": [
      [
        "video",
        "短视频策划"
      ]
    ],
    "memText": "了解你的<b>客群与平台</b>",
    "learnText": "记忆已更新",
    "deliverableKey": "短视频策划"
  },
  {
    "key": "copy",
    "name": "商业文案官",
    "role": "卖点 · 多版 · 场景",
    "icon": "pen",
    "type": "creative",
    "gift": false,
    "billing": "unlock",
    "price": 6,
    "owned": false,
    "enabled": true,
    "greet": "我是商业文案官。说说要写什么，我给你多版可直接用的文案。",
    "chips": [
      [
        "pen",
        "营销文案"
      ]
    ],
    "memText": "已熟悉你的<b>语气与卖点</b>",
    "learnText": "记忆已更新",
    "deliverableKey": "营销文案"
  }
];
