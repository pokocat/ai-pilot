import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogueDirectoryAgents } from './council';

test('用户端对话目录动态接住后台新增顾问，不再依赖固定 key', () => {
  const agents = [
    { key: 'general', type: 'general' },
    { key: 'strat', type: 'advisory' },
    { key: 'brand_new_advisor', type: 'advisory' },
    { key: 'custom_legal', type: 'custom' },
    { key: 'poster', type: 'creative' },
  ];

  assert.deepEqual(
    dialogueDirectoryAgents(agents).map((agent) => agent.key),
    ['brand_new_advisor', 'custom_legal'],
  );
});
