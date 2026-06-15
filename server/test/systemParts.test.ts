// buildSystemParts：档案访谈轮要追加「访谈覆盖指令」压制固定 deflection;普通轮不追加。
//   cd server && node --import tsx --test test/systemParts.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemParts, type GenContext } from '../src/llm/schema.js';

function ctx(over: Partial<GenContext> = {}): GenContext {
  return {
    agentKey: 'general', agentName: '军师', systemPrompt: '', deliverableKey: null,
    profile: null, memories: [], benmingColor: 'gold', benchmark: '基准', userMessage: '请进入军师档案访谈模式',
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
