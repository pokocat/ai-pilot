import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = require('../weapp-native/packages/video/model.js');

const readyAvatar = { imageStatus: 'ready', voiceStatus: 'ready' };

test('微信临时素材名不会进入配画面和预览 UI', () => {
  assert.equal(model.assetDisplayLabel('tmp_fc984c89bb3436e0ed4f696c98b19a63963.mp4', 'video'), '我的视频素材');
  assert.equal(model.assetDisplayLabel('wxfile://tmp_aabbcc', 'image'), '我的图片素材');
  assert.equal(model.assetDisplayLabel('店铺门头', 'video'), '店铺门头');
});

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
    ['EMPTY_TEXT', 'CLIP_AVATAR_NOT_READY', 'CLIP_VOICE_NOT_READY', 'CLIP_ASSET_NOT_ALLOWED'],
  );
  assert.equal(model.preflight({ segments: [{ no: 1, text: '正常', role: model.ROLE.BROLL, assetId: 'ca_1' }] }, readyAvatar).ok, true);
  assert.deepEqual(
    model.preflight({ segments: [{ no: 1, text: '正常', role: model.ROLE.BROLL, assetId: 'ca_1' }] }, null).problems.map((item) => item.code),
    ['CLIP_VOICE_NOT_READY'],
  );
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

test('连续配画面句默认每三句合成一个镜头，文案仍保持逐句', () => {
  const segments = [
    { no: 1, text: '开场', role: 'avatar' },
    { no: 2, text: '门头', role: 'broll' },
    { no: 3, text: '手艺', role: 'broll' },
    { no: 4, text: '顾客', role: 'broll' },
    { no: 5, text: '收束', role: 'broll' },
    { no: 6, text: '结尾', role: 'tail', durationSec: 3 },
  ];
  const shots = model.defaultShots(segments);
  assert.deepEqual(shots.map((shot) => [shot.startNo, shot.endNo, shot.role]), [
    [1, 1, 'avatar'], [2, 4, 'broll'], [5, 5, 'broll'], [6, 6, 'tail'],
  ]);
  assert.equal(model.materializeShots(segments, shots)[1].text, '门头手艺顾客');
  assert.equal(segments.length, 6);
});

test('圈选连续多句会切开原镜头并生成一个共享画面段', () => {
  const segments = Array.from({ length: 6 }, (_, index) => ({ no: index + 1, text: `第${index + 1}句。`, role: 'broll' }));
  const result = model.mergeShotRange(segments, model.defaultShots(segments), 2, 5);
  assert.equal(result.error, null);
  assert.deepEqual(result.shots.map((shot) => [shot.startNo, shot.endNo]), [[1, 1], [2, 5], [6, 6]]);
  assert.equal(result.shots[1].assetId, null);
  assert.deepEqual(model.splitShot(segments, result.shots, result.shots[1].id).map((shot) => [shot.startNo, shot.endNo]),
    [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]]);
});

test('调整当前画面段时，取消勾选的句子单独成段且不丢原文覆盖', () => {
  const segments = Array.from({ length: 5 }, (_, index) => ({ no: index + 1, text: `第${index + 1}句。`, role: 'broll' }));
  const shots = model.defaultShots(segments);
  const result = model.regroupShotSelection(segments, shots, shots[0].id, [2, 3]);
  assert.equal(result.error, null);
  assert.deepEqual(result.shots.map((shot) => [shot.startNo, shot.endNo]), [[1, 1], [2, 3], [4, 5]]);
  assert.deepEqual(model.materializeShots(segments, result.shots).flatMap((shot) => shot.sourceNos), [1, 2, 3, 4, 5]);
});

test('当前画面段不允许保留非连续勾选，全部取消则拆成单句', () => {
  const segments = Array.from({ length: 3 }, (_, index) => ({ no: index + 1, text: `第${index + 1}句。`, role: 'broll' }));
  const shots = model.defaultShots(segments);
  const invalid = model.regroupShotSelection(segments, shots, shots[0].id, [1, 3]);
  assert.match(invalid.error, /需要连续/);
  assert.deepEqual(invalid.shots, shots);
  const split = model.regroupShotSelection(segments, shots, shots[0].id, []);
  assert.equal(split.error, null);
  assert.deepEqual(split.shots.map((shot) => [shot.startNo, shot.endNo]), [[1, 1], [2, 2], [3, 3]]);
});

test('相邻画面段可直接合并，素材不同则清空后重新选择', () => {
  const segments = Array.from({ length: 4 }, (_, index) => ({ no: index + 1, text: `第${index + 1}句。`, role: 'broll' }));
  const shots = [
    { id: 'shot_1_2', startNo: 1, endNo: 2, role: 'broll', assetId: 'a', assetLabel: '门头' },
    { id: 'shot_3_4', startNo: 3, endNo: 4, role: 'broll', assetId: 'b', assetLabel: '后厨' },
  ];
  const result = model.mergeAdjacentShots(segments, shots, shots[0].id);
  assert.equal(result.error, null);
  assert.deepEqual(result.shots.map((shot) => [shot.startNo, shot.endNo]), [[1, 4]]);
  assert.equal(result.shots[0].assetId, null);
  assert.deepEqual(model.materializeShots(segments, result.shots)[0].sourceNos, [1, 2, 3, 4]);
});

test('多句镜头按镜头计画面段数，并按合计时长限制分身出镜', () => {
  const segments = [
    { no: 1, text: '甲'.repeat(70), role: 'broll' },
    { no: 2, text: '乙'.repeat(70), role: 'broll' },
  ];
  const shots = model.defaultShots(segments);
  assert.equal(model.estimateCredits(segments, shots).summary.brollCount, 1);
  const toggled = model.toggleShotRole(segments, shots, shots[0].id);
  assert.match(toggled.error, /超过单次分身出镜上限/);
});
