import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { modelGatewayField, modelSupportsThinking, auxReuseBlock, probeName, dialectLine, probeLine, auxMissingReason } from './modelGateway';

describe('model gateway field', () => {
  test('Claude 自主定义必须显示 baseUrl，并提示 Anthropic 协议', () => {
    const field = modelGatewayField('claude');
    assert.equal(field.visible, true);
    assert.match(field.label, /Anthropic/);
    assert.match(field.note || '', /\/v1\/messages/);
  });

  test('OpenAI 兼容模式显示 /v1 提示，mock 不显示', () => {
    assert.match(modelGatewayField('openai').label, /OpenAI/);
    assert.equal(modelGatewayField('mock').visible, false);
  });

  test('Anthropic 原生与 OpenAI 兼容 Claude 别名都显示 Thinking 配置', () => {
    assert.equal(modelSupportsThinking('claude', 'claude-opus-4-6'), true);
    assert.equal(modelSupportsThinking('openai', 'dj-claude-4.6-opus'), true);
    assert.equal(modelSupportsThinking('openai', 'deepseek-chat'), false);
  });
});

// 嵌入 / 重排的「留空＝复用对话模型」闸门（2026-08-07 修 D5）。
// 两条否决理由互相独立，缺任一条都会漏掉真实的必错组合。
describe('检索增强能否复用对话端点', () => {
  test('协议不符：Anthropic 端点拼出的 /embeddings 不存在 → 禁止留空', () => {
    const r = auxReuseBlock('claude', 'https://api.qnaigc.com');
    assert.equal(r.blocked, true);
    assert.match(r.reason, /Anthropic/);
  });

  test('Anthropic 官方直连（baseUrl 留空）同样禁止 —— 判据是协议，不是有没有填地址', () => {
    assert.equal(auxReuseBlock('claude', '').blocked, true);
  });

  test('厂商没有这个能力：七牛 OpenAI 兼容入口协议合法，但仍必须禁止', () => {
    // 这条正是「只判协议」会漏掉的：api.qnaigc.com/v1 是标准 OpenAI 兼容，
    // /embeddings 路径完全合法，可七牛压根不提供嵌入模型，留空 100% 失败。
    const r = auxReuseBlock('openai', 'https://api.qnaigc.com/v1');
    assert.equal(r.blocked, true);
    assert.match(r.reason, /七牛/);
  });

  test('子域名也算七牛', () => {
    assert.equal(auxReuseBlock('openai', 'https://ap-southeast.api.qnaigc.com/v1').blocked, true);
  });

  test('提供嵌入的 OpenAI 兼容厂商不受影响（不误伤既有配置）', () => {
    assert.equal(auxReuseBlock('openai', 'https://api.siliconflow.cn/v1').blocked, false);
    assert.equal(auxReuseBlock('openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1').blocked, false);
  });

  test('域名相似但不同的站点不得被误判为七牛', () => {
    assert.equal(auxReuseBlock('openai', 'https://api.qnaigc.com.evil.test/v1').blocked, false);
    assert.equal(auxReuseBlock('openai', 'https://notqnaigc.com/v1').blocked, false);
  });

  test('baseUrl 非法时不阻断（只按协议判，不把解析失败当证据）', () => {
    assert.equal(auxReuseBlock('openai', '不是个 URL').blocked, false);
  });
});

// 后台「模型配置」页新增的展示口径（2026-08-07 二三期）。
// 这些逻辑本来长在组件闭包里、只靠 tsc 和 build 兜底；提成纯函数是为了让它们真的被测到——
// 该页在管理员鉴权之后，没有凭证就走不了实机，那就至少别让判断逻辑处于零覆盖。
describe('端点行的方言展示', () => {
  const label = (id?: string | null) => ({ anthropic_gateway: 'Anthropic 兼容网关（七牛等）' }[id ?? ''] || id || '未知');

  test('已固化 → 明说「已固化」（运营选定的才是稳定事实）', () => {
    const line = dialectLine({ provider: 'claude', dialect: 'anthropic_gateway', resolvedDialect: 'anthropic_gateway' }, label);
    assert.match(line, /已固化/);
    assert.doesNotMatch(line, /推断中/);
  });

  test('还在推断 → 必须标出来并指路，不能让运营以为自己选过', () => {
    const line = dialectLine({ provider: 'claude', dialect: null, resolvedDialect: 'anthropic_gateway' }, label);
    assert.match(line, /推断中/);
    assert.match(line, /固化方言/);
  });

  test('mock 端点不显示方言（它不外呼，方言无意义）', () => {
    assert.equal(dialectLine({ provider: 'mock', resolvedDialect: 'mock' }, label), '');
  });

  test('后端没回 resolvedDialect（老版本 API）→ 空串，不显示「未知」这种噪音', () => {
    assert.equal(dialectLine({ provider: 'claude', dialect: null }, label), '');
  });
});

describe('端点行的检测态展示', () => {
  const fmt = () => '08-07 10:00';

  test('本次检测结果优先于库里的历史值', () => {
    const line = probeLine({ lastProbeAt: '2026-08-01T00:00:00Z', lastProbeOk: true }, { results: [{ ok: true }, { ok: false }] }, fmt);
    assert.match(line, /1 项未过/);
    assert.doesNotMatch(line, /上次检测/);
  });

  test('本次全过 → 说「全部通过」', () => {
    assert.match(probeLine({}, { results: [{ ok: true }] }, fmt), /全部通过/);
  });

  test('只有历史值 → 显示时间与结论', () => {
    const line = probeLine({ lastProbeAt: '2026-08-07T10:00:00Z', lastProbeOk: false }, undefined, fmt);
    assert.match(line, /上次检测/);
    assert.match(line, /未过/);
  });

  test('从没测过要如实说「从未检测」，不能显示成通过', () => {
    const line = probeLine({ lastProbeAt: null, lastProbeOk: null }, undefined, fmt);
    assert.match(line, /从未检测/);
    assert.doesNotMatch(line, /通过/);
  });
});

describe('嵌入/重排的保存前拦截', () => {
  const aux = {
    embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
    rerankEnabled: false, rerankBaseUrl: '', rerankApiKey: '',
  };
  const saved = { hasEmbeddingKey: false, hasRerankKey: false };

  test('闸门没命中 → 一律放行（「留空复用」本来就合法的场景不该被拦）', () => {
    assert.equal(auxMissingReason(false, { ...aux, embeddingEnabled: true }, saved), '');
  });

  test('闸门命中 + 开了嵌入却没填网关 → 拦，并说清楚缺什么', () => {
    assert.match(auxMissingReason(true, { ...aux, embeddingEnabled: true }, saved), /接入地址/);
  });

  test('网关填了但 Key 既没存过也没填 → 仍要拦', () => {
    const r = auxMissingReason(true, { ...aux, embeddingEnabled: true, embeddingBaseUrl: 'https://x/v1' }, saved);
    assert.match(r, /API Key/);
  });

  test('Key 已存在库里（留空=不改）→ 放行', () => {
    const r = auxMissingReason(true, { ...aux, embeddingEnabled: true, embeddingBaseUrl: 'https://x/v1' }, { ...saved, hasEmbeddingKey: true });
    assert.equal(r, '');
  });

  test('两项都关着 → 闸门命中也不拦（关掉的东西不该有意见）', () => {
    assert.equal(auxMissingReason(true, aux, saved), '');
  });

  test('重排单独开启也要被覆盖到（别只判嵌入）', () => {
    assert.match(auxMissingReason(true, { ...aux, rerankEnabled: true }, saved), /重排/);
  });
});

describe('检测项名称', () => {
  test('八项都有中文名（不把英文枚举甩给运营）', () => {
    for (const k of ['connectivity', 'model_scope', 'thinking', 'tools', 'streaming', 'long_output', 'embedding', 'rerank']) {
      assert.notEqual(probeName(k), k, `${k} 没有中文名`);
    }
  });
  test('未知 kind 原样返回，不抛也不显示 undefined', () => {
    assert.equal(probeName('未来新增项'), '未来新增项');
  });
});
