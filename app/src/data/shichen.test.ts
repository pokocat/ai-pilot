import assert from 'node:assert/strict';
import { test } from 'node:test';
import { birthTimeParts, birthTimeValue } from './shichen';

test('出生时间选择器保留准确分钟，不能把 23:30 降成 23:00', () => {
  assert.deepEqual(birthTimeParts(true, '23:30'), { hour: 23, minute: 30 });
  assert.deepEqual(birthTimeParts(true, '00:07'), { hour: 0, minute: 7 });
  assert.deepEqual(birthTimeParts(false, '23:30'), { hour: null });
});

test('旧时辰记录回填采用档位中点，等待用户确认准确分钟', () => {
  assert.equal(birthTimeValue(23, undefined), '23:30');
  assert.equal(birthTimeValue(0, undefined), '00:30');
  assert.equal(birthTimeValue(10, undefined), '10:00');
  assert.equal(birthTimeValue(23, 0), '23:00');
});
