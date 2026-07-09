// 空态导流文案（WO-03 冷启动体验）：冷启动期各 tab 的引导卡文案集中管理，
// 禁止散落在页面内。速诊（WO-06）上线前，CTA 先跳对话 tab 并预填开场语；
// 上线后把 goQuickScan 改跳 /packages/work/quickscan/index 即可，页面不用再动文案。

export interface EmptyState {
  kicker: string;
  title: string;
  desc: string;
  cta: string;
}

export const EMPTY_STATES = {
  // 战局页：无军师判断 / 无案卷（冷启动）
  battle: {
    kicker: '还没建档',
    title: '军师还没为你建档',
    desc: '3 个问题，10 分钟拿到你的初诊判断。',
    cta: '开始初诊',
  },
  // 执行页：无案卷 / 无作战方案
  execution: {
    kicker: '还没有方案',
    title: '还没有作战方案',
    desc: '先去参谋室和军师聊一次，认可方案后自动拆成今日军令。',
    cta: '去参谋室',
  },
} satisfies Record<string, EmptyState>;

// 速诊未上线：CTA 先跳对话 tab 并预填开场语（速诊上线后替换为 quickscan 路由）。
export const QUICKSCAN_OPENER = '我想先做个快速初诊：帮我用 3 个问题判断当前最主要的矛盾，并给我一条今天就能做的事。';
