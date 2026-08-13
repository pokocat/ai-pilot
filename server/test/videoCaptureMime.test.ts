// 采集文件按魔数判型。
//
// 背景：wx.uploadFile 不允许调用方设置 part 的 Content-Type，微信按临时文件扩展名自己推断；
// 录音管理器产出的临时文件常没有可识别扩展名 → 整包被标成 application/octet-stream，
// 于是 BFF 的 MIME 白名单误杀合法音频（预发实测「上传音频提示报错」的成因之一）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffCaptureMime } from '../src/routes/video.js';

/** 造一个带魔数的最小 buffer（后面填零，长度够过 12 字节下限）。 */
function withMagic(bytes: number[] | string, padTo = 32): Buffer {
  const head = typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : Buffer.from(bytes);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, padTo - head.length))]);
}

/** ISO BMFF：4 字节 box size + 'ftyp' + 4 字节 major brand。 */
function ftyp(brand: string): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from(brand.padEnd(4, ' ').slice(0, 4), 'latin1'),
    Buffer.alloc(16),
  ]);
}

test('MP3：ID3 标签头与 MPEG 帧同步都判成 audio/mpeg', () => {
  assert.equal(sniffCaptureMime(withMagic('ID3\x04\x00')), 'audio/mpeg');
  // 0xFFFB = MPEG-1 Layer3 常见帧头
  assert.equal(sniffCaptureMime(withMagic([0xff, 0xfb, 0x90, 0x00])), 'audio/mpeg');
});

test('AAC：ADTS 同步字 0xFFF1 / 0xFFF9 判成 audio/aac，不被 MP3 分支吃掉', () => {
  assert.equal(sniffCaptureMime(withMagic([0xff, 0xf1, 0x50, 0x80])), 'audio/aac');
  assert.equal(sniffCaptureMime(withMagic([0xff, 0xf9, 0x50, 0x80])), 'audio/aac');
});

test('WAV / OGG', () => {
  assert.equal(sniffCaptureMime(withMagic('RIFF\x00\x00\x00\x00WAVEfmt ')), 'audio/wav');
  assert.equal(sniffCaptureMime(withMagic('OggS\x00\x02')), 'audio/ogg');
});

test('ISO BMFF：qt 判 MOV，M4A 判音频，其余 brand 留给调用方按 kind 落位', () => {
  assert.equal(sniffCaptureMime(ftyp('qt')), 'video/quicktime');
  assert.equal(sniffCaptureMime(ftyp('M4A')), 'audio/mp4');
  assert.equal(sniffCaptureMime(ftyp('isom')), 'application/mp4');
  assert.equal(sniffCaptureMime(ftyp('mp42')), 'application/mp4');
});

test('图片：b-roll 素材可以是图，四种常见格式都要认', () => {
  assert.equal(sniffCaptureMime(withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniffCaptureMime(withMagic([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffCaptureMime(withMagic('RIFF\x00\x00\x00\x00WEBPVP8 ')), 'image/webp');
  assert.equal(sniffCaptureMime(withMagic('GIF89a')), 'image/gif');
});

test('JPEG 不会被 MPEG 帧同步分支误判', () => {
  // JPEG 首字节也是 0xFF，但第二字节 0xD8 & 0xE0 = 0xC0 ≠ 0xE0，不该命中 MP3 分支
  assert.equal(sniffCaptureMime(withMagic([0xff, 0xd8, 0xff, 0xdb])), 'image/jpeg');
});

test('认不出来的返回 null，让调用方保留声明值而不是瞎猜', () => {
  assert.equal(sniffCaptureMime(withMagic([0x00, 0x01, 0x02, 0x03])), null);
  assert.equal(sniffCaptureMime(Buffer.alloc(4)), null, '长度不足 12 字节直接 null');
});
