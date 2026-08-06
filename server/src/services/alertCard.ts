// Alertmanager 告警 → 飞书 Card 2.0 展示模型。
//
// 这里故意只做纯格式化，不读 DB、不出网：同一份 Alertmanager payload 可以稳定单测，
// 通知传输与签名仍由 alertConfig.ts 负责。卡片只使用静态展示与 open_url，避免引入
// card.action.trigger 回调服务后才可用的交互动作。

export interface AmAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
}

export interface AmWebhookPayload {
  status?: string;
  receiver?: string;
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  externalURL?: string;
  truncatedAlerts?: number;
  alerts?: AmAlert[];
}

export interface AlertCardOptions {
  nowMs?: number;
  environment?: string;
  grafanaBaseUrl?: string;
  timeZone?: string;
}

type CardElement = Record<string, unknown>;

const CATEGORY_LABELS: Record<string, string> = {
  availability: '可用性',
  api: 'API 服务',
  llm_gateway: 'LLM 网关',
  chat_experience: '对话体验',
  cost: '成本',
  payment: '支付与权益',
  business: '业务质量',
  security: '内容安全',
  growth: '增长',
  system: '主机资源',
  database: '数据库',
  monitoring: '监控链路',
};

const DASHBOARD_UIDS: Record<string, string> = {
  availability: 'junshi-api',
  api: 'junshi-api',
  llm_gateway: 'junshi-llm',
  chat_experience: 'junshi-llm',
  cost: 'junshi-llm',
  payment: 'junshi-business',
  business: 'junshi-business',
  security: 'junshi-business',
  growth: 'junshi-business',
  system: 'junshi-system',
  database: 'junshi-system',
  monitoring: 'junshi-system',
};

const SEVERITY_LABELS: Record<string, string> = { critical: '严重', warning: '预警', info: '提示' };
const SEVERITY_RANK: Record<string, number> = { critical: 3, warning: 2, info: 1 };
const LABEL_ORDER = ['instance', 'job', 'route', 'method', 'lane', 'provider', 'model', 'phase', 'path', 'ref', 'mountpoint', 'skill', 'code'];

interface AlertKnowledge { title: string; threshold: string; impact: string; action: string }
const K = (title: string, threshold: string, impact: string, action: string): AlertKnowledge => ({ title, threshold, impact, action });

/**
 * 告警的人类可读知识层。PromQL 负责「何时响」，这里负责「响了代表什么、先做什么」。
 * 规则测试会锁定每个 alertname 都有一条知识，防新增规则退化成难懂的一行指标名。
 */
export const ALERT_KNOWLEDGE: Record<string, AlertKnowledge> = {
  JunshiApiDown: K('API 指标抓取失败', '连续 1 分钟无法抓取 /api/metrics', 'API 进程可能退出，或监控凭证不一致；应用告警转发链路也可能同时失联。', '先请求 /api/health/ready，再核对 junshi-api 状态与 METRICS_TOKEN。'),
  JunshiProbeFailed: K('端到端探活失败', '连续 2 分钟 probe_success=0', '本机失败表示服务本体异常；仅公网失败通常指向 Nginx、DNS 或 TLS。', '对照 instance 分辨本机/公网探针，依次检查 API、Nginx、DNS 与证书。'),
  JunshiTlsCertExpiringSoon: K('TLS 证书即将到期', '证书剩余有效期不足 14 天', '到期后小程序与后台 HTTPS 请求都会失败。', '检查 certbot timer、续期日志和 80/443 挑战链路，手工 dry-run 验证续期。'),
  JunshiApiP95High: K('普通接口响应变慢', 'P95 超过后台预警线并持续 5 分钟', '页面加载、列表读取和保存动作开始出现可感知延迟。', '从 API 看板定位最慢路由，再查数据库等待、CPU 与事件循环。'),
  JunshiApiP95Critical: K('普通接口延迟严重', 'P95 超过后台严重线并持续 5 分钟', '用户操作可能大量超时，继续放量会放大排队与失败。', '停止放量，按最慢路由定位瓶颈；必要时限流或扩容。'),
  JunshiApi5xxRateHigh: K('API 5xx 错误率过高', '5 分钟 5xx 率超过后台严重线', '一部分用户请求已明确失败，可能涉及多条业务路径。', '先看路由级 5xx Top，再按错误码和发布时间关联服务日志。'),
  JunshiApiRateLimitedSpike: K('API 限流激增', '5 分钟 429 数超过后台配置线', '正常用户可能被全站或成本型接口限流。', '确认来源 IP/账号是否异常，再核对 RATE_LIMIT_MAX 与具体路由限额。'),
  JunshiOverloadRejecting: K('过载闸开始拒绝请求', '5 分钟内出现主动 503', '服务已靠快速失败自保，部分非流式请求无法完成。', '核对在途数、CPU、数据库连接与流量来源，先控流再扩容。'),
  JunshiEventLoopSlow: K('Node 事件循环阻塞', '累计 P95 延迟超过 200ms 并持续 10 分钟', '单进程无法及时处理定时器和 I/O 回调，所有接口都会抖动。', '查 CPU 热点、同步计算和大 JSON/文件处理；结合发布时间判断是否回滚。'),
  JunshiRssGrowing: K('API 进程内存过高', 'RSS 超后台预警线并持续 30 分钟', '继续增长可能触发 OOM，导致 API 重启和生成任务接管。', '对照发布前后趋势，检查堆、缓存、上传解析与长会话对象是否释放。'),
  JunshiLlm429RateHigh: K('上游模型限流率升高', '10 分钟至少 20 个样本且 429 率超后台预警线', '部分生成会排队、退避或降级，首字延迟开始变差。', '按 lane/provider 查看 429，核对上游配额并收紧并发。'),
  JunshiLlm429RateCritical: K('上游模型限流严重', '10 分钟至少 20 个样本且 429 率超后台严重线', '生成失败和长等待将集中出现，可能影响全体对话用户。', '立即降低 LLM_MAX_CONCURRENCY、延长退避；必要时切换健康端点。'),
  JunshiLlmErrorRateHigh: K('模型调用失败率升高', '15 分钟至少 10 次调用且错误率超过 10%', '对话与报告生成可能报错或走降级内容。', '按 provider/kind 查失败分布和 LlmTrace，确认鉴权、超时、协议与上游状态。'),
  JunshiLlmCallP95Slow: K('模型调用耗时过长', '30 分钟调用 P95 超过后台配置秒数', '用户首字和完整成果等待时间都会拉长，并占满并发槽。', '拆分 provider/kind 时延，确认是排队、模型推理还是工具循环变慢。'),
  JunshiLlmQueueWaitLong: K('LLM 排队等待过长', '等待峰值超后台预警线并持续 5 分钟', '用户在请求真正发往模型前已经等待。', '查看车道并发、队列深度和上游 429，避免盲目提高本地并发。'),
  JunshiLlmQueueWaitCritical: K('LLM 排队等待严重', '等待峰值超后台严重线并持续 5 分钟', '请求接近主动超时，用户将看到忙碌或失败提示。', '降级或暂停接单，释放非核心任务并恢复健康端点容量。'),
  JunshiLlmQueueRejected: K('LLM 队列拒绝或超时', '15 分钟内出现 queue full / timeout', '用户请求在获得上游槽位前就失败。', '核对 queued、ceiling、429 与冷却状态；先降低入口流量再调整队列。'),
  JunshiLlmCoolingLong: K('LLM 车道长时间冷却', '车道 cooling=1 持续 5 分钟', '该车道暂不接单，可用模型容量下降。', '确认连续 429 与冷却剩余时间，检查上游配额或切换端点。'),
  JunshiTokenCostBudget70: K('Token 日预算达到 70%', '滚动 24 小时成本超过日预算 70%', '成本进入关注区，但核心功能仍可继续运行。', '检查成本按 provider/model/kind 分布，暂停低价值自动任务。'),
  JunshiTokenCostBudget90: K('Token 日预算达到 90%', '滚动 24 小时成本超过日预算 90%', '接近硬预算，继续按当前速度消耗可能超支。', '关闭非核心自动任务，核对异常会话与输出长度，准备限额。'),
  JunshiTokenCostBudget100: K('Token 日预算已用尽', '滚动 24 小时成本达到或超过日预算 100%', '成本控制红线已突破，继续运行会扩大超支。', '立即执行成本硬停止策略，仅保留明确批准的核心调用。'),
  JunshiUsageUnreported: K('模型用量漏报', '1 小时内真实 provider 出现未回传 usage', '成本与 Token 看板低估实际消耗，无法可靠对账。', '检查 provider 响应 usage 字段、协议适配与模型映射，补齐漏账口径。'),
  JunshiGenDegraded: K('AI 产出发生降级', '15 分钟内出现 mock/模板兜底', '用户拿到的内容质量低于正常模型产出。', '按 path 定位降级分支，检查 provider 可用性、错误日志与配置。'),
  JunshiChatTruncatedGivenUp: K('对话续写后仍未写完', '1 小时次数超过后台配置线', '用户实际收到不完整回答或成果。', '检查 CHAT_MAX_TOKENS、思考预算、提示词长度和续写次数。'),
  JunshiChatContinuationBusy: K('自动续写过于频繁', '1 小时自动续写次数超过后台配置线', '用户未必感知失败，但额外消耗一轮 Token 并拉长响应。', '校准输出预算与长度契约，减少不必要续写。'),
  JunshiChatStreamStall: K('流式响应静默卡死', '15 分钟内空闲看门狗触发', '用户可能长时间看不到首字，或已显示的回答中途停止。', '按 provider/phase/had_text 定位，检查 SSE、代理缓冲与上游连接。'),
  JunshiChatStreamFallback: K('流式对话回退非流式', '15 分钟内 stream_failed 回退出现', '用户失去逐字反馈，并改为承受完整请求总超时。', '检查上游 SSE 支持、网关响应头、Nginx 缓冲和连接超时。'),
  JunshiChatFirstTokenSlow: K('对话首字延迟过高', '30 分钟首字 P95 超后台配置线并持续 10 分钟', '用户发送后长时间没有可见反馈，是最直接的等待体验劣化。', '对比分段时延，判断接单排队、上下文构建还是 provider 首字慢。'),
  JunshiChatPartialKeptBroken: K('流式残文保全链路异常', '已有正文的 stall 出现但保全计数为 0', '已展示给用户的正文可能被错误气泡覆盖或丢失。', '检查 provider sink、stream_error 终态与消息落库链路，按回归缺陷处理。'),
  JunshiChatGenerationFailureRateHigh: K('持久生成失败率过高', '15 分钟至少 5 个任务且失败率超过 10%', '对话生成任务不能稳定完成，用户会看到失败或需要重试。', '检查 GenerationJob 终态、provider 错误、租约与结算记录。'),
  JunshiChatGenerationRecovered: K('生成任务发生故障接管', '15 分钟内出现租约过期接管', '通常意味着 API 重启、worker 卡死或单次生成超出租约。', '关联 API 重启时间，检查旧 attempt、provider 耗时与 worker 心跳。'),
  JunshiChatUsageEstimated: K('对话用量采用估算结算', '15 分钟内出现 estimated/mixed usage', '单次用户权益已封账，但真实 Token 成本精度下降。', '按 provider 检查 usage 回传与故障接管，确认估算偏差可接受。'),
  JunshiPaidNotApplied: K('已支付但权益未发放', '存在订单已支付未发放并持续 10 分钟', '用户已经付款却拿不到套餐或商品，属于直接资损与客诉风险。', '立即到运营后台订单页补账，并核查支付回调和 sweep 日志。'),
  JunshiPaySweepFailing: K('支付对账持续失败', '最近 sweep 失败数连续 15 分钟大于 0', '卡单无法自动收敛，支付终态可能长期不一致。', '检查微信查单响应、证书/签名、网络与具体失败订单。'),
  JunshiPaySweepStopped: K('支付对账任务停止运行', 'API 运行超过 20 分钟且 15 分钟内没有 sweep', '支付回调丢失后无法主动补偿，卡单风险上升。', '检查 scheduler 是否启动、进程日志与 pay sweep 锁。'),
  JunshiRefundSpike: K('退款笔数异常升高', '6 小时退款数超过后台配置线', '可能出现产品质量、误购或计费争议。', '抽查退款原因和对应套餐/商品，关联近期发布与客诉。'),
  JunshiModerationBlockSpike: K('内容审核拦截激增', '1 小时同一 ref 拦截数超过后台配置线', '可能是攻击流量，也可能是审核策略误伤正常用户。', '抽查脱敏样本和 ref 分布，检查关键词/供应商策略变更。'),
  JunshiNoRegistrations72h: K('连续 72 小时无新注册', '所有注册渠道 72 小时增量为 0', '推广期可能意味着微信登录、短信或落地链路静默故障。', '先确认是否符合业务预期，再分渠道验证注册全链路。'),
  JunshiCreativeFailureRateHigh: K('创作任务失败率过高', '1 小时至少 5 个任务且失败率超过 20%', '用户无法稳定拿到海报或品牌成品。', '按 failure code、skill 和 provider 定位图片生成、审核或渲染故障。'),
  JunshiCreativeTemplateFallback: K('AI 排版频繁回退模板', '1 小时 template_fallback 超过 3 次', '任务可能显示成功，但成品质感和差异化明显下降。', '检查 AI 排版轮次、输出解析和渲染日志，确认供应链是否退化。'),
  HostCpuHigh: K('主机 CPU 持续偏高', '5 分钟平均 CPU 超后台预警线', 'API、数据库和监控同机时会互相争抢算力。', '查看进程 CPU、负载与流量，识别 API、PG 或监控组件热点。'),
  HostCpuCritical: K('主机 CPU 严重过载', '3 分钟平均 CPU 超后台严重线', '接口时延和任务处理会快速恶化，可能触发级联超时。', '立即控流并扩容，必要时停止非核心任务。'),
  HostMemoryLow: K('主机可用内存不足', '可用内存低于 12% 持续 5 分钟', '可能开始 swap 或触发 OOM，服务会抖动或重启。', '定位 RSS 最大进程，检查 API 内存趋势、PG 缓存与日志组件。'),
  HostDiskFilling: K('磁盘使用率过高', '非临时文件系统使用率超过 85% 持续 10 分钟', '日志、数据库和容器写入空间逼近上限。', '按 mountpoint 查大目录，清理可回收数据并扩盘。'),
  HostDiskWillFillIn24h: K('磁盘预计 24 小时内写满', '按最近 6 小时趋势预测可用空间降至 0', '数据库和日志同盘时，写满会导致全站不可用。', '立即确认增长源，暂停异常写入并扩盘；不要只做一次性清理。'),
  HostFileDescriptorsHigh: K('文件句柄占用过高', '文件句柄使用率超过 80% 持续 10 分钟', '新连接和文件打开可能失败，出现难以解释的网络错误。', '检查 socket/文件泄漏和连接数量，必要时调整限额并修复泄漏。'),
  PgConnectionsHigh: K('PostgreSQL 连接使用率偏高', '连接数占 max_connections 超后台预警线 5 分钟', '连接池余量缩小，突发流量可能拿不到连接。', '按状态看连接，核对实例数与 Prisma pool 配置，清理空闲长连接。'),
  PgConnectionsCritical: K('PostgreSQL 连接接近耗尽', '连接使用率超后台严重线 3 分钟', '新请求可能因无法获取连接而失败。', '立即限流，排查连接泄漏，并扩连接层或数据库规格。'),
  PgDown: K('PostgreSQL 不可达', 'postgres_exporter 连续 1 分钟报告 pg_up=0', '大多数业务读写会失败，API 可能只剩探活可用。', '检查 PostgreSQL 服务、监听地址、磁盘与监控账号连接。'),
  PgLongTransaction: K('PostgreSQL 存在长事务', 'junshi 库最长事务超过 5 分钟并持续 5 分钟', '会拖住 vacuum、持锁并放大表膨胀与阻塞。', '定位 pid/query/xact_start，确认后终止异常事务并修业务边界。'),
  PgDeadlocksDetected: K('PostgreSQL 检测到死锁', '1 小时内 deadlocks 增量大于 0', '至少一个事务被数据库强制回滚，用户操作可能失败。', '按时间查 PostgreSQL 日志和相关写路径，统一锁顺序。'),
  MonitoringTargetDown: K('监控采集目标离线', 'exporter/blackbox/Alertmanager target 连续 2 分钟 up=0', '对应指标或通知能力出现盲区，业务可能正常但监控已失真。', '按 job/instance 检查容器状态、端口、配置与凭证。'),
};

function cap(value: string | undefined, max = 500): string {
  const s = (value ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Alert labels/annotations are data, not card markdown. Escape control characters before interpolation. */
function md(value: string | undefined, max = 500): string {
  return cap(value, max)
    .replaceAll('&', '&#38;')
    .replaceAll('<', '&#60;')
    .replaceAll('>', '&#62;')
    .replaceAll('*', '&#42;')
    .replaceAll('_', '&#95;')
    .replaceAll('~', '&#126;')
    .replaceAll('[', '&#91;')
    .replaceAll(']', '&#93;');
}

function severityOf(alerts: AmAlert[]): string {
  return alerts.reduce((best, alert) => {
    const next = alert.labels?.severity ?? 'info';
    return (SEVERITY_RANK[next] ?? 0) > (SEVERITY_RANK[best] ?? 0) ? next : best;
  }, 'info');
}

function categoryOf(alerts: AmAlert[], payload: AmWebhookPayload): string {
  return payload.groupLabels?.category
    ?? payload.commonLabels?.category
    ?? alerts[0]?.labels?.category
    ?? 'monitoring';
}

function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function durationText(fromMs: number | null, toMs: number): string {
  if (fromMs === null) return '未知';
  const seconds = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours < 24) return `${hours} 小时 ${minutes} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function dateText(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(ms);
  } catch {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }
}

function validHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString().replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

function metricColumn(label: string, value: string, note: string): CardElement {
  return {
    // 飞书 Card 2.0 的 column.background_style 虽在文档中声明支持 RGBA，机器人
    // webhook 实际会以 10002 拒绝 rgba(...)；保留分栏与内边距，交由默认主题着色。
    tag: 'column', width: 'weighted', weight: 1, padding: '8px',
    elements: [
      { tag: 'markdown', content: `**${md(label, 24)}**`, text_size: 'caption' },
      { tag: 'markdown', content: `## ${md(value, 40)}`, text_size: 'title' },
      { tag: 'markdown', content: md(note, 80), text_size: 'caption' },
    ],
  };
}

function alertScope(alert: AmAlert): string {
  const labels = alert.labels ?? {};
  const pairs = LABEL_ORDER
    .filter((key) => labels[key])
    .slice(0, 5)
    .map((key) => `${key}=${md(labels[key], 80)}`);
  return pairs.length ? pairs.join(' · ') : '全局信号';
}

function alertBlock(alert: AmAlert, index: number, nowMs: number, groupResolved: boolean): CardElement {
  const a = alert.annotations ?? {};
  const alertname = alert.labels?.alertname ?? '';
  const knowledge = ALERT_KNOWLEDGE[alertname];
  const title = a.title || knowledge?.title || a.summary || alertname || '未命名告警';
  const started = parseMs(alert.startsAt);
  const ended = parseMs(alert.endsAt);
  const resolved = groupResolved || alert.status === 'resolved';
  const duration = durationText(started, resolved && ended ? ended : nowMs);
  const lines = [
    `**${index + 1}. ${md(title, 120)}**  <text_tag color='${resolved ? 'green' : alert.labels?.severity === 'critical' ? 'red' : alert.labels?.severity === 'warning' ? 'orange' : 'blue'}'>${resolved ? '已恢复' : md(SEVERITY_LABELS[alert.labels?.severity ?? 'info'] ?? '提示', 12)}</text_tag>`,
    a.summary && a.summary !== title ? md(a.summary, 600) : '',
    `**当前 / 阈值**　${md(a.current || a.summary || '见实时指标', 180)}　/　${md(a.threshold || knowledge?.threshold || '条件型告警', 180)}`,
    `**影响判断**　${md(a.impact || knowledge?.impact || '需结合对应看板确认影响范围', 600)}`,
    `**建议动作**　${md(a.action || knowledge?.action || '先看趋势与关联日志，再决定是否升级处置', 600)}`,
    `**对象 / 持续**　${alertScope(alert)}　·　${duration}`,
  ].filter(Boolean);
  return { tag: 'markdown', content: lines.join('\n'), text_size: 'body' };
}

/**
 * 飞书 Card 2.0：结论先行、三格态势、逐告警证据与处置、看板按钮。
 * 单组最多展开 8 条，避免告警风暴把机器人 30KB 消息上限打穿；超出数量在卡片里明示。
 */
export function formatAlertCard(payload: AmWebhookPayload, options: AlertCardOptions = {}): Record<string, unknown> {
  const all = payload.alerts ?? [];
  const firing = all.filter((alert) => alert.status !== 'resolved');
  const resolvedAlerts = all.filter((alert) => alert.status === 'resolved');
  const resolved = payload.status === 'resolved' || firing.length === 0;
  const shown = (resolved ? resolvedAlerts : [...firing, ...resolvedAlerts]).slice(0, 8);
  const nowMs = options.nowMs ?? Date.now();
  const severity = severityOf(all);
  const category = categoryOf(all, payload);
  const categoryLabel = CATEGORY_LABELS[category] ?? category;
  const earliest = all.map((a) => parseMs(a.startsAt)).filter((v): v is number => v !== null).sort((a, b) => a - b)[0] ?? null;
  const endCandidates = all.map((a) => parseMs(a.endsAt)).filter((v): v is number => v !== null);
  const durationEnd = resolved && endCandidates.length ? Math.max(...endCandidates) : nowMs;
  const env = options.environment?.trim() || payload.commonLabels?.environment || '生产环境';
  const timeZone = options.timeZone?.trim() || 'Asia/Shanghai';
  const totalCount = all.length + Math.max(0, payload.truncatedAlerts ?? 0);
  const statusLabel = resolved ? '已恢复' : '告警中';
  const severityLabel = resolved ? '恢复' : (SEVERITY_LABELS[severity] ?? '提示');
  const template = resolved ? 'green' : severity === 'critical' ? 'red' : severity === 'warning' ? 'orange' : 'blue';
  const summary = resolved
    ? `${categoryLabel}告警已经恢复，共 ${resolvedAlerts.length || all.length} 个信号回到正常范围。`
    : `${categoryLabel}出现 ${firing.length} 个正在触发的信号，其中最高等级为${severityLabel}。`;

  const elements: CardElement[] = [
    { tag: 'markdown', content: `**结论**　${md(summary, 300)}`, text_size: 'body' },
    {
      tag: 'column_set', flex_mode: 'trisect', horizontal_spacing: 'small',
      columns: [
        metricColumn('当前状态', statusLabel, resolved ? '指标已回落' : '需要关注'),
        metricColumn('信号数量', String(totalCount), payload.truncatedAlerts ? `另有 ${payload.truncatedAlerts} 条被截断` : '本次通知'),
        metricColumn(resolved ? '恢复耗时' : '已持续', durationText(earliest, durationEnd), resolved ? '从触发到恢复' : '从首次触发起'),
      ],
    },
    { tag: 'hr' },
    ...shown.flatMap((alert, index) => index === 0
      ? [alertBlock(alert, index, nowMs, resolved)]
      : [{ tag: 'hr' }, alertBlock(alert, index, nowMs, resolved)]),
  ];

  if (totalCount > shown.length) {
    elements.push({ tag: 'markdown', content: `> 还有 ${totalCount - shown.length} 条信号未在卡片中展开，请进入看板查看完整列表。`, text_size: 'caption' });
  }

  const grafana = validHttpUrl(options.grafanaBaseUrl);
  const dashboardUid = all.find((a) => a.annotations?.dashboard)?.annotations?.dashboard || DASHBOARD_UIDS[category];
  if (grafana && dashboardUid) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'button', text: { tag: 'plain_text', content: '打开对应监控看板' }, type: 'primary_filled', width: 'fill',
      behaviors: [{ type: 'open_url', default_url: `${grafana}/d/${encodeURIComponent(dashboardUid)}` }],
    });
  }

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: `${resolved ? '已恢复' : severityLabel} · ${categoryLabel} · ${totalCount} 个信号` },
      style: {
        text_size: {
          title: { default: 'heading-2', pc: 'heading-2', mobile: 'heading-3' },
          body: { default: 'normal', pc: 'normal', mobile: 'normal' },
          caption: { default: 'notation', pc: 'notation', mobile: 'notation' },
        },
      },
    },
    header: {
      title: { tag: 'plain_text', content: `${resolved ? '告警恢复' : severityLabel + '告警'} · ${categoryLabel}` },
      subtitle: { tag: 'plain_text', content: `${env} · ${dateText(nowMs, timeZone)}` },
      template,
      text_tag_list: [
        { tag: 'text_tag', text: { tag: 'plain_text', content: statusLabel }, color: resolved ? 'green' : severity === 'critical' ? 'red' : severity === 'warning' ? 'orange' : 'blue' },
        { tag: 'text_tag', text: { tag: 'plain_text', content: categoryLabel }, color: 'neutral' },
      ],
    },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px', vertical_spacing: 'medium', elements },
  };
}

/** 纯文本只保留为兼容/故障排查用；实际告警默认走 formatAlertCard。 */
export function formatAlertText(payload: AmWebhookPayload): string {
  const alerts = payload.alerts ?? [];
  const firing = alerts.filter((a) => a.status !== 'resolved');
  const resolved = alerts.filter((a) => a.status === 'resolved');
  const head = payload.status === 'resolved'
    ? `✅ 告警恢复：${payload.groupLabels?.alertname ?? payload.groupLabels?.category ?? ''}`
    : `军师告警：${payload.groupLabels?.alertname ?? payload.groupLabels?.category ?? ''}（${firing.length} 条）`;
  const line = (a: AmAlert) => `[${a.labels?.severity ?? 'info'}] ${a.annotations?.summary ?? a.labels?.alertname ?? '(无描述)'}`;
  return [head, ...firing.map(line), ...(resolved.length ? ['— 已恢复 —', ...resolved.map(line)] : [])].join('\n');
}
