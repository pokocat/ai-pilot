import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AliyunGreenMediaError,
  clipMediaKind,
  isAliyunGreenConfigured,
  moderateClipMedia,
  type AliyunGreenConfig,
} from '../src/services/video/aliyunGreenMedia.js';

const CONFIG: AliyunGreenConfig = {
  provider: 'aliyun-green',
  accessKeyId: 'test-key-id',
  accessKeySecret: 'test-key-secret',
  endpoint: 'green-cip.cn-shanghai.aliyuncs.com',
  imageService: 'baselineCheck',
  videoService: 'videoDetection',
  voiceService: 'audio_media_detection',
  timeoutMs: 10_000,
  pollIntervalMs: 500,
};

const upload = async () => ({ bucketName: 'green-temp', objectName: 'upload/object.mp4' });

test('clip media moderation configuration and MIME families fail closed', () => {
  assert.equal(isAliyunGreenConfigured(CONFIG), true);
  assert.equal(isAliyunGreenConfigured({ ...CONFIG, accessKeySecret: '' }), false);
  assert.equal(isAliyunGreenConfigured({ ...CONFIG, provider: 'none' }), false);
  assert.equal(clipMediaKind('image/jpeg'), 'image');
  assert.equal(clipMediaKind('video/mp4'), 'video');
  assert.equal(clipMediaKind('audio/wav'), 'audio');
  assert.equal(clipMediaKind('application/pdf'), null);
});

test('image moderation passes only none/low and keeps audit-safe labels', async () => {
  const calls: Array<{ action: string; params: Record<string, string> }> = [];
  const result = await moderateClipMedia(Buffer.from('image'), 'image/jpeg', CONFIG, {
    upload,
    rpc: async (action, params) => {
      calls.push({ action, params });
      return {
        RequestId: 'req-image', Code: 200,
        Data: { RiskLevel: 'low', Result: [{ Label: 'nonLabel' }, { Label: 'quality_low' }], Text: 'never collect me' },
      };
    },
  });
  assert.deepEqual(result, {
    provider: 'aliyun-green', kind: 'image', pass: true, riskLevel: 'low', labels: ['quality_low'], requestId: 'req-image',
  });
  assert.equal(calls[0]?.action, 'ImageBatchModeration');
  const serviceParameters = JSON.parse(calls[0]?.params.ServiceParameters ?? '{}');
  assert.equal(serviceParameters.ossBucketName, 'green-temp');
  assert.equal(serviceParameters.ossObjectName, 'upload/object.mp4');
  assert.equal('bucketName' in serviceParameters, false);
});

test('video moderation polls 280/288 until a complete none result', async () => {
  const actions: string[] = [];
  let resultQueries = 0;
  let clock = 1_000;
  const result = await moderateClipMedia(Buffer.from('video'), 'video/mp4', CONFIG, {
    upload,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    rpc: async (action) => {
      actions.push(action);
      if (action === 'VideoModeration') return { Code: 200, Data: { TaskId: 'task-video' } };
      resultQueries += 1;
      if (resultQueries === 1) return { Code: 280, Message: 'processing' };
      if (resultQueries === 2) return { Code: 288, Message: 'queued' };
      return { RequestId: 'req-video', Code: 200, Data: { RiskLevel: 'none', FrameResult: { RiskLevel: 'none' } } };
    },
  });
  assert.equal(result.pass, true);
  assert.equal(result.riskLevel, 'none');
  assert.deepEqual(actions, ['VideoModeration', 'VideoModerationResult', 'VideoModerationResult', 'VideoModerationResult']);
});

test('voice medium risk is blocked because no manual-review queue exists', async () => {
  let clock = 1_000;
  const result = await moderateClipMedia(Buffer.from('voice'), 'audio/wav', CONFIG, {
    upload,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    rpc: async (action) => action === 'VoiceModeration'
      ? { Code: 200, Data: { TaskId: 'task-voice' } }
      : { RequestId: 'req-voice', Code: 200, Data: { RiskLevel: 'medium', SliceDetails: [{ Labels: 'profanity' }] } },
  });
  assert.equal(result.pass, false);
  assert.equal(result.riskLevel, 'medium');
  assert.deepEqual(result.labels, ['profanity']);
});

test('provider errors and incomplete results never pass', async () => {
  await assert.rejects(
    () => moderateClipMedia(Buffer.from('image'), 'image/jpeg', CONFIG, {
      upload,
      rpc: async () => ({ Code: 408, Message: 'permission deny' }),
    }),
    (error: unknown) => error instanceof AliyunGreenMediaError && error.detailCode === 408,
  );
  await assert.rejects(
    () => moderateClipMedia(Buffer.from('image'), 'image/jpeg', CONFIG, {
      upload,
      rpc: async () => ({ Code: 200, Data: { Result: [{ Label: 'nonLabel' }] } }),
    }),
    /结果不完整/,
  );
});

test('async moderation times out within the configured request budget', async () => {
  let clock = 0;
  await assert.rejects(
    () => moderateClipMedia(Buffer.from('video'), 'video/mp4', { ...CONFIG, timeoutMs: 1_000, pollIntervalMs: 500 }, {
      upload,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      rpc: async (action) => action === 'VideoModeration'
        ? { Code: 200, Data: { TaskId: 'task-timeout' } }
        : { Code: 280 },
    }),
    /等待结果超时/,
  );
});

test('oversized images and unsupported media report explicit client errors', async () => {
  await assert.rejects(
    () => moderateClipMedia(Buffer.alloc(20 * 1024 * 1024 + 1), 'image/jpeg', CONFIG, { upload }),
    (error: unknown) => error instanceof AliyunGreenMediaError && error.statusCode === 413,
  );
  await assert.rejects(
    () => moderateClipMedia(Buffer.from('x'), 'application/pdf', CONFIG, { upload }),
    (error: unknown) => error instanceof AliyunGreenMediaError && error.statusCode === 415,
  );
});
