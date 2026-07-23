import Taro from '@tarojs/taro';

// 客户端的极短交接标记：用户点发送后页面会立刻进入 busy，但服务端从收到请求到创建/登记会话仍有
// 一个很短的窗口。把 sessionId + 时间写入 storage，可保证“立刻返回列表再进入”也不会闪掉思考态。
// 服务端 SessionDetail.generating 仍是权威真值；本标记只桥接网络往返，并以 10 分钟 TTL 防陈旧。
const KEY = 'junshi.chat.pending.v1';
const TTL_MS = 10 * 60_000;

type PendingMap = Record<string, number>;

function read(): PendingMap {
  try {
    const raw = Taro.getStorageSync(KEY);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed as PendingMap).filter(([, at]) => Number.isFinite(at) && now - at < TTL_MS),
    );
  } catch {
    return {};
  }
}

function write(value: PendingMap) {
  try {
    if (Object.keys(value).length) Taro.setStorageSync(KEY, value);
    else Taro.removeStorageSync(KEY);
  } catch { /* storage 不可用时回退服务端 generating */ }
}

export function markChatPending(sessionId: string) {
  if (!sessionId) return;
  write({ ...read(), [sessionId]: Date.now() });
}

export function clearChatPending(sessionId: string) {
  if (!sessionId) return;
  const next = read();
  delete next[sessionId];
  write(next);
}

export function chatPendingAge(sessionId: string): number | null {
  const at = read()[sessionId];
  return typeof at === 'number' ? Math.max(0, Date.now() - at) : null;
}

export function isChatPending(sessionId: string): boolean {
  return chatPendingAge(sessionId) !== null;
}
