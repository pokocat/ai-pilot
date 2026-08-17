// agents:check-drift 的比较口径 —— 纯单元测试（不连库）。
//   cd server && node --import tsx --test test/agentDrift.test.ts
//
// 背景：运行时读的是 agent.publishedVersionId 指向的 agent_version 快照，而 deploy-prod.sh 只跑
// prisma db push、从不 seed —— 改代码并部署后行为字段不生效，且全程无报错。2026-08-16 的 poster
// 事故（生产停在 v2：旧通用提示词 + deliverableKey='海报设计'）就是这么漏过去的。
//
// 这些用例锁住三件容易被改坏的事：
//   ① 比较范围只含行为字段，计费/接入字段永远不进来（那些归运营后台，代码值不作数）；
//   ② general 的提示词永远算「运营托管」，不许有人把它变成真漂移把巡检刷红；
//   ③ deliverableKey / skillsConfig 的等价规则（空串≡null、后台键不参与比较）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BEHAVIOR_FIELDS, OPERATOR_MANAGED, OPERATOR_OWNED_SKILL_KEYS,
  compareBehavior, statusOf, promptStat, normDeliverableKey, behaviorSkills,
  parseIgnoreSpec, resolveIgnore, seedSnapshot,
  type BehaviorSnapshot,
} from '../scripts/checkAgentDrift.js';
import { AGENTS } from '../src/data/agents.js';

const snap = (o: Partial<BehaviorSnapshot> = {}): BehaviorSnapshot => ({
  systemPrompt: null, deliverableKey: null, skillsConfig: null, ...o,
});
const fieldOf = (fs: ReturnType<typeof compareBehavior>, f: string) => fs.find((x) => x.field === f)!;

describe('比较范围', () => {
  test('只比行为字段——计费/接入字段一个都不许进来', () => {
    assert.deepEqual([...BEHAVIOR_FIELDS], ['systemPrompt', 'deliverableKey', 'skillsConfig']);
    for (const f of ['billing', 'price', 'billingRatio', 'meterUnit', 'gift', 'providerMode', 'apiModel', 'apiKey', 'difyBaseUrl']) {
      assert.ok(!(BEHAVIOR_FIELDS as readonly string[]).includes(f), `${f} 归运营后台所有，不该参与漂移比较`);
    }
  });

  test('生产 poster 的 free/0/5x 与代码的 unlock/8/1x 不构成漂移', () => {
    // 计价差异体现在快照之外的字段上；行为字段一致 → 一致。
    const same = snap({ systemPrompt: '海报设计师人格' });
    assert.equal(statusOf(compareBehavior('poster', same, same)), 'ok');
  });
});

describe('提示词（md5 判等，长度只作展示）', () => {
  test('内容相同即一致，哪怕两侧长度口径不同', () => {
    const fs = compareBehavior('poster', snap({ systemPrompt: '你是绘章' }), snap({ systemPrompt: '你是绘章' }));
    assert.equal(fieldOf(fs, 'systemPrompt').same, true);
  });

  test('内容不同即漂移', () => {
    const fs = compareBehavior('poster', snap({ systemPrompt: '专用人格' }), snap({ systemPrompt: '通用商业顾问' }));
    assert.equal(fieldOf(fs, 'systemPrompt').same, false);
    assert.equal(statusOf(fs), 'drift');
  });

  test('字符数与字节数分开算——生产库 SQL_ASCII 下 psql length() 是字节数，别再混为一谈', () => {
    const s = promptStat('军师');
    assert.equal(s.chars, 2);
    assert.equal(s.bytes, 6);
    assert.equal(promptStat('').md5, promptStat(null).md5); // 空串与 null 同指纹
  });
});

describe('general 的运营托管例外', () => {
  const repo = snap({ systemPrompt: 'x'.repeat(17_232) }); // 仓库旧快照
  const db = snap({ systemPrompt: 'y'.repeat(19_486) });   // 线上运营调教版

  test('提示词差异被标为忽略，不计入漂移', () => {
    const fs = compareBehavior('general', repo, db);
    const p = fieldOf(fs, 'systemPrompt');
    assert.equal(p.same, false);
    assert.equal(p.ignored, true);
    assert.equal(statusOf(fs), 'ok'); // 忽略字段不把整行刷红
  });

  test('白名单是 per-agent 的：同样的差异放在 poster 上就是漂移', () => {
    assert.equal(statusOf(compareBehavior('poster', repo, db)), 'drift');
  });

  test('白名单只赦免提示词，general 的 deliverableKey 变了照样报', () => {
    const fs = compareBehavior('general', snap({ deliverableKey: '战略方案' }), snap({ deliverableKey: null }));
    assert.equal(fieldOf(fs, 'deliverableKey').ignored, false);
    assert.equal(statusOf(fs), 'drift');
    assert.deepEqual([...OPERATOR_MANAGED.general], ['systemPrompt']);
  });
});

describe('deliverableKey', () => {
  test('复刻 2026-08-16 poster 事故：代码 null vs 库内「海报设计」', () => {
    const fs = compareBehavior('poster', snap({ deliverableKey: null }), snap({ deliverableKey: '海报设计' }));
    const d = fieldOf(fs, 'deliverableKey');
    assert.equal(d.same, false);
    assert.equal(d.repo, '空');
    assert.equal(d.db, '「海报设计」');
  });

  test('空串与 null 等价——运行时按 !!deliverableKey 判真假', () => {
    assert.equal(normDeliverableKey(''), null);
    assert.equal(normDeliverableKey('  '), null);
    assert.equal(statusOf(compareBehavior('poster', snap({ deliverableKey: null }), snap({ deliverableKey: '' }))), 'ok');
  });
});

describe('skillsConfig', () => {
  test('后台键（enabled/tools）的差异不算漂移——那是运营在接入配置里填的', () => {
    const repo = snap({ skillsConfig: { deliverableMode: 'on-demand' } });
    const db = snap({ skillsConfig: { deliverableMode: 'on-demand', enabled: true, tools: ['web_search'] } });
    assert.equal(statusOf(compareBehavior('general', repo, db)), 'ok');
    assert.deepEqual(behaviorSkills(db.skillsConfig), { deliverableMode: 'on-demand' });
    assert.deepEqual([...OPERATOR_OWNED_SKILL_KEYS], ['enabled', 'tools', 'customTools']);
  });

  test('deliverableMode 被 normalizeSkills 冲掉 → 判漂移', () => {
    // 运营在后台存一次接入配置，admin.ts:normalizeSkills 就把对象重写成 { enabled, tools }。
    const repo = snap({ skillsConfig: { deliverableMode: 'on-demand' } });
    const db = snap({ skillsConfig: { enabled: false, tools: [] } });
    assert.equal(statusOf(compareBehavior('general', repo, db)), 'drift');
  });

  test('未配（undefined）与库内 null / {} 等价', () => {
    assert.deepEqual(behaviorSkills(null), {});
    assert.deepEqual(behaviorSkills(undefined), {});
    assert.equal(statusOf(compareBehavior('poster', snap(), snap({ skillsConfig: {} }))), 'ok');
  });

  test('键序不影响判等（稳定序列化）', () => {
    const a = snap({ skillsConfig: { deliverableMode: 'on-demand', foo: 1 } });
    const b = snap({ skillsConfig: { foo: 1, deliverableMode: 'on-demand' } });
    assert.equal(statusOf(compareBehavior('poster', a, b)), 'ok');
  });
});

describe('白名单可扩展（AGENT_DRIFT_IGNORE）', () => {
  test('解析 key:field，非法字段静默丢弃', () => {
    assert.deepEqual(parseIgnoreSpec('general:systemPrompt,poster:skillsConfig'), {
      general: ['systemPrompt'], poster: ['skillsConfig'],
    });
    assert.deepEqual(parseIgnoreSpec('poster:price,poster:deliverableKey'), { poster: ['deliverableKey'] });
    assert.deepEqual(parseIgnoreSpec(undefined), {});
    assert.deepEqual(parseIgnoreSpec('乱写'), {});
  });

  test('与内置白名单合并去重，不覆盖 general', () => {
    const merged = resolveIgnore('general:systemPrompt,poster:skillsConfig');
    assert.deepEqual(merged.general, ['systemPrompt']);
    assert.deepEqual(merged.poster, ['skillsConfig']);
    assert.deepEqual(resolveIgnore(undefined).general, ['systemPrompt']);
  });
});

describe('种子快照', () => {
  test('每个种子都能取出行为快照，且 skillsConfig 缺省归一为 null', () => {
    for (const a of AGENTS) {
      const s = seedSnapshot(a);
      assert.equal(typeof s.systemPrompt, 'string');
      assert.ok(s.deliverableKey === null || typeof s.deliverableKey === 'string');
      if (a.skillsConfig === undefined) assert.equal(s.skillsConfig, null);
    }
  });

  test('种子与自身比较恒为一致（比较函数无副作用/无隐式规范化偏差）', () => {
    for (const a of AGENTS) {
      assert.equal(statusOf(compareBehavior(a.key, seedSnapshot(a), seedSnapshot(a))), 'ok', a.key);
    }
  });
});
