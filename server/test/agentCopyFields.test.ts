import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prisma } from '../src/db.js';
import { api, cleanBusiness, closeApp, getApp, seedBaseline } from './helpers.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

before(async () => {
  await getApp();
  await cleanBusiness();
  await prisma.agentVersion.deleteMany();
  await prisma.agent.deleteMany();
  await seedBaseline();
});

after(async () => { await closeApp(); });

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('memText/learnText 可窄字段保存、审计并随版本发布，不改提示词与计价', async () => {
  const first = await api('POST', '/api/admin/agents/general/publish', { body: { label: 'copy baseline' } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const beforeRow = await prisma.agent.findUniqueOrThrow({ where: { key: 'general' } });
  const promptHash = sha256(beforeRow.systemPrompt);

  const patched = await api('PATCH', '/api/admin/agents/general', {
    body: { memText: '你的<b>企业情况</b>我记着', learnText: '记下了' },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.draftDirty, true);

  const draft = await prisma.agent.findUniqueOrThrow({ where: { key: 'general' } });
  assert.equal(draft.memText, '你的<b>企业情况</b>我记着');
  assert.equal(draft.learnText, '记下了');
  assert.equal(sha256(draft.systemPrompt), promptHash);
  assert.equal(draft.gift, beforeRow.gift);
  assert.equal(draft.billing, beforeRow.billing);
  assert.equal(draft.price, beforeRow.price);
  assert.equal(draft.enabled, beforeRow.enabled);

  const detail = await api('GET', '/api/admin/agents/general');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.memText, draft.memText);
  assert.equal(detail.body.learnText, draft.learnText);

  const audit = await prisma.auditLog.findFirst({ where: { action: 'admin.agent.update' }, orderBy: { createdAt: 'desc' } });
  assert.equal((audit?.payloadJson as Record<string, unknown>)?.memTextChanged, true);
  assert.equal((audit?.payloadJson as Record<string, unknown>)?.learnTextChanged, true);
  assert.equal((audit?.payloadJson as Record<string, unknown>)?.systemPromptChanged, false);

  const published = await api('POST', '/api/admin/agents/general/publish', { body: { label: 'copy only' } });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.changed, true);
  const publicAgent = await api('GET', '/api/agents/general', { adminToken: false });
  assert.equal(publicAgent.status, 200);
  assert.equal(publicAgent.body.memText, draft.memText);
  assert.equal(publicAgent.body.learnText, draft.learnText);
  const version = await prisma.agentVersion.findUniqueOrThrow({ where: { id: published.body.versionId } });
  assert.equal(sha256(version.systemPrompt), promptHash);
});
