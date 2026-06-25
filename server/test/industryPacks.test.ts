// 行业身份层（L1）：行业包解析 + 提示词注入。
//   cd server && node --import tsx --test test/industryPacks.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIndustryPack, GENERIC_INDUSTRY, INDUSTRY_PACKS } from '../src/data/industryPacks.js';
import { buildSystemParts, contextValues, type GenContext } from '../src/llm/schema.js';

function ctx(over: Partial<GenContext> = {}): GenContext {
  return {
    agentKey: 'general', agentName: '军师', systemPrompt: '你是军师。基准：{行业基准}', deliverableKey: null,
    profile: null, memories: [], benmingColor: 'gold', benchmark: '基准', userMessage: '增长怎么做',
    ...over,
  } as GenContext;
}

describe('resolveIndustryPack · 行业解析', () => {
  test('SURVEY 选项映射到对应行业包', () => {
    assert.equal(resolveIndustryPack('SaaS / 软件').key, 'saas');
    assert.equal(resolveIndustryPack('消费 / 零售').key, 'retail');
    assert.equal(resolveIndustryPack('制造').key, 'manufacturing');
    assert.equal(resolveIndustryPack('服务 / 咨询').key, 'proservices');
  });

  test('自由文本模糊匹配', () => {
    assert.equal(resolveIndustryPack('我做餐饮连锁').key, 'catering');
    assert.equal(resolveIndustryPack('跨境电商，主要在亚马逊').key, 'ecommerce');
    assert.equal(resolveIndustryPack('医美机构').key, 'beauty');
    assert.equal(resolveIndustryPack('在线教育培训').key, 'education');
    assert.equal(resolveIndustryPack('医疗器械').key, 'healthcare');
  });

  test('更具体的垂直行业优先于泛零售（顺序即优先级）', () => {
    assert.equal(resolveIndustryPack('连锁餐饮').key, 'catering');
    assert.equal(resolveIndustryPack('连锁门店零售').key, 'retail');
  });

  test('空 / 其他 / 未识别一律回退通用包', () => {
    assert.equal(resolveIndustryPack('其他').key, GENERIC_INDUSTRY.key);
    assert.equal(resolveIndustryPack('').key, GENERIC_INDUSTRY.key);
    assert.equal(resolveIndustryPack(undefined).key, GENERIC_INDUSTRY.key);
    assert.equal(resolveIndustryPack(null).key, GENERIC_INDUSTRY.key);
    assert.equal(resolveIndustryPack('qwerty-unknown-xyz').key, GENERIC_INDUSTRY.key);
  });

  test('每个包都有非空 persona / benchmark / levers', () => {
    for (const p of [...INDUSTRY_PACKS, GENERIC_INDUSTRY]) {
      assert.ok(p.persona.length > 0, `${p.key} persona`);
      assert.ok(p.benchmark.length > 0, `${p.key} benchmark`);
      assert.ok(p.levers.length >= 3, `${p.key} levers>=3`);
    }
  });

  test('不同行业的基准互不相同', () => {
    const saas = resolveIndustryPack('SaaS').benchmark;
    const catering = resolveIndustryPack('餐饮').benchmark;
    const generic = GENERIC_INDUSTRY.benchmark;
    assert.notEqual(saas, catering);
    assert.notEqual(catering, generic);
  });
});

describe('行业身份注入 · contextValues', () => {
  test('{行业基准} 因行业而异；{行业要点} 非空', () => {
    const catering = contextValues(ctx({ profile: { industry: '餐饮' } }));
    assert.match(catering['{行业基准}'], /翻台|食材/);
    assert.ok(catering['{行业要点}'].length > 0);
    assert.match(catering['{行业身份}'], /餐饮/);

    const saas = contextValues(ctx({ profile: { industry: 'SaaS / 软件' } }));
    assert.notEqual(saas['{行业基准}'], catering['{行业基准}']);
  });

  test('无行业时 {行业基准} 走通用兜底（不套用 SaaS 数值）', () => {
    const none = contextValues(ctx({ profile: null }));
    assert.equal(none['{行业基准}'], GENERIC_INDUSTRY.benchmark);
  });
});

describe('行业身份注入 · buildSystemParts stable 段', () => {
  test('识别到行业 → stable 段含「行业视角」行', () => {
    const { stable } = buildSystemParts('你是军师。', ctx({ profile: { industry: '餐饮连锁' } }), 'chat');
    assert.match(stable, /行业视角 · 餐饮/);
    assert.match(stable, /不得据此编造该客户的具体数据/);
  });

  test('未识别行业 / 无档案 → 不注入行业视角行（保持原行为）', () => {
    const none = buildSystemParts('你是军师。', ctx({ profile: null }), 'chat').stable;
    assert.doesNotMatch(none, /行业视角/);
    const other = buildSystemParts('你是军师。', ctx({ profile: { industry: '其他' } }), 'chat').stable;
    assert.doesNotMatch(other, /行业视角/);
  });

  test('行业行位于业务边界与语气行之后（稳定前缀顺序）', () => {
    const { stable } = buildSystemParts('你是军师。', ctx({ profile: { industry: 'SaaS' } }), 'chat');
    assert.ok(stable.indexOf('行业视角') > stable.indexOf('运行时业务边界'));
    assert.ok(stable.indexOf('行业视角') > stable.indexOf('本命色'));
  });
});
