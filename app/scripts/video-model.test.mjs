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

/* ── 整段改写 ────────────────────────────────────────────────────────
   逐句编辑适合微调；用户拿着写好的稿子过来时要能整篇粘贴。
   ⚠️ 已配画面绑在 shots 层，segments.assetId 恒为 null（镜头层引入前的遗留字段）。
   这批用例照真实数据形状写：素材放在 shots 上。 */

const bodyOf = (...texts) => texts.map((text, index) => ({
  no: index + 1, text, role: index === 0 ? model.ROLE.AVATAR : model.ROLE.BROLL,
}));

test('整段导出只出正文，固定尾段不进编辑区', () => {
  const segments = bodyOf('第一句', '第二句').concat([{ no: 3, text: '结尾：集体发声', role: model.ROLE.TAIL, durationSec: 22 }]);
  assert.equal(model.scriptToText(segments), '第一句\n第二句');
});

test('整段粘贴按行切分，空行忽略，前后空格去掉', () => {
  const { segments } = model.applyBulkScript(bodyOf('旧'), null, '  甲  \n\n乙\n \n丙');
  assert.deepEqual(segments.map((s) => s.text), ['甲', '乙', '丙']);
  assert.deepEqual(segments.map((s) => s.no), [1, 2, 3]);
});

test('固定尾段永远保留并重新编号，不会被粘贴内容顶掉', () => {
  const before = bodyOf('甲').concat([{ no: 2, text: '结尾', role: model.ROLE.TAIL, durationSec: 22 }]);
  const { segments } = model.applyBulkScript(before, null, '一\n二\n三');
  const tail = segments.at(-1);
  assert.equal(tail.role, model.ROLE.TAIL);
  assert.equal(tail.no, 4);
  assert.equal(tail.durationSec, 22);
  assert.equal(segments.filter((s) => s.role === model.ROLE.TAIL).length, 1);
});

test('角色按位置继承；新增的句子默认配画面，不偷偷加钱', () => {
  const { segments } = model.applyBulkScript(bodyOf('甲', '乙'), null, '甲改\n乙改\n丙新增');
  assert.deepEqual(segments.map((s) => s.role), [model.ROLE.AVATAR, model.ROLE.BROLL, model.ROLE.BROLL]);
});

test('丢画面按 shots 计数——数 segments 会恒得 0，安全闸永远不触发', () => {
  const before = bodyOf('甲', '乙', '丙');
  const shots = [
    { id: 's1', startNo: 1, endNo: 1, role: model.ROLE.AVATAR, assetId: null },
    { id: 's2', startNo: 2, endNo: 3, role: model.ROLE.BROLL, assetId: 'ca_1', assetLabel: '门头' },
  ];
  const { stats } = model.applyBulkScript(before, shots, '甲\n乙改了\n丙');
  assert.equal(stats.droppedAssets, 1, '第 2 句被改，覆盖它的镜头素材失效');
});

test('只改没配画面的那句，已配的画面要保住', () => {
  const before = bodyOf('甲', '乙', '丙');
  const shots = [
    { id: 's1', startNo: 1, endNo: 1, role: model.ROLE.AVATAR, assetId: null },
    { id: 's2', startNo: 2, endNo: 3, role: model.ROLE.BROLL, assetId: 'ca_1', assetLabel: '门头' },
  ];
  const { shots: next, stats } = model.applyBulkScript(before, shots, '甲改了\n乙\n丙');
  assert.equal(stats.droppedAssets, 0, '改的是第 1 句，第 2 镜头不该受牵连');
  assert.equal(next.find((s) => s.id === 's2').assetId, 'ca_1');
});

test('句数变了，分组整体作废重算，全部已配画面计入丢失', () => {
  const before = bodyOf('甲', '乙', '丙');
  const shots = [
    { id: 's1', startNo: 1, endNo: 1, role: model.ROLE.AVATAR, assetId: 'ca_a' },
    { id: 's2', startNo: 2, endNo: 3, role: model.ROLE.BROLL, assetId: 'ca_b' },
  ];
  const { shots: next, stats } = model.applyBulkScript(before, shots, '甲');
  assert.equal(next, null, 'startNo/endNo 已指向别的句子，必须交回 defaultShots');
  assert.equal(stats.droppedAssets, 2);
});

test('一字未改时不判为变化，画面与试听时长全部保留', () => {
  const before = [
    { no: 1, text: '甲', role: model.ROLE.AVATAR, actualDurationSec: 5 },
    { no: 2, text: '乙', role: model.ROLE.BROLL },
  ];
  const shots = [{ id: 's1', startNo: 1, endNo: 2, role: model.ROLE.BROLL, assetId: 'ca_1' }];
  const { segments, shots: next, stats } = model.applyBulkScript(before, shots, '甲\n乙');
  assert.equal(stats.changed, false);
  assert.equal(stats.droppedAssets, 0);
  assert.equal(segments[0].actualDurationSec, 5);
  assert.equal(next[0].assetId, 'ca_1');
});

test('文字改了就丢掉该位置的试听时长', () => {
  const before = [{ no: 1, text: '甲', role: model.ROLE.AVATAR, actualDurationSec: 5 }];
  const { segments } = model.applyBulkScript(before, null, '甲改了');
  assert.equal(segments[0].actualDurationSec, 0, '试听时长属于旧文字');
});

test('清空文本是合法输入，标记 empty 由调用方拦，不在这里抛', () => {
  const { segments, stats } = model.applyBulkScript(bodyOf('甲'), null, '   \n\n  ');
  assert.deepEqual(segments, []);
  assert.equal(stats.empty, true);
});

/* ── 自动分段 ────────────────────────────────────────────────────────
   走本地规则而非 AI 端点：中文口播稿自带句末标点，规则切分即时、免费、离线、结果确定。 */

test('按句末标点切分，标点跟着前一句走', () => {
  const out = model.splitScriptText('大家好，我是张姐。我修了十二年鞋。有需要随时来！');
  assert.deepEqual(out, ['大家好，我是张姐。', '我修了十二年鞋。', '有需要随时来！']);
});

test('用户自己分好的行优先，不擅自合并他的意图', () => {
  assert.deepEqual(model.splitScriptText('第一行没有标点\n第二行也没有'), ['第一行没有标点', '第二行也没有']);
});

test('碎句并进上一段——单独一个「好。」既难配画面又白占一次出镜计费', () => {
  const out = model.splitScriptText('我在这条街开了十二年店。好。来的都是熟客。');
  assert.ok(!out.includes('好。'), `碎句不该单独成段：${JSON.stringify(out)}`);
  assert.ok(out.some((s) => s.includes('好。')), '碎句要并进相邻段而不是被丢掉');
});

test('超长段在次级标点处断开，不留一段念半分钟', () => {
  const long = '每天早上七点卷闸门一拉开这条街才算醒了，来的都是熟客一双鞋修好能再穿两年，这些年店越来越少招牌一块块褪了色';
  const out = model.splitScriptText(long, { maxChars: 30 });
  assert.ok(out.length > 1, '超长段必须被拆开');
  out.forEach((s) => assert.ok(s.length <= 46, `拆完仍过长：${s}`));
});

test('空白输入返回空数组，不抛', () => {
  assert.deepEqual(model.splitScriptText('   \n\n  '), []);
  assert.deepEqual(model.splitScriptText(null), []);
});

test('分段结果可直接喂给 applyBulkScript', () => {
  const pieces = model.splitScriptText('第一句。第二句。第三句。');
  const { segments } = model.applyBulkScript([{ no: 1, text: '旧', role: model.ROLE.AVATAR }], null, pieces.join('\n'));
  assert.deepEqual(segments.map((s) => s.text), ['第一句。', '第二句。', '第三句。']);
});
