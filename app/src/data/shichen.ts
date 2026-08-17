// 十二时辰选项（生辰采集共享常量）——三处录入界面（入场 Picker / 天时日历 / 送你一卦）同一份，
// 免得三张表各自漂移。子时分子正（0:00-0:59）与子初（23:00-23:59）；
// 子初从 23:00 起按次日排日柱，不能与子正拍平成同一个 hour:0。
// hour=null 表示时辰不确定 → 三柱排盘。值为该时辰代表小时，交服务端排盘引擎。
export const SHICHEN: { label: string; hour: number | null }[] = [
  { label: '不确定', hour: null },
  { label: '子正 0-1', hour: 0 }, { label: '丑 1-3', hour: 2 }, { label: '寅 3-5', hour: 4 },
  { label: '卯 5-7', hour: 6 }, { label: '辰 7-9', hour: 8 }, { label: '巳 9-11', hour: 10 },
  { label: '午 11-13', hour: 12 }, { label: '未 13-15', hour: 14 }, { label: '申 15-17', hour: 16 },
  { label: '酉 17-19', hour: 18 }, { label: '戌 19-21', hour: 20 }, { label: '亥 21-23', hour: 22 },
  { label: '子初 23-24（换日）', hour: 23 },
];
