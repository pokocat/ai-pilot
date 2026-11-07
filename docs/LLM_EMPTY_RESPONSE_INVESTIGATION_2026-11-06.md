# OneToken 两次空正文调查

## 后续修复（2026-11-07）

已实现初始正文同步快照、异常结束时保留部分正文并标 truncated、有限流事件诊断及失败 usage 透传/记录；见 `server/test/claudeStream.test.ts` 和 `server/test/claudeStreamPersistence.test.ts`。本次修复不代表两条历史请求的内部原因已能还原，也不修改历史结算。验证与发布结果以 `docs/CHANGELOG.md` 的本次条目为准。

先只读调查历史请求、数据库、日志和已部署源码；随后经用户明确授权，执行 1 次无业务数据、最大输出 256 token、费用上限 ¥0.05 的真实流式诊断。模型配置、失败任务和既有账务均未修改；没有重放用户请求。

## 已确认的故障位置

军师版本 `bac6de0556b1fe90ba46a480b9d143e40f21302a` 的 Claude adapter 在流消费结束后由 `requireText(text, usage, 'chat_stream')` 抛出 `AI_EMPTY_RESPONSE`。两单的 `GenerationJob.partialText` 长度均为 0；不存在已经写入任务、只是小程序没有显示的正文。

两次请求使用同一个会话和端点 `OneToken · Claude Opus 5`（`https://api.onetoken.love`，Anthropic 兼容协议）。以下时间采用原始日志的 UTC，便于供应商检索。

| 时间 UTC | 调用耗时 | adapter 报告的 output token | 上游响应头请求 ID | trace ID |
| --- | ---: | ---: | --- | --- |
| 2026-11-06 03:45:18.834 | 36,063 ms | 2,280 | `8d5008b1-a992-4f7e-b39b-4545d269aba2` | `cmw4flr7673pp122r0cxaemxp` |
| 2026-11-06 03:49:35.395 | 9,225 ms | 357 | `014a554d-035d-409f-8df6-425f7f89e39b` | `cmw4fr95v70dh10nwbzurhmp3` |

响应头请求 ID 与 OneToken 用户账单中的 `client:` 请求 ID 不同，需一并提供给供应商，不能套用此前七牛的账单索引规则。

## 供应商账单交叉核对

通过用户已登录的 `https://onetoken.love/usage`，按「军师」密钥筛选，已匹配两次失败的完成时间、输出 token 和 SDK 版本（Anthropic/JS 0.32.1）。只读查看本次页面实际使用的 `/api/v1/usage` 响应；该用户接口不含原始 SSE、stop reason、content block 类型或服务端路由诊断。

| trace 输出 token | OneToken usage ID | OneToken 账单 request ID | 上游耗时 | 首事件耗时 | 实际成本字段 USD | 页面人民币费用 |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2,280 | 1055667 | `client:7ec9d410-53a1-4480-840d-40f99aec854c` | 35,505 ms | 5,678 ms | 0.00915138 | ¥0.061314 |
| 357 | 1055922 | `client:871f1215-9574-44b4-9b00-e3cf62f3c07e` | 8,508 ms | 6,791 ms | 0.004261845 | ¥0.028554 |

两单页面费用合计 ¥0.089868。供应商存在用量/收费记录，仍不代表其返回了可见正文；所谓首 token 时间也不能等同于用户首个正文字符。

失败后的两个后续任务 `cmw4fltrt73qf122r70lc1hwm`、`cmw4frekn74f2122rs08fsdza` 使用各自相同的用户问题，均完成；system prompt hash 相同，但重提后历史里多了一条前次 user 消息，因此不是字节级相同请求。此事实削弱了「问题文本必然导致失败」的解释，不能排除模型或上游的偶发行为。均为历史客户端请求，本次没有代用户再次提交。

## 单次真实诊断

授权后通过已部署同版 adapter 的独立进程、同一端点和 SDK fetch shim 发出 1 次请求；测试句不含业务内容，出站体强制 `max_tokens=256`、`thinking.type=disabled`，禁止第二次网络调用。只输出事件计数和用量，不记录思考正文。

- 响应头 request ID：`68969bce-7351-46f2-9425-8a0752882593`；OneToken usage ID `1114924`，账单 request ID `client:5cf73c08-f051-4819-b7b0-c782bbe0ab1a`。
- HTTP 200；事件为 message_start / ping / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop，各 1 次。
- content block 为 text，text_delta 1 次、7 字，stop reason 为 end_turn；输出 12 token，thinking token 为 0，同版 adapter 最终也取得 7 字。
- 输入为 2 未缓存 token + 2,627 缓存创建 token；实际成本字段 USD 0.0017565187，页面费用约 ¥0.01177，低于 ¥0.05。使用标准业务提示词组装器引入了额外固定系统说明，因此不应按测试句长度估算全部输入。

这证明当前普通请求链路可正常工作，不能据此证明两次历史异常已经修复。

## 同版解析器的离线回放

本机 Node 24.21.0，以 fetch 注入口喂合成 SSE，`poolBypass=true`、数据库指向不可用诊断地址、Redis 关闭；没有真实网络调用。通过 devq 任务 `f9226a33a8cd` 执行，退出码 0，7/7 场景符合断言。

| 合成流形态 | 当前 adapter 结果 |
| --- | --- |
| 标准 text_delta + message_stop | 成功，逐字和最终正文一致 |
| 只有 content_block_start 内的 text + message_stop | 成功，finalMessage 兜底可取正文 |
| 只有 content_block_start 内的 text，缺 message_stop | **误报 AI_EMPTY_RESPONSE，SDK 累积过的正文丢失** |
| 有 text_delta，缺 message_stop | 成功，已收 delta 保住正文 |
| 只有非文本 thinking block | AI_EMPTY_RESPONSE |
| 只有空白 text_delta | AI_EMPTY_RESPONSE |
| text block 为空，无正文 delta | AI_EMPTY_RESPONSE |

已复现的代码缺陷是 `stream.finalMessage().catch(() => null)` 吞掉结束标记缺失等错误，而 adapter 没有独立保存 content_block_start 的初始正文或流中的 SDK 快照。SDK 0.32.1 只在 message_stop 时将快照加入 receivedMessages；缺失结束标记时 finalMessage 拒绝，即便流中 SDK 曾累积到 text。SDK 在结束请求时还会清掉 currentMessage，因此不能只在循环结束后读取它来修复。它不是「所有缺 message_stop 的流都会丢字」：有 text_delta 的场景仍保留已读正文。

**该合成场景证明本地存在可制造假空回复的兼容边界，尚不能证明两次历史请求就是该形态。** 原始流不存在，必须继续区分 SDK/adapter 假空与上游真正无文本，不能将复现案例替代历史证据。回放脚本和输出保存于本机 `.deploy-logs/empty-response-investigation-20261107/`，不含凭证或用户请求正文。

## 已排除与尚未确认的部分

- 已部署 `src/llm/providers/claude.ts` 和 `src/llm/thinking.ts` 的 SHA256 与当前工作区一致。端点 `thinkingMode=disabled`、`dialect=anthropic_gateway`、温度 0.7，能力记录没有 `thinking=no` 覆盖；按这套源码会显式发送 `thinking: {type:'disabled'}`，正文预算为 8000。
- adapter 同时处理标准 `text_delta` 和最终 `Message.content` 中的 `text` block 兜底。最终仍为空，故问题范围在供应商返回、兼容流格式、SDK 累积及 adapter 提取这一段，不能归因于前端渲染或数据库丢失。
- 两次报错不是本地首正文/中途空闲看门狗的错误，也不是本地已识别的 `max_tokens` 耗尽分支。不能因此排除供应商自身的预算、过滤或内部异常。
- 输出 token 不等于可见正文；Anthropic 流中的正文与思考分属不同事件类型，见 [官方流式协议](https://platform.claude.com/docs/en/build-with-claude/streaming)。仅凭 2280 / 357 的计数不能证明模型只生成了思考。
- 历史 trace、任务与应用日志未保存原始 SSE、事件类型计数、最终 content block 类型、stop reason 或 `finalMessage()` 失败原因（源码会将该异常转为 null）。因此不能进一步确定是上游确实返回空内容、仅非文本内容、兼容协议丢正文，还是最终消息累积失败；离线回放仅证明最后一类可以产生相同报错。

## 错误收口与用量事实

原始错误先写入 `llm_trace`，随后 `chatCompleteStream()` 在尚未发出可见内容且未启用 mock 兜底时，将它包装为 `AI_UNAVAILABLE`。两单终态因此为 failed / AI_UNAVAILABLE，没有自动再次调用同一网关。

错误 trace 的 catch 没有传 usage，所以落库 input/output token 都是 0；错误消息中的 2280 / 357 才是 adapter 当时看到的输出计数，不能把 trace 的 0 理解为供应商没有消耗。Worker 在 provider 已调用、真实 usage 未透传时按既有保守估算结算：

| generation ID | 额度消耗 | usageSource | 说明 |
| --- | ---: | --- | --- |
| `cmw4fkyai73oo122rlwzw8a9y` | 18,292 token | estimated | 含意图分类失败的 462 token 估算与主调用的 17,830 token 估算 |
| `cmw4fr1tf74cz122r58sbizqm` | 17,983 token | estimated | 主调用估算 |

合计 36,275 token 额度；两单钻石预留均为 0。本次未改写结算或发起补偿。

## 下一步取证

供应商需要按上述两组请求 ID 提供历史响应事件类型、content block 类型和 stop reason；当前用户账单接口没有这些信息。代码侧修复应保留 finalMessage 的异常、事件计数和已见 usage，并在流中保留初始正文/最近快照，不能依赖结束后已清理的 currentMessage。已取得 text 但流未完整结束时，只能按不完整结果处理，不能直接标 completed。继续验证错误包装后的 usage 透传，以及 provider/trace/Worker 结算。相关缺口已登记在 `docs/agents/13-todo.md`；本次未实施生产代码修复或发布。
