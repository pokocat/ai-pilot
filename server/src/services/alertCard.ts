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

const SEVERITY_LABELS: Record<string, string> = { critical: 'P1 严重', warning: 'P2 预警', info: 'P3 提示' };
const SEVERITY_RANK: Record<string, number> = { critical: 3, warning: 2, info: 1 };
const LABEL_ORDER = ['instance', 'job', 'route', 'method', 'lane', 'provider', 'model', 'phase', 'path', 'ref', 'mountpoint', 'skill', 'code', 'bucket'];
const LABEL_LABELS: Record<string, string> = {
  instance: '目标', job: '采集任务', route: '接口', method: '请求方式', lane: '调用通道',
  provider: '模型来源', model: '模型', phase: '发生阶段', path: '降级路径', ref: '审核来源',
  mountpoint: '磁盘', skill: '能力', code: '错误码', bucket: '错误类型',
};

interface AlertKnowledge { title: string; threshold: string; impact: string; action: string }
const K = (title: string, threshold: string, impact: string, action: string): AlertKnowledge => ({ title, threshold, impact, action });

/**
 * 告警的人类可读知识层。PromQL 负责「何时响」，这里负责「响了代表什么、先做什么」。
 * 规则测试会锁定每个 alertname 都有一条知识，防新增规则退化成难懂的一行指标名。
 */
export const ALERT_KNOWLEDGE: Record<string, AlertKnowledge> = {
  JunshiApiDown: K('API 服务可能离线', '连续 1 分钟无法采集 API 监控数据', 'API 进程可能退出，或监控鉴权配置不一致；应用告警转发链路也可能同时失联。', '先检查服务就绪状态，再核对 junshi-api 进程与监控鉴权配置。'),
  JunshiProbeFailed: K('服务端到端探活失败', '连续 2 分钟探活失败', '本机失败表示服务本体异常；仅公网失败通常指向网关、域名或证书。', '对照影响对象分辨本机/公网探针，依次检查 API、网关、域名与证书。'),
  JunshiTlsCertExpiringSoon: K('TLS 证书即将到期', '证书剩余有效期不足 14 天', '到期后小程序与后台 HTTPS 请求都会失败。', '检查 certbot timer、续期日志和 80/443 挑战链路，手工 dry-run 验证续期。'),
  JunshiApiP95High: K('用户接口响应变慢', '15 分钟 P95 超过 0.8 秒、样本不少于 20 次，并持续 10 分钟', '页面加载、列表读取和保存动作开始出现可感知延迟。', '从 API 看板定位最慢用户接口，再查数据库等待、CPU 与主线程响应。'),
  JunshiApiP95Critical: K('用户接口延迟严重', '15 分钟 P95 超过 2 秒、样本不少于 20 次，并持续 5 分钟', '用户操作可能大量超时，继续放量会放大排队与失败。', '停止放量，按最慢用户接口定位瓶颈；必要时限流或扩容。'),
  JunshiApi5xxRateHigh: K('用户接口错误率过高', '15 分钟错误率超过 1%、样本不少于 20 次，并持续 5 分钟', '一部分用户请求已明确失败，可能涉及多条业务路径。', '先看路由级错误 Top，再按错误码和发布时间关联服务日志。'),
  JunshiApiRateLimitedSpike: K('API 限流次数激增', '5 分钟限流响应数超过后台配置线', '正常用户可能被全站或高成本接口限流。', '确认来源 IP 或账号是否异常，再核对全局与具体接口限额。'),
  JunshiOverloadRejecting: K('服务过载并开始拒绝请求', '5 分钟内出现主动拒绝', '服务已靠快速失败自保，部分请求无法完成。', '核对在途请求数、CPU、数据库连接与流量来源，先控流再扩容。'),
  JunshiEventLoopSlow: K('API 主线程响应阻塞', '累计 P95 延迟超过 200 毫秒并持续 10 分钟', '单进程无法及时处理请求回调，所有接口都会抖动。', '排查 CPU 热点、同步计算和大文件处理；结合发布时间判断是否回滚。'),
  JunshiRssGrowing: K('API 进程内存过高', '进程常驻内存超过预警线并持续 30 分钟', '继续增长可能触发内存耗尽，导致 API 重启和生成任务接管。', '对照发布前后趋势，检查堆、缓存、上传解析与长会话对象是否释放。'),
  JunshiLlm429RateHigh: K('模型服务限流率升高', '10 分钟至少 20 次请求且限流率超过预警线', '部分生成会排队、重试或降级，首字延迟开始变差。', '按调用通道和模型来源查看限流分布，核对上游配额并收紧并发。'),
  JunshiLlm429RateCritical: K('模型服务限流严重', '10 分钟至少 20 次请求且限流率超过严重线', '生成失败和长等待将集中出现，可能影响全体对话用户。', '立即降低模型调用并发并延长重试间隔；必要时切换健康端点。'),
  JunshiLlmErrorRateHigh: K('模型调用失败率升高', '15 分钟至少 10 次调用且错误率超过 10%', '对话与方案生成可能报错或走降级内容。', '按模型来源与业务类型查看失败分布，确认鉴权、超时、协议与上游状态。'),
  JunshiAiEndpointProbeFailing: K('上游端点检测连续失败', '30 分钟内同一检测项失败 3 次以上并持续 10 分钟', '该上游的某项能力当前不可用；用户可能还没撞上，但下一次用到就会失败。', '看失败的是哪一项：连通性=网络或 Key，Thinking 写法=方言与上游对不上（换网关或改方言固化），模型范围=该 Key 没被授权这个模型。'),
  JunshiLlmAuthErrors: K('模型服务鉴权失败', '15 分钟内出现任意一次鉴权失败并持续 5 分钟', '对应模型来源的全部请求会持续失败，直到密钥或权限问题解决，不会自动恢复。', '立即核对该来源的密钥是否过期、被吊销或欠费，以及账号是否有该模型的调用权限。'),
  JunshiLlmErrorByCategory: K('模型调用按类型出现特定失败', '15 分钟内同一错误类型超过 3 次并持续 10 分钟', '不同类型影响不同：上下文超限和内容策略拒绝会让对应请求直接失败且不会自动重试；网络或过载类通常会先转移到其它端点，仍频繁出现说明兜底也在失效。', '按告警里的错误类型分别处理：上下文超限查历史裁剪与模型上限，内容策略拒绝核对触发内容或更换模型，网络/过载类检查目标端点健康状况与转移是否生效。'),
  JunshiLlmCallP95Slow: K('模型调用耗时过长', '30 分钟调用 P95 超过后台配置线', '用户首字和完整成果等待时间都会拉长，并占满并发容量。', '拆分模型来源与业务类型时延，确认是排队、模型推理还是工具调用变慢。'),
  JunshiLlmQueueWaitLong: K('模型请求排队过长', '等待峰值超过预警线并持续 5 分钟', '用户在请求真正发往模型前已经等待。', '查看调用通道并发、队列深度和上游限流，避免盲目提高本地并发。'),
  JunshiLlmQueueWaitCritical: K('模型请求排队严重', '等待峰值超过严重线并持续 5 分钟', '请求接近主动超时，用户将看到忙碌或失败提示。', '降级或暂停接单，释放非核心任务并恢复健康端点容量。'),
  JunshiLlmQueueRejected: K('模型请求排队失败', '15 分钟内出现队列满载或等待超时', '用户请求在获得模型调用容量前就失败。', '核对队列深度、并发上限、上游限流与暂停状态；先降低入口流量再调整容量。'),
  JunshiLlmCoolingLong: K('模型调用通道暂停接单', '调用通道暂停接单持续 5 分钟', '该通道暂不接单，可用模型容量下降。', '确认上游连续限流与剩余暂停时间，检查配额或切换端点。'),
  JunshiTokenCostBudget70: K('Token 日预算达到 70%', '滚动 24 小时成本超过日预算 70%', '成本进入关注区，但核心功能仍可继续运行。', '检查成本按 provider/model/kind 分布，暂停低价值自动任务。'),
  JunshiTokenCostBudget90: K('Token 日预算达到 90%', '滚动 24 小时成本超过日预算 90%', '接近硬预算，继续按当前速度消耗可能超支。', '关闭非核心自动任务，核对异常会话与输出长度，准备限额。'),
  JunshiTokenCostBudget100: K('Token 日预算已用尽', '滚动 24 小时成本达到或超过日预算 100%', '成本控制红线已突破，继续运行会扩大超支。', '立即执行成本硬停止策略，仅保留明确批准的核心调用。'),
  JunshiUsageUnreported: K('模型用量数据缺失', '1 小时内模型服务未返回完整用量数据', '不影响已经完成的对话，但成本报表可能低估实际消耗，降低对账准确性。', '按模型来源排查用量字段和协议适配，并与供应商账单核对差额。'),
  JunshiGenDegraded: K('AI 产出质量发生降级', '15 分钟内出现保底内容或模板兜底', '用户拿到的内容质量低于正常模型产出。', '按降级路径定位分支，检查模型服务可用性、错误日志与配置。'),
  JunshiChatTruncatedGivenUp: K('对话续写后仍未写完', '1 小时次数超过后台配置线', '用户实际收到不完整回答或成果。', '检查 CHAT_MAX_TOKENS、思考预算、提示词长度和续写次数。'),
  JunshiChatContinuationBusy: K('自动续写过于频繁', '1 小时自动续写次数超过后台配置线', '用户未必感知失败，但额外消耗一轮 Token 并拉长响应。', '校准输出预算与长度契约，减少不必要续写。'),
  JunshiChatStreamStall: K('对话输出中途停止', '15 分钟内出现输出长时间无响应', '用户可能长时间看不到首字，或已显示的回答中途停止。', '按模型来源和发生阶段定位，检查逐字输出协议、网关缓冲与上游连接。'),
  JunshiChatStreamFallback: K('逐字输出模式不可用', '15 分钟内出现逐字输出失败', '用户失去逐字反馈，并改为等待完整结果一次性返回。', '检查模型服务的逐字输出支持、网关响应头、代理缓冲和连接超时。'),
  JunshiChatFirstTokenSlow: K('对话首字延迟过高', '30 分钟首字 P95 超后台配置线并持续 10 分钟', '用户发送后长时间没有可见反馈，是最直接的等待体验劣化。', '对比分段时延，判断接单排队、上下文构建还是 provider 首字慢。'),
  JunshiChatPartialKeptBroken: K('中断回答可能未被保留', '已有正文的输出中断，但保全计数为 0', '已展示给用户的正文可能被错误气泡覆盖或丢失。', '检查中断终态与消息落库链路，按用户数据完整性缺陷处理。'),
  JunshiChatGenerationFailureRateHigh: K('对话生成失败率过高', '15 分钟至少 5 个任务且失败率超过 10%', '对话生成任务不能稳定完成，用户会看到失败或需要重试。', '检查生成任务终态、模型服务错误、任务接管与用量记录。'),
  JunshiChatGenerationRecovered: K('对话生成任务异常接管', '15 分钟内出现自动接管', '通常意味着 API 重启、任务长时间未完成或执行进程异常。', '关联 API 重启时间，检查模型耗时、任务心跳与接管前后的完成状态。'),
  JunshiSessionDigestCapped: K('长会话摘要已撞上限', '15 分钟内出现任意一次摘要撞顶', '军师可能无法吸收该会话后续新增事实，表现为突然忘记刚更新的信息。', '先定位受影响会话并检查摘要条目数与游标，再确认滚动压缩是否执行；必要时人工预热并复核最新事实已进入摘要。'),
  JunshiSessionDigestCompactionFailed: K('长会话摘要压缩失败', '15 分钟内出现任意一次滚动压缩失败', '摘要仍保留原游标，短期不会丢数据，但会继续逼近上限并增加后续失忆风险。', '查看该会话压缩错误与版本冲突，修复后重跑摘要预热，确认条目数回落且游标继续推进。'),
  JunshiSessionDigestUnhealthy: K('会话摘要持续未追平', '15 分钟内摘要失败或冷却累计超过 2 次', '近期回答可能缺少较早的客户事实，连续对话的理解感会下降。', '按状态区分抽取失败、冷却和撞顶，检查模型调用与摘要游标；恢复后预热受影响会话并核对追平状态。'),
  JunshiPaidNotApplied: K('已支付但权益未发放', '存在订单已支付未发放并持续 10 分钟', '用户已经付款却拿不到套餐或商品，属于直接资损与客诉风险。', '立即到运营后台订单页补账，并核查支付回调和 sweep 日志。'),
  JunshiPaySweepFailing: K('支付自动对账持续失败', '最近一轮对账失败数连续 15 分钟大于 0', '卡单无法自动收敛，支付终态可能长期不一致。', '检查微信查单响应、证书签名、网络与具体失败订单。'),
  JunshiPaySweepStopped: K('支付自动对账停止运行', 'API 运行超过 20 分钟且 15 分钟内没有执行对账', '支付回调丢失后无法主动补偿，卡单风险上升。', '检查定时任务是否启动、进程日志与支付对账锁。'),
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
  PgDown: K('数据库无法连接', '数据库连接状态连续 1 分钟异常', '大多数业务读写会失败，API 可能只剩探活可用。', '检查数据库服务、监听地址、磁盘与监控账号连接。'),
  PgLongTransaction: K('数据库存在长事务', '业务库最长事务超过 5 分钟并持续 5 分钟', '会拖住数据清理、持续持锁并放大表膨胀与阻塞。', '定位事务进程、查询与开始时间，确认后终止异常事务并修正业务边界。'),
  PgDeadlocksDetected: K('数据库检测到死锁', '1 小时内死锁次数大于 0', '至少一个事务被数据库强制回滚，用户操作可能失败。', '按时间查数据库日志和相关写路径，统一锁顺序。'),
  MonitoringTargetDown: K('监控采集目标离线', '监控目标连续 2 分钟离线', '对应指标或通知能力出现盲区，业务可能正常但监控已失真。', '按采集任务和目标地址检查容器状态、端口、配置与凭证。'),
};

function cap(value: string | undefined, max = 500): string {
  const s = (value ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Header uses plain_text: collapse metric newlines/markup so the incident reads in one glance. */
function plain(value: string | undefined, max = 80): string {
  return cap(value, max).replace(/[\r\n<>]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function alertDisplayTitle(alert: AmAlert | undefined): string {
  if (!alert) return '未命名告警';
  const alertname = alert.labels?.alertname ?? '';
  return plain(
    alert.annotations?.title
      || ALERT_KNOWLEDGE[alertname]?.title
      || alert.annotations?.summary
      || alertname
      || '未命名告警',
    48,
  );
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

function metricColumn(label: string, value: string, note: string, color?: 'red' | 'orange' | 'green' | 'blue'): CardElement {
  const displayValue = color ? `<font color='${color}'>${md(value, 80)}</font>` : md(value, 80);
  return {
    // 飞书 Card 2.0 的 column.background_style 虽在文档中声明支持 RGBA，机器人
    // webhook 实际会以 10002 拒绝 rgba(...)；保留分栏与内边距，交由默认主题着色。
    tag: 'column', width: 'weighted', weight: 1, padding: '8px',
    elements: [
      { tag: 'markdown', content: `**${md(label, 24)}**`, text_size: 'caption' },
      { tag: 'markdown', content: `## ${displayValue}`, text_size: 'title' },
      { tag: 'markdown', content: md(note, 80), text_size: 'caption' },
    ],
  };
}

function alertScope(alert: AmAlert): string {
  const labels = alert.labels ?? {};
  const pairs = LABEL_ORDER
    .filter((key) => labels[key])
    .slice(0, 5)
    .map((key) => `${LABEL_LABELS[key] ?? key}：${md(labels[key], 80)}`);
  return pairs.length ? pairs.join(' · ') : '全局信号';
}

function alertBlock(alert: AmAlert, index: number, nowMs: number, groupResolved: boolean): CardElement[] {
  const a = alert.annotations ?? {};
  const alertname = alert.labels?.alertname ?? '';
  const knowledge = ALERT_KNOWLEDGE[alertname];
  const title = a.title || knowledge?.title || a.summary || alertname || '未命名告警';
  const started = parseMs(alert.startsAt);
  const ended = parseMs(alert.endsAt);
  const resolved = groupResolved || alert.status === 'resolved';
  const duration = durationText(started, resolved && ended ? ended : nowMs);
  const severity = alert.labels?.severity ?? 'info';
  const severityColor = severity === 'critical' ? 'red' : severity === 'warning' ? 'orange' : 'blue';
  const deviation = a.excess || a.change;
  const statusValue = resolved ? '已恢复' : deviation || '已超限';
  const statusNote = resolved
    ? '已回落至告警线内'
    : a.excess ? '超过告警线' : a.change ? '较上一周期' : '达到告警触发条件';
  const lines = [
    `**${index + 1}. ${md(title, 120)}**  <text_tag color='${resolved ? 'green' : severityColor}'>${resolved ? '已恢复' : md(SEVERITY_LABELS[severity] ?? 'P3 提示', 16)}</text_tag>`,
    `**现象**　${md(a.summary && a.summary !== title ? a.summary : title, 600)}`,
    `**业务影响**　${md(a.impact || knowledge?.impact || '需结合对应看板确认影响范围', 600)}`,
    `**处置建议**　${md(a.action || knowledge?.action || '先看趋势与关联日志，再决定是否升级处置', 600)}`,
    `**影响对象 / 持续时间**　${alertScope(alert)}　·　${duration}`,
  ].filter(Boolean);
  return [
    { tag: 'markdown', content: lines.join('\n'), text_size: 'body' },
    {
      tag: 'column_set', flex_mode: 'trisect', horizontal_spacing: 'small',
      columns: [
        metricColumn('当前指标', a.current || '见实时指标', resolved ? '恢复时记录' : '本次触发值'),
        metricColumn('告警条件', a.threshold || knowledge?.threshold || '条件型告警', '触发口径'),
        metricColumn('超限状态', statusValue, statusNote, resolved ? 'green' : severityColor),
      ],
    },
  ];
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
  const severityLabel = SEVERITY_LABELS[severity] ?? '提示';
  const template = resolved ? 'green' : severity === 'critical' ? 'red' : severity === 'warning' ? 'orange' : 'blue';
  const primaryAlert = shown[0] ?? all[0];
  const primaryTitle = alertDisplayTitle(primaryAlert);
  const primaryCurrent = plain(primaryAlert?.annotations?.current, 60);
  const headerTitle = totalCount > 1
    ? `${primaryTitle}等 ${totalCount} 条关联告警${resolved ? ' · 已恢复' : ''}`
    : `${primaryTitle}${resolved ? ' · 已恢复' : ''}`;
  const headerSignal = totalCount === 1
    ? `当前：${primaryCurrent || statusLabel}`
    : `${totalCount} 个关联信号`;
  const summary = resolved
    ? `${categoryLabel}告警已经恢复，共 ${resolvedAlerts.length || all.length} 个信号回到正常范围。`
    : `${categoryLabel}出现 ${firing.length} 个正在触发的信号，其中最高等级为${severityLabel}。`;

  const elements: CardElement[] = [
    { tag: 'markdown', content: `**结论**　${md(summary, 300)}\n${md(env, 80)} · ${md(dateText(nowMs, timeZone), 80)}`, text_size: 'body' },
    {
      tag: 'column_set', flex_mode: 'trisect', horizontal_spacing: 'small',
      columns: [
        metricColumn('当前状态', statusLabel, resolved ? '指标已回落' : '需要关注', resolved ? 'green' : severity === 'critical' ? 'red' : severity === 'warning' ? 'orange' : 'blue'),
        metricColumn('信号数量', String(totalCount), payload.truncatedAlerts ? `另有 ${payload.truncatedAlerts} 条被截断` : '本次通知'),
        metricColumn(resolved ? '恢复耗时' : '已持续', durationText(earliest, durationEnd), resolved ? '从触发到恢复' : '从首次触发起'),
      ],
    },
    { tag: 'hr' },
    ...shown.flatMap((alert, index) => index === 0
      ? alertBlock(alert, index, nowMs, resolved)
      : [{ tag: 'hr' }, ...alertBlock(alert, index, nowMs, resolved)]),
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
      summary: { content: `${severityLabel} · ${primaryTitle} · ${statusLabel}` },
      style: {
        text_size: {
          title: { default: 'heading-2', pc: 'heading-2', mobile: 'heading-3' },
          body: { default: 'normal', pc: 'normal', mobile: 'normal' },
          caption: { default: 'notation', pc: 'notation', mobile: 'notation' },
        },
      },
    },
    header: {
      title: { tag: 'plain_text', content: headerTitle },
      subtitle: { tag: 'plain_text', content: `${severityLabel} · ${categoryLabel} · ${headerSignal}` },
      template,
      text_tag_list: [
        { tag: 'text_tag', text: { tag: 'plain_text', content: severityLabel }, color: severity === 'critical' ? 'red' : severity === 'warning' ? 'orange' : 'blue' },
        { tag: 'text_tag', text: { tag: 'plain_text', content: statusLabel }, color: resolved ? 'green' : 'neutral' },
        { tag: 'text_tag', text: { tag: 'plain_text', content: env }, color: 'neutral' },
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
