import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { cleanBusiness, closeApp, login, seedBaseline } from './helpers.js';
import {
  deliveryPlanIdFor,
  prefilterDeliveryComplexity,
  stageInstruction,
} from '../src/services/deliveryComplexity.js';
import { enqueueDurableGeneration, enqueueNextDeliveryStage } from '../src/services/generationRequest.js';
import { tickGenerationWorker } from '../src/services/generationWorker.js';
import type { Deliverable } from '../../shared/contracts';

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
});
after(async () => closeApp());

async function user(phone: string) {
  const id = await login(phone, '复杂交付测试');
  return prisma.user.findUniqueOrThrow({ where: { id }, select: { id: true, tenantId: true } });
}

describe('复杂度预筛（普通聊天零额外模型）', () => {
  test('普通闲聊与单一明确任务不进入分类', () => {
    assert.deepEqual(prefilterDeliveryComplexity('今天团队开会我应该怎么说'), { kind: 'none' });
    assert.deepEqual(prefilterDeliveryComplexity('帮我出一份下个月单店抖音投流方案'), { kind: 'none' });
  });

  test('疑似复杂进入结构化分类，明确 3+ 交付模块可直接判复杂', () => {
    assert.equal(prefilterDeliveryComplexity('帮我做全国加盟扩张方案').kind, 'candidate');
    const direct = prefilterDeliveryComplexity('帮我做明年全国加盟扩张全案，包含品牌、获客、招商、组织、财务和90天启动计划');
    assert.equal(direct.kind, 'direct');
    if (direct.kind !== 'direct') return;
    assert.ok(direct.assessment.score >= 4);
    assert.equal(direct.stages[0].key, 'overview');
    assert.ok(direct.stages.length >= 3);
  });

  test('方案链 id 对同一用户请求稳定，阶段提示明确禁止只交目录和自动连跑', () => {
    assert.equal(deliveryPlanIdFor('u1', 'req1'), deliveryPlanIdFor('u1', 'req1'));
    assert.notEqual(deliveryPlanIdFor('u1', 'req1'), deliveryPlanIdFor('u1', 'req2'));
    const line = stageInstruction(
      { key: 'overview', number: 1, title: '总纲版', objective: '总览' },
      [{ key: 'overview', number: 1, title: '总纲版', objective: '总览' }, { key: 'finance', number: 2, title: '财务模型', objective: '测算' }],
    );
    assert.match(line, /可独立使用/);
    assert.match(line, /不能只交目录/);
    assert.match(line, /不要擅自连跑/);
  });
});

describe('GenerationJob 冻结路由与阶段幂等', () => {
  test('普通聊天不产生 classification attempt；明确否定报告不会被复杂词翻回报告', async () => {
    const u = await user('13800008101');
    const normal = await enqueueDurableGeneration(u, {
      text: '今天团队开会我应该怎么说', clientRequestId: 'normal-chat-1', agentKey: 'general',
    });
    assert.equal(normal.job.kind, 'chat');
    assert.equal(normal.job.classificationStatus, 'not_required');
    assert.equal(await prisma.generationAttempt.count({ where: { jobId: normal.job.id, kind: 'classification' } }), 0);
    await tickGenerationWorker();

    const denied = await enqueueDurableGeneration(u, {
      text: '先别出报告，我们先聊全国加盟扩张方案', clientRequestId: 'denied-report-1', sessionId: normal.session.id,
    });
    assert.equal(denied.job.requestedOutput, 'chat');
    assert.equal(denied.job.kind, 'chat');
    assert.equal(denied.job.classificationStatus, 'not_required');
  });

  test('疑似复杂分类失败默认 single，但 attempt 的耗时/usage/原因仍落库且不阻塞建单', async () => {
    const u = await user('13800008102');
    const created = await enqueueDurableGeneration(u, {
      text: '帮我做全国加盟扩张方案', clientRequestId: 'candidate-1', agentKey: 'general',
    });
    assert.equal(created.job.requestedOutput, 'report');
    assert.equal(created.job.deliveryMode, 'single');
    assert.equal(created.job.classificationStatus, 'failed');
    const attempt = await prisma.generationAttempt.findFirstOrThrow({ where: { jobId: created.job.id, kind: 'classification' } });
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.terminationReason, 'classification_failed');
    assert.ok(attempt.completedAt);
    assert.ok(attempt.usageJson);
    await tickGenerationWorker();
    const done = await prisma.generationJob.findUniqueOrThrow({ where: { id: created.job.id } });
    assert.equal(done.status, 'completed');
  });

  test('复杂报告先交带阶段链的总纲；继续按钮重复点击只建一个子任务并单独结算', async () => {
    const u = await user('13800008103');
    const root = await enqueueDurableGeneration(u, {
      text: '帮我做明年全国加盟扩张全案，包含品牌、获客、招商、组织、财务和90天启动计划',
      clientRequestId: 'direct-staged-1', agentKey: 'general',
    });
    assert.equal(root.job.requestedOutput, 'report');
    assert.equal(root.job.deliveryMode, 'staged');
    assert.equal(root.job.stageKey, 'overview');
    assert.equal(root.job.stageNumber, 1);
    await tickGenerationWorker();
    const rootDone = await prisma.generationJob.findUniqueOrThrow({ where: { id: root.job.id } });
    assert.equal(rootDone.status, 'completed');
    const deliverable = rootDone.replyJson as unknown as Deliverable;
    assert.equal(deliverable.delivery?.generationId, root.job.id);
    assert.equal(deliverable.delivery?.currentStageNumber, 1);
    assert.ok(deliverable.delivery?.nextStage);

    const child1 = await enqueueNextDeliveryStage(u, root.job.id);
    const child2 = await enqueueNextDeliveryStage(u, root.job.id);
    assert.equal(child1.job.id, child2.job.id, '重复点击必须复用同一个阶段任务');
    assert.equal(child1.job.parentGenerationId, root.job.id);
    assert.equal(child1.job.stageNumber, 2);
    assert.equal(await prisma.generationJob.count({ where: { deliveryPlanId: root.job.deliveryPlanId, stageNumber: 2 } }), 1);
    await tickGenerationWorker();
    const childDone = await prisma.generationJob.findUniqueOrThrow({ where: { id: child1.job.id } });
    assert.equal(childDone.status, 'completed');
    assert.ok(['settled', 'refunded'].includes(childDone.settlementStatus), '子阶段必须独立封账；mock 无真实用量应退款');
    const childReport = childDone.replyJson as unknown as Deliverable;
    assert.equal(childReport.delivery?.currentStageNumber, 2);
    assert.equal(childReport.delivery?.generationId, childDone.id);
  });
});
