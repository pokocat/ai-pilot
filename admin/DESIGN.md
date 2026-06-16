---
name: "军师运营后台"
description: "Warm, dense, task-first console for operating users, agents, credits, audit logs, and AI configuration."
colors:
  paper: "#FBFAF6"
  parchment: "#F4F2EC"
  surface: "#FFFFFF"
  surface-muted: "#F3F1EA"
  ink: "#16191D"
  ink-secondary: "#565C63"
  ink-muted: "#969BA1"
  line: "#E7E4DB"
  line-soft: "#EFEDE5"
  command-gold: "#A07D2C"
  command-gold-deep: "#6E5621"
  command-gold-soft: "#F2EAD6"
  command-gold-ink: "#43340F"
  command-gold-bright: "#D8B25A"
  status-gold: "#9B7C3F"
  danger: "#9C4A38"
  success: "#2D7A52"
  success-strong: "#1C7C4B"
  warning: "#9A6419"
typography:
  display:
    fontFamily: "Noto Serif SC, Songti SC, serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0"
  headline:
    fontFamily: "Noto Serif SC, Songti SC, serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0"
  title:
    fontFamily: "Noto Sans SC, -apple-system, PingFang SC, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0"
  body:
    fontFamily: "Noto Sans SC, -apple-system, PingFang SC, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "0"
  label:
    fontFamily: "Noto Sans SC, -apple-system, PingFang SC, Segoe UI, sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "0"
  mono:
    fontFamily: "SFMono-Regular, JetBrains Mono, monospace"
    fontSize: "10.5px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0"
rounded:
  xs: "5px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "14px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  page-x: "20px"
components:
  button-primary:
    backgroundColor: "{colors.command-gold}"
    textColor: "{colors.surface}"
    typography: "{typography.title}"
    rounded: "{rounded.lg}"
    height: "44px"
    padding: "0 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.title}"
    rounded: "{rounded.lg}"
    height: "44px"
    padding: "0 16px"
  button-danger-small:
    backgroundColor: "rgba(156,74,56,.08)"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "30px"
    padding: "0 9px"
  input-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 12px"
  card-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "14px 15px"
  chip-default:
    backgroundColor: "rgba(155,124,63,.14)"
    textColor: "{colors.status-gold}"
    typography: "{typography.mono}"
    rounded: "{rounded.xs}"
    padding: "3px 6px"
---

# Design System: 军师运营后台

## Overview

**Creative North Star: "The Warm Command Desk"**

The admin interface is a focused operating desk for a founder-facing AI product: warm enough to belong to 军师, restrained enough for repeated operational work. It uses a paper-and-ink foundation with a single gold command color, so the console feels deliberate rather than promotional. It should feel like a polished internal control room, not a SaaS landing page compressed into an app shell.

The physical scene is an operator checking users, credits, models, logs, and agent settings from a laptop or phone during active support. The interface must scan quickly, hold dense rows without visual panic, and make destructive or system-level actions legible without theatrical styling. Design serves the task: data first, controls second, decoration last.

This system explicitly rejects generic AI-tool marketing, neon model dashboards, over-glassy admin chrome, heavy gradients, and card grids that look interchangeable. It also rejects user-facing sales copy inside operational screens: the product language is "产出额度", "专项能力", "模型配置", "审计", and "技能库", not "充值", "爆款", or "最受欢迎".

**Key Characteristics:**
- Warm neutral surfaces with one restrained gold accent.
- Dense but breathable lists, rows, panels, and tables.
- Serif only for brand marks, page titles, and key numbers.
- Familiar product controls: segmented choices, toggles, text fields, compact buttons.
- Full-screen mobile-first admin shell with no decorative frame.

## Colors

The palette is paper, ink, and command gold: warm neutrals carry the surface; gold marks decisions, active states, and operational emphasis.

### Primary
- **Command Gold**: The primary action and active-state color. Use it for selected navigation, primary buttons, toggle-on surfaces, focused selections, progress bars, and small icons that carry action.
- **Deep Command Gold**: Use for text on gold-tinted backgrounds and for stronger data emphasis where pure accent would feel too bright.
- **Soft Command Gold**: Use as a background for icons, enabled states, badges, and low-pressure highlights.
- **Bright Command Gold**: Use only as a secondary highlight in progress fills and toast icon accents.

### Secondary
- **Operational Success Green**: Use only for positive state, successful health, and live status, never for brand accents.
- **Risk Red**: Use only for destructive actions, errors, and dangerous status.
- **Warning Ochre**: Use for 4xx-style warnings and partial failure states.

### Neutral
- **Warm Paper**: Main page background. It keeps the admin shell soft without becoming beige decoration.
- **Parchment Backdrop**: Secondary page layer for the full-screen app shell.
- **Clean Surface**: Card, row, field, table, and panel background.
- **Muted Surface**: Secondary field and table-header layer.
- **Primary Ink**: Body text, table targets, names, and high-value data.
- **Secondary Ink**: Supporting labels, row descriptions, and non-primary buttons.
- **Muted Ink**: Metadata, subtitles, timestamps, disabled labels.
- **Warm Lines**: Borders and dividers. Borders are structural, not ornamental.

### Named Rules

**The One Command Color Rule.** Gold is the only brand action color. Do not introduce purple, blue, neon, or rainbow model colors for visual excitement.

**The Status Is Not Brand Rule.** Green, red, and warning ochre are reserved for state. Never use them as decorative accents.

## Typography

**Display Font:** Noto Serif SC / Songti SC, with serif fallback.
**Body Font:** Noto Sans SC, with Apple and PingFang system fallbacks.
**Label/Mono Font:** SFMono-Regular / JetBrains Mono, with monospace fallback.

**Character:** The pairing is institutional and readable: serif gives the console a quiet 军师 identity, while sans and mono keep operational data fast to scan. Labels and data stay compact; headings carry just enough gravity.

### Hierarchy

- **Display** (600, 24px, 1): Used for large dashboard numbers and major quantified stats.
- **Headline** (600, 17px, 1.2): Used for section titles such as 今日概览, 注册用户, 审计日志.
- **Title** (600, 14px, 1.35): Used for row titles, card names, and primary component labels.
- **Body** (400, 13px, 1.6): Used for form input text, descriptions, operational notes, and readable copy blocks.
- **Label** (500, 11.5px, 1.25): Used for field labels, subtitles, helper text, and secondary metadata.
- **Mono Label** (600, 10.5px, 1): Used for timestamps, system keys, status codes, short IDs, and console-like values.

### Named Rules

**The Serif Restraint Rule.** Serif is for identity, headings, and numbers. It is prohibited inside buttons, table cells, dense form labels, and routine metadata.

**The No Fluid Type Rule.** Product UI text sizes are fixed. Do not scale font size with viewport width.

## Elevation

Elevation is a hybrid of tonal layering and very soft ambient shadow. Most structure comes from warm surface color, 1px borders, and compact spacing. Shadows are quiet and shallow; they separate surfaces without making the admin feel like floating cards.

### Shadow Vocabulary

- **Subtle Surface Shadow** (`0 1px 2px rgba(22,25,29,.04), 0 2px 8px rgba(22,25,29,.04)`): Use for rows, cards, stats, lists, and light containers.
- **Panel Shadow** (`0 2px 6px rgba(22,25,29,.05), 0 12px 30px rgba(22,25,29,.07)`): Use for login cards, toast surfaces, and elevated account menus.
- **Switch Thumb Shadow** (`0 1px 2px rgba(0,0,0,.25)`): Use only on toggle thumbs.

### Named Rules

**The Quiet Surface Rule.** If a shadow is the first thing you notice, it is too strong. Use borders and tonal layers before increasing shadow.

**The No Nested Cards Rule.** Page sections can contain repeated cards or rows, but cards must not be placed inside decorative cards.

## Components

### Buttons

Buttons are compact, familiar, and consistent. They use icons where useful and avoid ornamental shapes.

- **Shape:** Gently curved rectangles for primary and ghost actions (12px radius); compact actions use 8px radius.
- **Primary:** Command Gold background, white text, 44px height, 13.5px semibold text, icon gap 7px.
- **Hover / Focus:** Hover is a quiet tonal shift. Focus must be visible with a gold outline or border shift; do not rely on color alone.
- **Ghost:** Transparent background, warm border, secondary ink text. Use for cancel, test, and secondary actions.
- **Danger:** Red-tinted surface with red text and red border. Use only for destructive row actions.
- **Add Button:** Full-width dashed gold outline for "新增" entry points in settings pages.

### Chips

Chips are small operational labels, not promotional badges.

- **Style:** 9.5px mono text, 5px radius, compact padding, warm gold tint or muted neutral.
- **State:** Gold tint marks active or payment-related state; muted neutral marks inactive values such as keys, disabled status, or off-state tags.

### Cards / Containers

Cards are repeated operational items or framed tools only.

- **Corner Style:** 11-14px radius depending on density.
- **Background:** Clean Surface for cards and rows; Muted Surface for key-value cells and table headers.
- **Shadow Strategy:** Subtle Surface Shadow only. Panel Shadow is reserved for login, menus, and toasts.
- **Border:** Always a 1px Warm Line or Soft Line. Never use side-stripe accents.
- **Internal Padding:** Dense rows use 12-14px; cards use 14-16px; admin page gutters use 20px desktop and 14-16px mobile.

### Inputs / Fields

Inputs are utilitarian and stable.

- **Style:** 40px height, 10px radius, 1px Warm Line border, Clean Surface background.
- **Focus:** Border shifts to Command Gold. Do not add glow unless the control is otherwise hard to locate.
- **Textarea:** 12px radius, 12.5px body text, 1.7 line-height, soft shadow when used for prompts or JSON.
- **Error / Disabled:** Disabled opacity is reduced; errors use Risk Red with a tinted background.

### Navigation

The admin shell uses a fixed top identity bar, scrollable content, and a horizontal bottom nav.

- **Top Bar:** Warm paper background, 30px black square seal, serif "军" mark, compact subtitle.
- **Bottom Navigation:** Horizontal scroll on small screens, 56px item width, icon above label, selected item in Command Gold.
- **Mobile Treatment:** No phone shell, no frame, no fake device chrome. The admin is full-screen and viewport-safe.

### Tables and Audit Rows

Tables are dense first, responsive second.

- **Desktop:** Audit rows keep one-line cells with ellipsis, mono time/status/method, and horizontal scroll only when the table exceeds the viewport.
- **Mobile:** Audit rows collapse into a two-line event stream with hidden header, fixed status/method/time columns, and clickable rows for detail.
- **Detail Panel:** Full-screen slide panel, paper background, compact title bar, structured key-value fields, and pre-wrapped JSON blocks.

### Panels and Drawers

The detail panel is the standard drill-in pattern for user, agent, trace, and audit detail.

- **Motion:** Slide in from the right with a 300ms cubic-bezier transition.
- **Header:** Back circle, optional icon tile, serif title, muted subtitle.
- **Body:** Scrollable vertical stack with blocks, field groups, toggles, and bottom save bar where appropriate.

## Do's and Don'ts

### Do:

- **Do** use Command Gold as the only brand action color.
- **Do** keep admin surfaces full-screen, borderless, and task-focused.
- **Do** use `add-btn full`, `ai-btn`, `mini-btn`, `ai-field`, `crd new-agent`, and `mem-card` patterns consistently for new admin settings screens.
- **Do** use mono for timestamps, status codes, system paths, token counts, and IDs.
- **Do** keep mobile audit and settings screens vertically scannable with no horizontal content overflow.
- **Do** use product terms from the app: "专项能力", "产出额度", "模型配置", "技能库", "审计".
- **Do** make every interactive row visibly clickable through cursor, hover, or focus treatment.

### Don't:

- **Don't** use "赠送 / 付费解锁 / 充值 / 最受欢迎 / 灵活付费" as user-facing promotional copy in operational surfaces.
- **Don't** expose "Agent Memory" to end users; admin can use the term, user-facing surfaces must say "专属理解".
- **Don't** add purple-blue gradients, neon accents, glassmorphism, decorative orbs, or SaaS hero-metric styling.
- **Don't** use side-stripe borders greater than 1px as accents on cards, list items, callouts, or alerts.
- **Don't** create one-off button styles with inline width, padding, and colors when a shared component vocabulary exists.
- **Don't** put cards inside cards or make page sections look like floating decorative cards.
- **Don't** hide payload, status, IP, UA, or timestamp details behind vague labels on audit surfaces.

## Engineering Compliance（代码约束 · 强制）

设计系统不是参考、是约束。运营后台（`admin/`）的**所有**前端变更必须满足下列规则，并通过 `npm run lint:ui`（已接入 `admin` 的 `build`，见 `scripts/audit-admin-ui.mjs`）。违反即缺陷。

### 1. 颜色只用 token，禁止硬编码
- 颜色一律走 `admin/src/styles/admin.css` 的 `:root` CSS 变量；**`.tsx` 内联样式与 `.css`（`:root` 之外）都不得出现 `#hex` / `rgb()` / `rgba()` 颜色**（纯黑白 `#fff`/`#000` 除外；rgba 仅允许在 CSS 组件类里做同色 tint/scrim）。
- Token：背景 `--bg/--paper/--surface/--surface-2`；文字 `--ink/--ink-2/--ink-3`；线 `--line/--line-2`；品牌金 `--accent/--accent-deep/--accent-soft/--accent-ink/--accent-bright/--gold`；状态 `--danger`（红）`--success`（绿）；字体 `--serif/--sans/--mono`；阴影 `--shadow-sm`（行/卡）`--shadow-md`（弹层/菜单/toast）。
- **One Command Color**：金 = 唯一品牌动作色。绿=成功、红=危险、ochre=警告，只表状态、不作装饰。需要新颜色先在 `:root` 加 token，再 `var()` 引用。

### 2. 只用组件类词汇，禁止裸 class / 一次性 inline
- 用既有组件类，**不得引用 admin.css 里没有定义的 class**（如曾经的裸 `gh`，会退化成无样式原生控件）。常用词汇：
  - 按钮：`ai-btn`（`.primary`/`.ghost`/`.auto`，44px 表单动作）、`mini-btn`（`.primary`/`.danger`/`.edit-action`，行内紧凑动作）、`add-btn full`（新增入口）、`ai-preset`（`.on`/`.add`，快速切换/添加）。**取消/测试=ghost**。
  - 容器：`crd`/`crd-row`、`mem-card`、`usage-row`+`usage-num`（`.ok`）、`stat`、`kv`、`tag`（`.off`）、`pill`、`empty`（空态）、`modal-scrim`（弹层遮罩）、`acct-menu`/`acct-menu-item`。
  - 表单：`ai-field`、`ai-input`、`ai-range`、`ta`、`bill-seg`/`bill-opt`、`blk-d`（`.ok`/`.err`）。
- **禁止给 `<button>/<input>/<select>` 加一次性 inline `style`**（width/padding/color/border/background）。需要变体就加修饰类（如 `.ai-btn.auto`、`.ai-preset.add`），不要内联。
- `style={{}}` 仅允许做**随运行时数据变化的布局**（如 `marginTop`、根据数据算的 `width`、进度条 `width: x%`）；颜色/边框/圆角/内边距/阴影一律交给 token 与组件类。

### 3. 字体（Serif Restraint）
- `--serif` 只用于品牌标记、页面/分区标题、关键数字；**禁止**用在按钮、表格单元格、密集表单标签、常规元数据里（那些用 `--sans`/`--mono`）。

### 4. 提交前必过
- `cd admin && npm run lint:ui`（设计系统合规）+ `npx tsc --noEmit`（类型）必须全绿；`npm run build` 会自动先跑 lint:ui。新增/改动 UI 前先读本文件与 `Do's and Don'ts`。
