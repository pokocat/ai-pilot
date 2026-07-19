// buildSystemParts：档案访谈轮要追加「访谈覆盖指令」压制固定 deflection;普通轮不追加。
//   cd server && node --import tsx --test test/systemParts.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemParts, type GenContext } from '../src/llm/schema.js';

function ctx(over: Partial<GenContext> = {}): GenContext {
  return {
    agentKey: 'general', agentName: '军师', systemPrompt: '', deliverableKey: null,
    profile: null, memories: [], benmingColor: 'gold', benchmark: '基准', userMessage: '请进入个人档案访谈模式',
    ...over,
  } as GenContext;
}

describe('buildSystemParts · 档案访谈覆盖', () => {
  test('普通轮:含业务边界固定话术,不含访谈覆盖', () => {
    const { stable } = buildSystemParts('你是军师。', ctx({ briefInterview: false }), 'chat');
    assert.match(stable, /运行时业务边界/);
    assert.match(stable, /固定回复/);
    assert.doesNotMatch(stable, /本轮模式覆盖：档案访谈/);
  });

  test('访谈轮:末尾追加覆盖指令,明确不能用固定回复', () => {
    const { stable } = buildSystemParts('你是军师。', ctx({ briefInterview: true }), 'chat');
    assert.match(stable, /本轮模式覆盖：档案访谈/);
    assert.match(stable, /绝不能用上面那句固定回复/);
    assert.match(stable, /问 3 个简单具体的问题/);
    // 覆盖指令必须在守则之后(最后出现,优先级最高)
    assert.ok(stable.indexOf('本轮模式覆盖') > stable.indexOf('运行时业务边界'));
  });
});

describe('buildSystemParts · 本命色回归纯品牌色（M3 PR-14）', () => {
  test('不再注入本命色语气提示（语气由角色系统/modeLine 驱动），占位符仍可用', () => {
    const gold = buildSystemParts('你是军师。', ctx({ benmingColor: 'gold' }), 'chat').stable;
    const red = buildSystemParts('你是军师。', ctx({ benmingColor: 'red' }), 'chat').stable;
    assert.doesNotMatch(gold, /表达风格参考 · 本命色/);
    assert.equal(gold, red, '本命色不再影响提示词');
    // {本命色} 占位符路径保留（老提示词若引用仍可填充）
    const withPlaceholder = buildSystemParts('你的客户本命色是{本命色}。', ctx({ benmingColor: 'red' }), 'chat').stable;
    assert.match(withPlaceholder, /red/);
  });
});

describe('buildSystemParts · 回忆口径守卫', () => {
  test('禁止把内部上下文机制推给客户，并要求先复述已知事实', () => {
    const stable = buildSystemParts('你是军师。', ctx({ userMessage: '你还记得我之前说的吗？' }), 'chat').stable;
    assert.match(stable, /先综合【同一会话较早内容回顾】/);
    assert.match(stable, /先说出已经记得的部分/);
    assert.match(stable, /不得声称“每次对话的上下文不会自动带过来”/);
  });
});
