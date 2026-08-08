// 方言表等价性（2026-08-07 · 重设计二期）。
//   cd server && npm test -- test/dialects.test.ts
//
// 二期把「用 baseUrl 空不空猜官方/网关、用模型名正则猜 thinking 支持」这两处散落推断，
// 换成了一张方言表 + 一个 inferDialect()。**这类重构最大的风险是悄悄改掉线上请求的组装**，
// 所以本文件的核心不是逐个断言新行为，而是**把历史逻辑原样抄成 oracle，跑全矩阵比对**：
// 只要新旧在任何一个可达组合上不一致，测试就红。刻意的差异必须在 KNOWN_DELTAS 里显式登记，
// 登记时要写清为什么它不可能命中存量配置——没登记的差异一律视为回归。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  thinkingRequestTuning, supportsThinkingConfig, normalizeThinkingMode, normalizeThinkingBudget,
  type ThinkingConfigLike,
} from '../src/llm/thinking.js';
import { inferDialect, resolveDialect, dialectById, DIALECTS } from '../src/llm/dialects.js';
import type { AiProvider, AiThinkingMode } from '../src/llm/schema.js';

// ── 历史逻辑的逐行抄写（改动前的 thinking.ts，勿"顺手优化"）──────────────────────
function legacySupports(cfg: { provider: AiProvider; model: string }): boolean {
  return cfg.provider === 'claude' || /claude/i.test(cfg.model);
}
function legacyTuning(
  cfg: ThinkingConfigLike,
  opts: { allowThinking?: boolean } = {},
): { temperature: number; thinking?: { type: string; budget_tokens?: number } } {
  if (!legacySupports(cfg)) return { temperature: cfg.temperature };
  const configuredMode = normalizeThinkingMode(cfg.thinkingMode);
  if (cfg.provider === 'openai' && configuredMode === 'disabled') return { temperature: cfg.temperature };
  const mode = opts.allowThinking === false ? 'disabled' : configuredMode;
  if (mode === 'enabled') {
    return { temperature: 1, thinking: { type: 'enabled', budget_tokens: normalizeThinkingBudget(cfg.thinkingBudget) } };
  }
  if (mode === 'adaptive') return { temperature: 1, thinking: { type: 'adaptive' } };
  if (cfg.provider === 'claude' && !cfg.baseUrl?.trim()) return { temperature: cfg.temperature };
  return { temperature: cfg.temperature, thinking: { type: 'disabled' } };
}

// ── 全矩阵 ────────────────────────────────────────────────────────────────────
const PROVIDERS: AiProvider[] = ['claude', 'openai', 'mock'];
const BASE_URLS = [
  '',                                          // 官方直连（历史判据就是这个空串）
  'https://api.qnaigc.com',                    // 生产：七牛 Anthropic 网关
  'https://api.qnaigc.com/bypass/anthropic',   // 生产：另一种写法
  'https://api.qnaigc.com/v1',                 // 七牛 OpenAI 兼容
  'https://api.deepseek.com/anthropic',
  'https://api.openai.com/v1',
  'https://apihub.agnes-ai.com/v1',
];
const MODELS = ['claude-opus-4-6', 'dj-claude-4.6-opus', 'deepseek-chat', 'template', 'gpt-4o-mini'];
const MODES: AiThinkingMode[] = ['disabled', 'enabled', 'adaptive'];
const ALLOW = [true, false, undefined];

/**
 * 已登记的刻意差异。**每一条都必须论证它不可能命中存量配置**，否则就是回归而不是差异。
 * 两条差异同源：历史代码只看「模型名里有没有 claude」，不看这个模型是否真的挂在懂 thinking 的端点上。
 */
const KNOWN_DELTAS: { why: string; hit: (p: AiProvider, baseUrl: string, model: string) => boolean }[] = [
  {
    // 老逻辑会把 thinking 发给 OpenAI 官方（官方必拒）；新逻辑直接不发。
    // 不可能命中存量：这要求运营在 api.openai.com 上挂一个名字带 claude 的模型——
    // 那个模型在 OpenAI 官方根本不存在，这条配置在发 thinking 之前就已经 404 了。
    why: 'openai_official + claude 系模型名：历史发 thinking（必被官方拒），现在不发',
    hit: (p, baseUrl, model) => p === 'openai' && /(^|\.)api\.openai\.com$/.test(hostOf(baseUrl)) && /claude/i.test(model),
  },
  {
    // 老逻辑对 provider=mock 也看模型名；新逻辑按方言直接判定 mock 不支持 thinking。
    // 不可能命中存量：mock 是本地模板，根本不发 HTTP 请求，thinking 参数不会离开进程。
    why: 'mock + claude 系模型名：历史按模型名发 thinking，现在按方言一律不发',
    hit: (p, _baseUrl, model) => p === 'mock' && /claude/i.test(model),
  },
];
function hostOf(u: string): string { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } }
function isKnownDelta(p: AiProvider, baseUrl: string, model: string): string | null {
  return KNOWN_DELTAS.find((d) => d.hit(p, baseUrl, model))?.why ?? null;
}

describe('方言表：新旧请求组装逐位等价（未登记的差异一律算回归）', () => {
  test('全矩阵比对 —— 315 个组合', () => {
    let compared = 0;
    let deltas = 0;
    for (const provider of PROVIDERS) {
      for (const baseUrl of BASE_URLS) {
        for (const model of MODELS) {
          for (const thinkingMode of MODES) {
            for (const allowThinking of ALLOW) {
              const cfg: ThinkingConfigLike = {
                provider, baseUrl, model, temperature: 0.42, thinkingMode, thinkingBudget: 4096,
              };
              const opts = allowThinking === undefined ? {} : { allowThinking };
              const legacy = legacyTuning(cfg, opts);
              const next = thinkingRequestTuning(cfg, opts);
              const delta = isKnownDelta(provider, baseUrl, model);
              if (delta) { deltas++; continue; }
              assert.deepEqual(
                next, legacy,
                `组合不一致 provider=${provider} baseUrl=${baseUrl || '(空)'} model=${model} mode=${thinkingMode} allow=${allowThinking}`,
              );
              compared++;
            }
          }
        }
      }
    }
    // 比对面必须够大——若哪天矩阵被缩水成几条，这个断言会先炸。
    assert.ok(compared > 250, `等价比对样本过少：${compared}`);
    assert.ok(deltas > 0, '登记了差异却一条都没命中，说明 KNOWN_DELTAS 的判据写错了');
  });

  test('supportsThinkingConfig 也与历史口径一致（除已登记差异）', () => {
    for (const provider of PROVIDERS) {
      for (const baseUrl of BASE_URLS) {
        for (const model of MODELS) {
          if (isKnownDelta(provider, baseUrl, model)) continue;
          assert.equal(
            supportsThinkingConfig({ provider, baseUrl, model }),
            legacySupports({ provider, model }),
            `provider=${provider} baseUrl=${baseUrl || '(空)'} model=${model}`,
          );
        }
      }
    }
  });
});

describe('生产两条链路的方言判定', () => {
  test('七牛 Anthropic 网关 → 显式 disabled 且不带 budget_tokens', () => {
    const cfg: ThinkingConfigLike = {
      provider: 'claude', baseUrl: 'https://api.qnaigc.com/bypass/anthropic', model: 'claude-opus-4-6',
      temperature: 0.7, thinkingMode: 'disabled', thinkingBudget: 1024,
    };
    assert.equal(inferDialect('claude', cfg.baseUrl!).id, 'anthropic_gateway');
    const r = thinkingRequestTuning(cfg);
    assert.deepEqual(r.thinking, { type: 'disabled' });
    // 2026-07-27 生产实测：带 budget_tokens 会返回 Extra inputs are not permitted。
    assert.equal('budget_tokens' in (r.thinking as object), false);
  });

  test('Anthropic 官方直连（baseUrl 空）→ 整体省略 thinking', () => {
    const r = thinkingRequestTuning({
      provider: 'claude', baseUrl: '', model: 'claude-opus-4-6',
      temperature: 0.7, thinkingMode: 'disabled', thinkingBudget: 1024,
    });
    assert.equal(r.thinking, undefined);
    assert.equal(r.temperature, 0.7);
  });

  test('OpenAI 兼容：运营没开过思考 → 完全省略；开过后被工具链强制关 → 显式 disabled', () => {
    const base = { provider: 'openai' as const, baseUrl: 'https://api.qnaigc.com/v1', model: 'dj-claude-4.6-opus', temperature: 0.7, thinkingBudget: 1024 };
    assert.equal(thinkingRequestTuning({ ...base, thinkingMode: 'disabled' }).thinking, undefined);
    // 这一条极易在重构中丢掉：运营开过 → 网关认这个扩展 → 成果/工具请求必须显式按下去，
    // 否则网关带着思考进多轮工具调用，破坏强制 emit_deliverable 收口。
    assert.deepEqual(
      thinkingRequestTuning({ ...base, thinkingMode: 'enabled' }, { allowThinking: false }).thinking,
      { type: 'disabled' },
    );
  });

  test('开启思考时 temperature 临时为 1，但配置原值不被改写', () => {
    const cfg: ThinkingConfigLike = {
      provider: 'claude', baseUrl: 'https://api.qnaigc.com', model: 'claude-opus-4-6',
      temperature: 0.3, thinkingMode: 'adaptive', thinkingBudget: 1024,
    };
    assert.equal(thinkingRequestTuning(cfg).temperature, 1);
    assert.equal(cfg.temperature, 0.3);
  });
});

describe('方言的固化与推断', () => {
  test('显式 dialect 覆盖推断（运营点过「确认固化」后不再靠猜）', () => {
    const r = resolveDialect({ provider: 'claude', baseUrl: 'https://api.qnaigc.com', dialect: 'anthropic_official' });
    assert.equal(r.explicit, true);
    assert.equal(r.dialect.id, 'anthropic_official');
    // 固化成官方后，关闭思考就变成「整体省略」——这正是固化的意义：改判据而不是改代码。
    assert.equal(thinkingRequestTuning({
      provider: 'claude', baseUrl: 'https://api.qnaigc.com', model: 'claude-opus-4-6',
      temperature: 0.7, thinkingMode: 'disabled', thinkingBudget: 1024, dialect: 'anthropic_official',
    }).thinking, undefined);
  });

  test('未知 dialect 值 → 退回推断，不抛（脏数据不能把外呼打挂）', () => {
    const r = resolveDialect({ provider: 'claude', baseUrl: 'https://x', dialect: '不存在的方言' });
    assert.equal(r.explicit, false);
    assert.equal(r.dialect.id, 'anthropic_gateway');
  });

  test('DeepSeek 的 Anthropic 端点：关闭写法与通用网关一致，但 budget 不被采纳', () => {
    const d = inferDialect('claude', 'https://api.deepseek.com/anthropic');
    assert.equal(d.id, 'anthropic_deepseek');
    assert.equal(d.thinkingOff, 'explicit');   // 与通用网关同口径 → 存量行为零变化
    assert.equal(d.budgetHonored, false);      // 后台据此提示「这个预算不生效」
  });

  test('方言表自身自洽：id 唯一、Anthropic 协议一律不能同源做嵌入', () => {
    const ids = DIALECTS.map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const d of DIALECTS) {
      if (d.protocol === 'anthropic') {
        // ${baseUrl}/embeddings 是 OpenAI 风格路径，在 Anthropic 协议根下不存在。
        assert.equal(d.auxEndpointsSameOrigin, false, `${d.id} 不该允许同源嵌入`);
      }
      assert.ok(dialectById(d.id), `${d.id} 查不回来`);
    }
  });
});

describe('能力证据优先于模型名猜测', () => {
  const cfg: ThinkingConfigLike = {
    provider: 'claude', baseUrl: 'https://api.qnaigc.com', model: 'claude-opus-4-6',
    temperature: 0.7, thinkingMode: 'enabled', thinkingBudget: 4096,
  };

  test('探活证伪 thinking 后，一律不再发该字段（七牛「部分模型不支持思考」就是这一类）', () => {
    assert.deepEqual(thinkingRequestTuning(cfg).thinking, { type: 'enabled', budget_tokens: 4096 });
    const denied = { ...cfg, capsJson: { thinking: 'no' } };
    assert.equal(supportsThinkingConfig(denied), false);
    assert.equal(thinkingRequestTuning(denied).thinking, undefined);
    // 且温度回到运营原值——不能因为「配置里写着 enabled」就继续锁 1。
    assert.equal(thinkingRequestTuning(denied).temperature, 0.7);
  });

  test('caps 为 unknown / 缺省 / 脏数据 → 一律按「没探测过」放行，不凭空拦截既有配置', () => {
    for (const caps of [undefined, null, {}, { thinking: 'unknown' }, { thinking: 'yes' }, '不是对象', { 乱七八糟: 1 }]) {
      assert.equal(supportsThinkingConfig({ ...cfg, capsJson: caps }), true, `caps=${JSON.stringify(caps)}`);
    }
  });
});
