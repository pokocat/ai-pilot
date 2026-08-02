import type { Agent } from '../../../shared/contracts';

// 离线兜底：内置智能体注册表。greet/memText/learnText 由 server 的 copy:sync 同步；
// enabled/owned/billing/price 等行为字段允许按 mock 产品口径与服务端不同，不在同步器保护范围内。
// 后端可达时由 GET /agents 覆盖（含真实 owned）；不可达时用它，保证对话/智库/工坊不空白。
const RAW_AGENTS: Omit<Agent, 'billingRatio' | 'meterUnit'>[] = [
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
    "greet": "坐下来聊聊。生意要看，人也要看。先说说——你做什么生意？眼下最难拿主意的是哪件事？",
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
    "memText": "你的<b>企业情况</b>我记着，判断才有根有据",
    "learnText": "记着呢",
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
    "greet": "我是观澜，专看战略取舍。你最近纠结什么？我帮你把问题拆开，给出一份判断。",
    "chips": [
      [
        "target",
        "战略体检"
      ]
    ],
    "memText": "你纠结什么、之前<b>怎么判断的</b>，我都留着",
    "learnText": "记下了",
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
    "greet": "我是青衍，负责增长。你想做到什么目标？我帮你把路子和先后顺序理清。",
    "chips": [
      [
        "trend",
        "增长方案"
      ]
    ],
    "memText": "你的<b>客群怎么分层、价怎么定</b>，我记着",
    "learnText": "记下了",
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
    "greet": "我是察远，专看对手和赛道。你在关注谁？我帮你分清他的真优势、表面声量和可趁之机。",
    "chips": [
      [
        "chart",
        "竞品洞察"
      ]
    ],
    "memText": "你盯的<b>对手和赛道</b>，我帮你盯着",
    "learnText": "盯着呢",
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
    "greet": "我是泓策，负责融资。你现在走到哪一轮？我帮你把融资逻辑讲清，把关键数字对上。",
    "chips": [
      [
        "doc",
        "融资准备"
      ]
    ],
    "memText": "你走到<b>哪一轮、账上什么结构</b>，我心里有数",
    "learnText": "记下了",
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
    "greet": "我是构衡，专门拆生意怎么赚钱。你现在怎么收钱？我帮你把模式和定价理顺。",
    "chips": [
      [
        "layers",
        "商业模式画布"
      ]
    ],
    "memText": "你的<b>收入从哪来、成本花在哪</b>，我记着",
    "learnText": "记下了",
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
    "greet": "我是云枢，负责团队和组织。你现在队伍什么情况？我帮你理架构、看激励，把关键问题找出来。",
    "chips": [
      [
        "user",
        "组织优化建议"
      ]
    ],
    "memText": "你的<b>团队怎么搭、关键岗位是谁</b>，我记着",
    "learnText": "记下了",
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
    "greet": "我是声澜，管对外发声。你想推什么？我把你的打法，变成客户能听懂、愿意转的话。",
    "chips": [
      [
        "image",
        "营销内容"
      ]
    ],
    "memText": "你的<b>品牌怎么说话、客户是谁</b>，我记着",
    "learnText": "记下了",
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
    "greet": "我是照微，负责经营复盘。把关键数据给我，我帮你盘清楚哪里在变、下一步该盯什么。",
    "chips": [
      [
        "clock",
        "经营分析"
      ]
    ],
    "memText": "你的<b>经营指标怎么算</b>，我跟你对着看",
    "learnText": "记下了",
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
    "greet": "我是鸣璋，帮你做创始人和企业 IP。你想让别人记住你什么？我帮你把定位立住，把内容做出来。",
    "chips": [
      [
        "crown",
        "企业IP打造"
      ]
    ],
    "memText": "你的<b>行业身份和表达风格</b>，我记着",
    "learnText": "记下了",
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
    "greet": "我是影湛，拍片子的。你想让人看完记住什么？我给你一条能直接开机拍的脚本。",
    "chips": [
      [
        "video",
        "企业宣传片"
      ]
    ],
    "memText": "你的<b>品牌调性和核心卖点</b>，我记着",
    "learnText": "记下了",
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
    "greet": "我是绘章，做海报的。这次推什么？我给你一版主视觉配文案，直接能用。",
    "chips": [
      [
        "image",
        "海报设计"
      ]
    ],
    "memText": "你的<b>品牌色和版式偏好</b>，我记着",
    "learnText": "记下了",
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
    "greet": "我是流光，做短视频的。给我个主题，我写一条开头就抓人的，能直接拍。",
    "chips": [
      [
        "video",
        "短视频策划"
      ]
    ],
    "memText": "你的<b>客群和发布平台</b>，我记着",
    "learnText": "记下了",
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
    "greet": "我是墨言，写文案的。这次写什么用？我给你几版，挑着用。",
    "chips": [
      [
        "pen",
        "营销文案"
      ]
    ],
    "memText": "你的<b>表达语气和核心卖点</b>，我记着",
    "learnText": "记下了",
    "deliverableKey": "营销文案"
  }
];
// 公开字段默认双轴计费：文本类、计费比例 1.0（真实值由后端 GET /agents 覆盖）。
export const DEFAULT_AGENTS: Agent[] = RAW_AGENTS.map((a) => ({ ...a, billingRatio: 1, meterUnit: 'text' as const }));
