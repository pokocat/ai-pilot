# 命盘报告（八字 × 紫微综合印证）规格 v1

> 目标：老板 tab 去掉「天时日历」入口，新增「命盘报告」页。报告 = 八字盘 + 紫微十二宫全盘 + 两盘综合印证。
> 铁律：**所有命理数据由算法层确定性计算（lunar-typescript + iztro + baziEnrich），零 LLM 参与**。
> 印证框架参考 MIT 开源 bazi-ziwei-skill（本仓库 baziEnrich 的上游）的综合印证方法论，但由 LLM 提示词改写为纯规则代码。

## 1. 后端

### 1.1 接口

`GET /api/profile/chart/report`（挂在 `server/src/routes/profile.ts`）

- 认证：`resolveUser(req.headers['x-user-id'])`，失败 401。
- 命理门控：`fortuneDisabledGuard(reply)`，同 `/profile/chart`。
- 无生辰（无 NatalChart 记录）：返回 `{ needBazi: true }`。
- 有生辰：从 NatalChart 读原始生辰字段，**按需现算**（不落库、无 schema 变更），返回 `MingpanReport`。

### 1.2 计算层

新建 `server/src/services/mingpan.ts`：

- 复用 `computeChart`（paipan.ts）得到八字侧（四柱/旺衰/格局/喜用/调候/大运/逐月）。
- 新增紫微全盘：`astro.bySolar(...)`（iztro，与现有命宫主星同一调用口径：出生证明法定钟表时间、`hourToTimeIndex` 含子初、`fixLeap` 与现状一致），展开：
  - 盘面元信息：五行局 `fiveElementsClass`、命主 `soul`、身主 `body`、命宫/身宫地支、阴阳（年干阴阳+性别 → 阳男/阴男/阳女/阴女）。
  - 十二宫 `palaces[12]`：宫名、天干、地支、`isSoul`/`isBody`、主星（名+亮度 brightness+生年四化 mutagen）、辅星 minorStars、杂曜 adjectiveStars、大限 `decadal.range`（虚岁）。
- 缺时辰（`birthHour == null`）：`ziwei: null`、`yinzheng: null`，八字侧照常（三柱）。

### 1.3 印证层（纯规则，每条结论必须带 basis 依据文字）

- **主轴速览**：模板填充。
  - 八字轴：`以「{pattern.name}」立局，日主{dayMaster.gan}{strengthLevel}，宜借{favorableElements}起势` + 调候一句（如有）。
  - 紫微轴：`命宫{branch}{主星列表|空宫（借对宫）}，身宫落{身宫宫名}，{五行局}` + 生年化禄落宫一句。
- **五行对照**：八字喜用五行 vs 紫微五行局之五行。`aligned = 局五行 ∈ 喜用(含调候)`；note 写明「同气相求/局与喜用异路，以八字体用为主」两种措辞（规则固定）。
- **时间轴对照**：八字大运 8 步（startAge/startYear）与紫微大限（各宫 decadal 虚岁区间 → 折算公历年）对齐成行；标记当前所处段（虚岁 = 目标年 − 出生年 + 1）。
- **关键转折年**：换大运年 ∪ 换大限年；两者相差 ≤1 年的记 `overlap: true`（权重×2，UI 高亮），reason 写「换运」「换限」或「换运换限重合」。
- **生年四化落宫**：遍历全盘星曜 `mutagen ∈ {禄,权,科,忌}` → `{star, hua, palace}` 四条。
- **五行统计**：八字天干 4 + 地支本气 4（缺时辰则 3+3）计 `Record<木火土金水, number>`，basis 注明口径。

### 1.4 返回契约（shared 契约可选，最少 server + app 各写一份同构类型）

```ts
interface MingpanReport {
  engineVersion: string;         // 当前新盘为 'paipan-v6'
  base: {
    solarDate: string; lunarDate: string; gender: '男' | '女';
    hourKnown: boolean; trueSolarApplied: boolean; birthPlace?: string | null;
    inputTime: string | null;     // 用户录入的法定钟表时间 HH:mm
    chartTime: string | null;     // 实际用于排盘的 YYYY-MM-DD HH:mm，v6 与原始钟表时间一致
    timePrecision: 'exact' | 'shichen' | 'unknown'; // 准确分钟 / 存量时辰代表值 / 未知
    timeStandard: 'civil';        // 不换算真太阳时
    dayBoundary: 'zichu';         // 23:00–23:59 按第二天子时
    hourLabel: string | null;     // 按法定钟表时间得出的时辰；缺时辰 null
  };
  bazi: {
    pillars: ChartView['pillars'];
    dayMaster: ChartView['dayMaster'];
    favorableElements: string[];
    tiaoHou: { gods: string[]; elements: string[] };
    pattern: ChartView['pattern'];
    daYun: ChartView['daYun'];
    wuxingCount: { counts: Record<'木'|'火'|'土'|'金'|'水', number>; basis: string };
  };
  ziwei: null | {
    fiveElementsClass: string; soulStar: string; bodyStar: string;
    yinYang: string; soulBranch: string; bodyBranch: string;
    palaces: Array<{
      name: string; stem: string; branch: string;
      isSoul: boolean; isBody: boolean;
      majorStars: Array<{ name: string; brightness: string; mutagen: string | null }>;
      minorStars: string[]; adjectiveStars: string[];
      decadal: { start: number; end: number } | null;   // 虚岁
    }>;
  };
  yinzheng: null | {
    baziAxis: { text: string; basis: string };
    ziweiAxis: { text: string; basis: string };
    elementCheck: { favorable: string[]; ju: string; juElement: string; aligned: boolean; note: string };
    timeline: Array<{
      years: string;             // '2008–2017'
      daYun: { ganZhi: string; startAge: string; startYear: number } | null;
      daXian: { palace: string; start: number; end: number } | null;
      isCurrent: boolean;
    }>;
    keyYears: Array<{ year: number; age: number; reason: string; overlap: boolean }>;
    sihua: Array<{ star: string; hua: '禄'|'权'|'科'|'忌'; palace: string }>;
  };
  disclaimer: string;            // 固定文案：仅供文化研究与参考…
}
```

### 1.5 测试

`server/test` 现有 profile 路由测试模式：无生辰 → needBazi；有生辰（含时辰）→ 12 宫齐全、四化恰 4 条、时间轴/转折年数值抽查（用固定生辰断言确定性输出）；缺时辰 → ziwei/yinzheng 为 null 且八字照常；fortune 关 → 403。

## 2. 小程序

### 2.1 入口调整（pages/profile/index.tsx）

- 删除 `天时日历 · 逐月攻守` 菜单行（117-120 附近）。
- 同位置新增：`{ ic: 'trend', t: '命盘报告 · 八字紫微印证', onClick: () => navTo('/packages/work/mingpan/index') }`，仍受 `fortuneOn` 门控。
- 军情首页（home）的天时入口与 calendar 页本体**不动**。

### 2.2 新页面 `packages/work/mingpan/`（index.tsx / index.scss / index.config.ts）

- 注册进 `app.config.ts` 的 `packages/work` 分包 `pages[]`；config：`navigationBarTitleText: '命盘报告'`，开启转发（参考 calendar 的 config）。
- 客户端 `api.ts`：`myChartReport(): Promise<MingpanReport | { needBazi: true }>` → `GET /profile/chart/report`；同构类型定义。
- `needBazi` 时：就地补生辰表单（照搬 calendar/index.tsx 的 saveBirth 表单模式，`api.saveBazi` 后重拉报告）。
- 缺时辰：正常渲染八字部分，紫微区显示「紫微须时辰方可立盘」+ 补时辰入口（同表单）。

### 2.3 页面设计（案卷公文风，宋体 serif，全部走设计 token）

根 View 挂 `s.themeClass()`；颜色只用 `--paper/--surface/--ink/--ink-2/--ink-3/--line/--accent` 族 token；标题 serif + kicker 字距（参考 profile 的 `.pf-kicker`）；克制、纸感、留白。

自上而下：

1. **命主档头**：kicker「命盘报告 · 八字紫微印证」+ 排盘日/农历/性别/出生钟表时间/排盘时间/最终时辰 + 徽记（法定钟表时间 / 子初换日 · 23:00）；存量只记时辰的记录必须标「旧记录分钟待确认」，右上角保留印章元素（参考现有 pk-seal）。
2. **八字案卷**：四柱表（列 = 年月日时；行 = 天干十神/干支/藏干十神/纳音），日主旺衰（档位 + 加权分 + basis 小字）、五行统计横条（5 色仅用 accent 深浅与 ink 灰阶区分，不上彩虹色）、格局卡（name + traits/suits/avoid）、喜用与调候。
3. **紫微命盘**：经典 4×4 十二宫图——外圈 12 格，中宫 2×2 合并显示「五行局/命主/身主/阴阳」。每格：宫名、干支、主星（亮度小字上标）、四化徽记（禄权科忌小方章：禄权用 accent、科用 ink-2、忌用暗红 #8C2F2F 一处即可以变量声明）、大限虚岁区间；命宫/身宫格描边高亮。**格子点按 → 底部弹层**展示该宫全量星曜（主/辅/杂）与大限。手机 375px 下每格 ~86px，星名 11-12px，注意截断策略（辅星最多显示 4 个 +「…」，全量进弹层）。
4. **两盘印证**：主轴速览（八字一句/紫微一句，各带 basis 折叠小字）、五行对照（aligned 徽记）、生年四化落宫 4 条。
5. **大运大限时间轴**：双列对齐表（左八字大运干支+十神年段，右紫微大限宫名），当前段高亮；下方「关键转折年」列表，overlap 的年份加重标记。
6. **页脚**：engineVersion 小字 + 免责声明（服务端下发文案）。

### 2.4 验证

- `npm run build:weapp:server`（⚠️ 严禁裸 `build:weapp`，会用 mock 产物覆盖 dist）。
- 类型检查通过；H5 构建可选由主会话统一做预览验证。
