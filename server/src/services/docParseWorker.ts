import { parentPort } from 'node:worker_threads';
import { parseDocumentInProcess } from './docParse.js';

if (!parentPort) throw new Error('docParseWorker 只能在 Worker 中运行');

parentPort.once('message', async (message: { buffer: ArrayBuffer; fileName: string; mime?: string }) => {
  try {
    const value = await parseDocumentInProcess(Buffer.from(message.buffer), message.fileName, message.mime);
    parentPort?.postMessage({ ok: true, value });
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: (error as Error).message || '文档解析失败' });
  }
});
