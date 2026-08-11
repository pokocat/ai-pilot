import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultClipShots, normalizeClipScriptAi } from '../src/services/video/scriptChat.js';
import type { ClipProject } from '../../shared/contracts';

const project: ClipProject = {
  id: 'cp_1', templateId: 'ct_1', templateName: '实体发声', title: '实体发声', status: 'draft', variables: {},
  segments: [{ no: 1, text: '原稿。', role: 'avatar' }, { no: 2, text: '固定结尾', role: 'tail', durationSec: 3 }],
};

test('模型把碎句返回时会合成完整语义段', () => {
  const result = normalizeClipScriptAi({
    action: 'draft', reply: '改好了', segments: [
      { text: '我在这条街。', role: 'broll', hint: '门头' },
      { text: '守了十二年。', role: 'broll', hint: '门头' },
      { text: '每双鞋都认真修。', role: 'avatar', hint: '正面' },
    ],
  }, project, '更自然');
  assert.equal(result.applied, true);
  assert.deepEqual(result.segments?.map((row) => row.text), ['我在这条街。守了十二年。', '每双鞋都认真修。']);
});

test('默认镜头让连续三段实拍共用一个画面', () => {
  const shots = defaultClipShots([
    { no: 1, text: '一', role: 'broll' }, { no: 2, text: '二', role: 'broll' },
    { no: 3, text: '三', role: 'broll' }, { no: 4, text: '四', role: 'broll' },
  ]);
  assert.deepEqual(shots.map((shot) => [shot.startNo, shot.endNo]), [[1, 3], [4, 4]]);
});

test('结构化模型失败时不得把原稿重新分段后冒充改稿成功', () => {
  const result = normalizeClipScriptAi(null, project, '换成煎饼果子摊');
  assert.equal(result.applied, false);
  assert.equal(result.segments, undefined);
  assert.match(result.reply, /原稿没有改动/);
});

test('明确换品类的完整新稿会替换旧主体', () => {
  const result = normalizeClipScriptAi({
    action: 'draft', reply: '已经换成煎饼果子摊', segments: [
      { text: '大家好，我是街口煎饼摊的陈姐。', role: 'avatar', hint: '摊位前口播' },
      { text: '每天清晨和面、摊饼、打蛋，热乎的早餐现点现做。', role: 'broll', hint: '制作过程' },
    ],
  }, project, '换成煎饼果子摊');
  assert.equal(result.applied, true);
  assert.equal(result.segments?.some((row) => /修鞋/.test(row.text)), false);
  assert.equal(result.segments?.some((row) => /煎饼/.test(row.text)), true);
});
