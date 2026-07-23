// 十二时辰选项（生辰采集共享常量）——三处录入界面（入场 Picker / 天时日历 / 送你一卦）同一份，
// 免得三张表各自漂移。子时分早晚：早子（0:00-0:59，当日子时前半）与晚子（23:00-23:59，当日子时后半）
// 干支不同——旧表把「子 23-1」一律拍平成 hour:0，令 23 点出生者被当次日 0 点排盘，日柱/时柱错一柱。
// 现拆为「早子 0-1」(hour 0) 与「晚子 23-24」(hour 23)，配合服务端晚子时流派（日柱算当天）取正。
// hour=null 表示时辰不确定 → 三柱排盘。值为该时辰代表小时，交服务端排盘引擎。
export const SHICHEN: { label: string; hour: number | null }[] = [
  { label: '不确定', hour: null },
  { label: '早子 0-1', hour: 0 }, { label: '丑 1-3', hour: 2 }, { label: '寅 3-5', hour: 4 },
  { label: '卯 5-7', hour: 6 }, { label: '辰 7-9', hour: 8 }, { label: '巳 9-11', hour: 10 },
  { label: '午 11-13', hour: 12 }, { label: '未 13-15', hour: 14 }, { label: '申 15-17', hour: 16 },
  { label: '酉 17-19', hour: 18 }, { label: '戌 19-21', hour: 20 }, { label: '亥 21-23', hour: 22 },
  { label: '晚子 23-24', hour: 23 },
];
