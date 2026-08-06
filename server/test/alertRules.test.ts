// 告警规则与应用指标的**对账**测试。
//
// 为什么非要有：告警规则里写错一个指标名或标签值，Prometheus 不会报错——那条规则只是
// **永远不触发**。监控看起来「配好了」，实际那一路是聋的。2026-08-04 复盘里踩到两次同类：
//   ① `junshi_llm_output_truncated_total` 加了 resolved 标签后，老规则把「已被续写救回」
//      也当事故告警（语义漂移，不是拼写错）；
//   ② `A > 0 and sum(B) == 0` 两侧标签集不匹配（左带 provider/phase、右无标签），
//      PromQL 的 and 直接得空集 —— 规则永不触发。promtool check rules 对这两种都是 SUCCESS。
//
// 本测试锁三件事：
//   1. 规则引用的每个 junshi_* 指标名，应用侧真的会渲染（含直方图的 _bucket/_sum/_count）；
//   2. 规则引用的每个 junshi_alert_config{key="..."} 都在 ALERT_CONFIG_DEFS 里（否则 scalar()
//      返回 NaN，比较恒为假 —— 又是一条静默失效的规则）；
//   3. `and` / `unless` 两侧要么都无标签聚合、要么显式写了 on(...) —— 防第 ② 类。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { ALERT_CONFIG_DEFS } from '../src/services/alertConfig.js';
import { ALERT_KNOWLEDGE } from '../src/services/alertCard.js';
import { renderMetrics } from '../src/services/metrics.js';

const ALERTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'monitoring', 'prometheus', 'alerts');
const METRICS_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'metrics.ts');
const ALERTMANAGER_CONFIG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'monitoring', 'alertmanager', 'alertmanager.yml');

interface Rule {
  alert?: string;
  record?: string;
  expr?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}
interface RuleFile { groups?: { name?: string; rules?: Rule[] }[] }

function allRules(): { file: string; group: string; name: string; expr: string; labels: Record<string, string>; annotations: Record<string, string> }[] {
  const out: { file: string; group: string; name: string; expr: string; labels: Record<string, string>; annotations: Record<string, string> }[] = [];
  for (const file of readdirSync(ALERTS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    const doc = yaml.load(readFileSync(join(ALERTS_DIR, file), 'utf8')) as RuleFile;
    for (const g of doc.groups ?? []) {
      for (const r of g.rules ?? []) {
        out.push({
          file, group: g.name ?? '?', name: r.alert ?? r.record ?? '?', expr: r.expr ?? '',
          labels: r.labels ?? {}, annotations: r.annotations ?? {},
        });
      }
    }
  }
  return out;
}

/**
 * 应用侧「存在」的 junshi_* 指标名集合。
 * 两个来源合并：① 实际渲染输出（计数器/gauge 空序列也会渲染一行 0）；
 * ② metrics.ts 里声明的名字（直方图无数据时 renderInto 直接 return，渲染里看不到）。
 */
async function knownMetricNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const line of (await renderMetrics()).split('\n')) {
    const m = /^(?:# (?:HELP|TYPE) )?(junshi_[a-z0-9_]+)/.exec(line);
    if (m) names.add(m[1]);
  }
  const src = readFileSync(METRICS_SRC, 'utf8');
  for (const m of src.matchAll(/'(junshi_[a-z0-9_]+)'/g)) names.add(m[1]);
  return names;
}

/** 直方图派生序列还原成基名。 */
function baseName(name: string): string {
  return name.replace(/_(bucket|sum|count)$/, '');
}

describe('告警规则 × 应用指标对账', () => {
  test('规则文件能解析且不为空', () => {
    const rules = allRules();
    assert.ok(rules.length >= 10, `只解析出 ${rules.length} 条规则，规则目录或格式有问题`);
    for (const r of rules) assert.ok(r.expr.trim(), `${r.file}/${r.name} 的 expr 为空`);
  });

  test('每条告警都有卡片分组、实时值、摘要与人类可读处置知识', () => {
    const bad: string[] = [];
    for (const r of allRules()) {
      if (!r.name || r.name === '?') continue;
      if (!r.labels.severity) bad.push(`${r.file}/${r.name} 缺 severity`);
      if (!r.labels.category) bad.push(`${r.file}/${r.name} 缺 category（飞书无法按领域组卡）`);
      if (!r.annotations.summary) bad.push(`${r.file}/${r.name} 缺 summary`);
      if (!r.annotations.current) bad.push(`${r.file}/${r.name} 缺 current（卡片无法显示实时值）`);
      const knowledge = ALERT_KNOWLEDGE[r.name];
      if (!knowledge?.title || !knowledge?.threshold || !knowledge?.impact || !knowledge?.action) {
        bad.push(`${r.file}/${r.name} 缺完整告警知识（title/threshold/impact/action）`);
      }
    }
    assert.deepEqual(bad, [], `以下告警不能生成完整飞书卡片：\n${bad.join('\n')}`);
  });

  test('规则摘要不直接暴露实现术语，估算结算只做指标不发告警', () => {
    const rules = allRules();
    assert.equal(rules.some((r) => r.name === 'JunshiChatUsageEstimated'), false, '估算结算没有人工处置动作，不应作为告警');
    const forbidden = /\b(provider|usage|GenerationJob|attempt|fallback|sweep|MAX_IN_FLIGHT|probe_success|pg_up)\b|cooling=|\b(path|ref|job|instance)=|\bup=0\b/i;
    const bad = rules
      .filter((r) => {
        const renderedCopy = `${r.annotations.summary ?? ''}\n${r.annotations.current ?? ''}`.replace(/\{\{[^}]+\}\}/g, '动态值');
        return forbidden.test(renderedCopy);
      })
      .map((r) => `${r.file}/${r.name}`);
    assert.deepEqual(bad, [], `以下用户可见告警仍含实现术语：\n${bad.join('\n')}`);
  });

  test('Alertmanager 按领域+等级组卡，成对阈值只按非空 signal 抑制', () => {
    const config = yaml.load(readFileSync(ALERTMANAGER_CONFIG, 'utf8')) as {
      route?: { group_by?: string[] };
      inhibit_rules?: { source_matchers?: string[]; target_matchers?: string[]; equal?: string[] }[];
    };
    assert.deepEqual(config.route?.group_by, ['category', 'severity']);
    const paired = (config.inhibit_rules ?? []).find((r) => r.equal?.includes('signal'));
    assert.ok(paired, '缺少同 signal 的 warning/critical 抑制规则');
    assert.ok(paired.source_matchers?.some((m) => /signal\s*=~\s*"\.\+"/.test(m)), 'source 必须限定 signal 非空，否则会误抑制同领域无 signal 告警');
    assert.ok(paired.target_matchers?.some((m) => /signal\s*=~\s*"\.\+"/.test(m)), 'target 必须限定 signal 非空');

    const bySignal = new Map<string, Set<string>>();
    for (const rule of allRules()) {
      if (!rule.labels.signal) continue;
      const levels = bySignal.get(rule.labels.signal) ?? new Set<string>();
      levels.add(rule.labels.severity);
      bySignal.set(rule.labels.signal, levels);
    }
    for (const [signal, levels] of bySignal) {
      assert.ok(levels.has('warning') && levels.has('critical'), `${signal} 带 signal 但不是 warning/critical 成对规则`);
    }
  });

  test('引用的每个 junshi_* 指标名，应用侧真的会渲染', async () => {
    const known = await knownMetricNames();
    const missing: string[] = [];
    for (const r of allRules()) {
      // 排除 junshi_alert_config 的标签值等字符串内容，只看指标名位置的标识符。
      for (const m of r.expr.matchAll(/\bjunshi_[a-z0-9_]+/g)) {
        const n = m[0];
        if (!known.has(n) && !known.has(baseName(n))) missing.push(`${r.file}/${r.name} → ${n}`);
      }
    }
    assert.deepEqual(missing, [], `规则引用了不存在的指标名（这些规则永远不会触发）：\n${missing.join('\n')}`);
  });

  test('引用的每个 alert_config key 都在注册表里（否则 scalar() 得 NaN，比较恒假）', () => {
    const keys = new Set(ALERT_CONFIG_DEFS.map((d) => d.key));
    const missing: string[] = [];
    for (const r of allRules()) {
      for (const m of r.expr.matchAll(/junshi_alert_config\{key="([a-z0-9_]+)"\}/g)) {
        if (!keys.has(m[1])) missing.push(`${r.file}/${r.name} → key="${m[1]}"`);
      }
    }
    assert.deepEqual(missing, [], `规则引用了未注册的阈值 key：\n${missing.join('\n')}`);
  });

  test('and / unless 两侧必须标签集可匹配（都聚合成无标签，或显式 on(...)）', () => {
    const bad: string[] = [];
    for (const r of allRules()) {
      // 逐个 and/unless 出现处检查：紧跟其后要么是 on(/ignoring(，要么两侧都是 sum(/count(/max(/min( 这类聚合。
      for (const m of r.expr.matchAll(/\b(and|unless)\b\s*(on\s*\(|ignoring\s*\()?/g)) {
        if (m[2]) continue; // 显式写了 on()/ignoring()
        const left = r.expr.slice(0, m.index);
        const right = r.expr.slice(m.index + m[0].length);
        const aggregated = (s: string) => /\b(sum|count|max|min|avg|scalar|histogram_quantile)\s*\(/.test(s);
        if (!(aggregated(left) && aggregated(right))) {
          bad.push(`${r.file}/${r.name} → "${m[1]}" 两侧未聚合且没写 on()`);
        }
      }
    }
    assert.deepEqual(bad, [], `以下 and/unless 可能因标签集不匹配而永不触发：\n${bad.join('\n')}`);
  });

  test('截断告警必须按 resolved 区分——continued 是被救回来的，不该当事故', () => {
    const truncationRules = allRules().filter((r) => r.expr.includes('junshi_llm_output_truncated_total'));
    assert.ok(truncationRules.length > 0, '截断指标一条告警都没有');
    for (const r of truncationRules) {
      assert.match(
        r.expr,
        /resolved="(continued|given_up)"/,
        `${r.file}/${r.name} 没按 resolved 过滤：会把「已自动续写救回」也报成事故`,
      );
    }
  });

  test('429 比率告警必须有最小样本门槛，低流量单个 429 不放大成假警', () => {
    const rules = allRules().filter((r) => r.name === 'JunshiLlm429RateHigh' || r.name === 'JunshiLlm429RateCritical');
    assert.equal(rules.length, 2);
    for (const r of rules) {
      assert.match(r.expr, /increase\(junshi_llm_granted_total\[10m\]\)\)\s*>=\s*20/);
      assert.match(r.expr, /and\s+on\(\)/);
    }
  });

  test('API P95/错误率只看用户交互接口，并以 15 分钟最小样本量防低流量误报', () => {
    const names = ['JunshiApiP95High', 'JunshiApiP95Critical', 'JunshiApi5xxRateHigh'];
    const rules = allRules().filter((r) => names.includes(r.name));
    assert.equal(rules.length, names.length);
    for (const r of rules) {
      assert.match(r.expr, /api_min_requests_15m/);
      assert.match(r.expr, /\[15m\]/);
      assert.match(r.expr, /route!~"\.\*\(generate\|stream\|upload\|webhook\|callback\|metrics\|health\)\.\*"/);
      assert.match(r.expr, /and\s+on\(\)/);
    }
    const errors = rules.find((r) => r.name === 'JunshiApi5xxRateHigh')!;
    assert.match(errors.expr, /junshi_http_route_responses_total/);
    assert.doesNotMatch(errors.expr, /junshi_http_responses_total/);
  });

  test('残文保全告警只看已有可见正文的 stall，并按 provider 对齐', () => {
    const rule = allRules().find((r) => r.name === 'JunshiChatPartialKeptBroken');
    assert.ok(rule);
    assert.match(rule.expr, /junshi_chat_stream_stall_total\{had_text="yes"\}/);
    assert.match(rule.expr, /junshi_chat_partial_kept_total\{cause="stream_error"\}/);
    assert.match(rule.expr, /and\s+on\(provider\)/);
  });
});
