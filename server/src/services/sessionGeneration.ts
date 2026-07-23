// 会话生成中的进程内真值。
//
// 生成请求本身会一直留在 API 进程内执行；用户从聊天页返回列表后，新的页面实例无法再读取旧组件的
// React busy 状态，因此由服务端按 sessionId 暴露当前是否仍有生成请求在途。用计数而非 boolean，
// 避免同一账号多端同时发问时某一轮先结束、误把另一轮仍在执行的状态清掉。
const activeGenerations = new Map<string, number>();

export function trackSessionGeneration(sessionId: string): () => void {
  activeGenerations.set(sessionId, (activeGenerations.get(sessionId) ?? 0) + 1);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const left = (activeGenerations.get(sessionId) ?? 1) - 1;
    if (left > 0) activeGenerations.set(sessionId, left);
    else activeGenerations.delete(sessionId);
  };
}

export function isSessionGenerating(sessionId: string): boolean {
  return (activeGenerations.get(sessionId) ?? 0) > 0;
}
