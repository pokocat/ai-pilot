// PR-0a 禁用词检查（V6.0 §17）：扫描命中 / 审计落库 / 生成链路端到端可观测（不拦截产出）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { scanBannedWords, auditBannedWords, BANNED_WORDS } from '../src/services/bannedWords.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

test('scanBannedWords：命中返回去重词表，未命中返回空', () => {
  assert.deepEqual(scanBannedWords('我们要为业务赋能，找到关键抓手，理解底层逻辑。'), ['赋能', '抓手', '底层逻辑']);
  assert.deepEqual(scanBannedWords('先抓主要矛盾，集中兵力打歼灭战。'), []);
  assert.deepEqual(scanBannedWords(''), []);
  // 全量词表逐一可命中
  for (const w of BANNED_WORDS) assert.deepEqual(scanBannedWords(`……${w}……`), [w]);
});

test('auditBannedWords：命中写 ai.banned_words 审计（含词表与会话），未命中不写', async () => {
  const token = await login(uniquePhone(), '禁词用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });

  const misses = await auditBannedWords({ tenantId: user.tenantId, userId: user.id, agentKey: 'general', kind: 'chat', text: '正常输出' });
  assert.equal(misses.length, 0);

  const hits = await auditBannedWords({
    tenantId: user.tenantId, userId: user.id, sessionId: 'sess-1', agentKey: 'strat', kind: 'deliverable',
    text: '这个颗粒度不够，需要一次范式转移。',
  });
  assert.deepEqual(hits, ['颗粒度', '范式转移']);

  const rows = await prisma.auditLog.findMany({ where: { action: 'ai.banned_words' }, orderBy: { createdAt: 'desc' } });
  assert.equal(rows.length, 1, '只有命中才记录');
  const payload = rows[0].payloadJson as { agentKey: string; kind: string; sessionId: string; words: string[] };
  assert.equal(payload.agentKey, 'strat');
  assert.equal(payload.kind, 'deliverable');
  assert.equal(payload.sessionId, 'sess-1');
  assert.deepEqual(payload.words, ['颗粒度', '范式转移']);
});
