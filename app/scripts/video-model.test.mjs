import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = require('../weapp-native/packages/video/model.js');

const readyAvatar = { imageStatus: 'ready', voiceStatus: 'ready' };

test('快出片切换出镜角色时积分增量与整单报价一致', () => {
  const segments = [
    { no: 1, text: '一二三四五六七八', role: model.ROLE.BROLL },
    { no: 2, text: '固定结尾', role: model.ROLE.TAIL, durationSec: 8 },
  ];
  const before = model.estimateCredits(segments).total;
  const result = model.toggleRole(segments, 1);
  const after = model.estimateCredits(result.segments).total;
  assert.equal(result.error, null);
  assert.equal(result.delta, after - before);
  assert.equal(result.segments[0].role, model.ROLE.AVATAR);
});

test('快出片固定尾段拒绝角色切换', () => {
  const segments = [{ no: 14, text: '固定结尾', role: model.ROLE.TAIL, durationSec: 8 }];
  const result = model.toggleRole(segments, 14);
  assert.match(result.error, /固定片段/);
  assert.deepEqual(result.segments, segments);
});

test('快出片 preflight 返回稳定业务错误码', () => {
  const project = {
    segments: [
      { no: 1, text: '', role: model.ROLE.BROLL },
      { no: 2, text: '这是一段需要数字分身出镜的话', role: model.ROLE.AVATAR },
    ],
  };
  assert.deepEqual(
    model.preflight(project, null).problems.map((item) => item.code),
    ['EMPTY_TEXT', 'CLIP_AVATAR_NOT_READY', 'CLIP_VOICE_NOT_READY'],
  );
  assert.equal(model.preflight({ segments: [{ no: 1, text: '正常', role: model.ROLE.BROLL }] }, readyAvatar).ok, true);
});

test('快出片进度阶段映射保持已完成、进行中、等待中顺序', () => {
  const rows = model.stageRows('broll', 42);
  assert.deepEqual(rows.map((item) => item.state), ['done', 'done', 'busy', 'wait']);
  assert.equal(rows[2].text, '42%');
});

test('试听后未改字保留真实时长，继续改字则清零', () => {
  const segments = [{ no: 1, text: '原句', role: model.ROLE.AVATAR, actualDurationSec: 9 }];
  const unchanged = model.commitSegmentText(segments, 1, '原句', '原句');
  assert.equal(unchanged[0].actualDurationSec, 9);
  const changed = model.commitSegmentText(segments, 1, '改过的句子', '原句');
  assert.equal(changed[0].actualDurationSec, 0);
});
