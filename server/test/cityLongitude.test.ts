// 城市经度匹配回归（2026-08 收紧）。
// 背景：经度校正不是微调——每偏 1° 平移 4 分钟，时辰颗粒 120 分钟，一次误命中足以改时柱，
// 落在子时/立春边界上还会改日柱甚至年柱月柱。所以口径是「宁可不校正，不能乱校正」。
// 旧实现的反向包含 `city.includes(s)` 会把单字和含城市名的地址串全部误命中。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCity, cityLongitude } from '../src/data/cityLongitude.ts';

test('精确匹配：带行政后缀与省市连写都命中同一城市', () => {
  assert.deepEqual(matchCity('杭州'), { city: '杭州', longitude: 120.2 });
  assert.deepEqual(matchCity('杭州市'), { city: '杭州', longitude: 120.2 });
  assert.deepEqual(matchCity('浙江省杭州市'), { city: '杭州', longitude: 120.2 });
  assert.equal(cityLongitude('乌鲁木齐市'), 87.6);
});

test('单字输入一律不匹配（旧实现会误命中）', () => {
  // 「南」既可能是南京也可能是南昌/南宁，无法可靠定位；旧实现按反向包含直接给了南京 118.8。
  for (const s of ['南', '海', '大', '长', '西', '北']) {
    assert.equal(matchCity(s), undefined, `单字「${s}」不该命中`);
  }
});

test('地址串只按「输入含有城市名」正向匹配，取最长命中', () => {
  // 「南京路」是上海路名：旧实现 s.includes('南京') 命中南京 118.8（差 2.7° 且方向相反）。
  // 正向包含无法从字面区分路名与城市名，但这里至少不再被单字/短串反向命中；
  // 更长的城市名优先，避免「哈尔滨」被更短项抢先。
  assert.deepEqual(matchCity('黑龙江哈尔滨'), { city: '哈尔滨', longitude: 126.6 });
  assert.deepEqual(matchCity('长春'), { city: '长春', longitude: 125.3 });   // 不该落到长沙
  assert.deepEqual(matchCity('长沙'), { city: '长沙', longitude: 113.0 });
});

test('表外城市静默不命中（不校正好过乱校正）', () => {
  for (const s of ['三亚', '昆山', '南通', '保定', '安庆']) {
    assert.equal(matchCity(s), undefined, `表外「${s}」应返回 undefined`);
  }
});

test('空值与纯行政后缀不命中', () => {
  assert.equal(matchCity(undefined), undefined);
  assert.equal(matchCity(null), undefined);
  assert.equal(matchCity(''), undefined);
  assert.equal(matchCity('   '), undefined);
  assert.equal(matchCity('市'), undefined);
  assert.equal(matchCity('省市区县'), undefined);
});
