import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_UPLOAD_MAX_BATCH_BYTES, CHAT_UPLOAD_MAX_COUNT, chatUploadIssue, formatUploadBytes,
} from './chatUploadModel.js';

test('PC 对话上传只接军师能拆读的文档格式', () => {
  assert.equal(chatUploadIssue([{ name: '经营数据.xlsx', size: 1024 }], 0), '');
  assert.match(chatUploadIssue([{ name: '安装包.dmg', size: 1024 }], 0), /格式暂不支持/);
});

test('PC 对话上传与移动端保持 9 份、单批 60MB 边界', () => {
  assert.match(chatUploadIssue([{ name: '补充.pdf', size: 1024 }], CHAT_UPLOAD_MAX_COUNT), /最多附 9 份/);
  assert.match(chatUploadIssue([
    { name: 'A.pdf', size: CHAT_UPLOAD_MAX_BATCH_BYTES / 4 + 1 },
    { name: 'B.pdf', size: CHAT_UPLOAD_MAX_BATCH_BYTES / 4 + 1 },
    { name: 'C.pdf', size: CHAT_UPLOAD_MAX_BATCH_BYTES / 4 + 1 },
    { name: 'D.pdf', size: CHAT_UPLOAD_MAX_BATCH_BYTES / 4 + 1 },
  ], 0), /一次最多 60.0MB/);
});

test('上传体积展示使用桌面可读单位', () => {
  assert.equal(formatUploadBytes(512), '512B');
  assert.equal(formatUploadBytes(1536), '2KB');
  assert.equal(formatUploadBytes(2.5 * 1024 * 1024), '2.5MB');
});
