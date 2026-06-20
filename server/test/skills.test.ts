// 可插拔技能注册表单元测试(纯函数，不连库)。
//   cd server && node --import tsx --test test/skills.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeSkillMeta, resolveOutputSkills, getOutputSkill, resolveTools, builtinToolNames,
} from '../src/llm/tools/registry.js';

describe('可插拔技能注册表', () => {
  test('nativeSkillMeta 含 tool 与 output 两类；render_report=output', () => {
    const byKey = Object.fromEntries(nativeSkillMeta().map((m) => [m.key, m]));
    assert.equal(byKey['search_knowledge']?.kind, 'tool');
    assert.equal(byKey['recall_memory']?.kind, 'tool');
    assert.equal(byKey['render_report']?.kind, 'output');
    assert.ok(nativeSkillMeta().every((m) => m.builtin), 'native 技能 builtin=true');
  });

  test('output 技能不混入「喂给模型的工具」', () => {
    assert.ok(!builtinToolNames().includes('render_report'), 'render_report 不是模型工具');
    const tools = resolveTools(['search_knowledge', 'render_report']);
    assert.deepEqual(tools.map((t) => t.name), ['search_knowledge']);
  });

  test('resolveOutputSkills 只挑 output 技能、忽略工具名/未知名、去重保序', () => {
    const out = resolveOutputSkills(['render_report', 'search_knowledge', 'nope', 'render_report']);
    assert.deepEqual(out.map((s) => s.key), ['render_report']);
  });

  test('getOutputSkill 命中/未命中', () => {
    assert.equal(getOutputSkill('render_report')?.name, '网页版报告');
    assert.equal(getOutputSkill('nope'), undefined);
  });
});
