# 商业化整改进展与交接(2026-07-23)

> 依据《正式售卖前整体体检报告》(文档1)执行。分支 `feat/commercialization-remediation`,五批代码整改全部 **647/647 测试通过**,已部署 preprod(`https://wxapi.aibuzz.cn/api_preprod`,SHA `ebaa5c4`)并验证健康。生产未动。

---

## 一、已完成的代码整改(A 类,已测试 + 部署 preprod)

| 批次 | 项 | 关键改动 |
|---|---|---|
| 1 | 微信商户后台退款闭环 | `wechatPay.markRefundNotified`:REFUND 回调对仍 `applied` 的订单补齐权益回收+置 refunded,幂等、仅全额退款、部分退款留人工 |
| 1 | SKU 账本加锁 | `purchase.applySkuGrant` 备注流水补 `credit:` advisory 锁,防并发扣钻竞态 |
| 1 | 密钥错配→静默 mock 防护 | `secretBox.decryptFailed` + `aiConfig` 记 error 日志 + `gateway.assertKeyHealthy` 在 `AI_FALLBACK_MOCK=false` 下抛 `AI_UNAVAILABLE` |
| 1 | sanitize 正则收窄 | 剔除 README/IDE/代码库等宽泛词,止 SaaS/开发者客户报告被误判换模板 |
| 1 | degraded 退钻石 | `sessions.settleCreditForDeliverable`:降级产出退 token 也退钻石,两轴对齐 |
| 1 | 体验版额度改回 | `seedConfig` 10M→**20 万**;preprod DB 已生效(实测 200000) |
| 1 | 热点表索引 | `audit_log(userId,action,createdAt)`+`(createdAt)`、`credit_ledger(userId,createdAt)` |
| 1 | 健康检查加 DB ping | `/health` 探 DB,挂→503(preprod 实测 `{"ok":true,"db":"up"}`) |
| 1 | claude 超时/重试 | client `maxRetries` + 流式调用补 timeout |
| 1 | 优雅停机 + 全局兜底 | `index.ts`:SIGTERM→停 scheduler→`app.close()`→`$disconnect`;unhandledRejection/uncaughtException 落 error 日志 |
| 1 | 超时文案 | `AI_UNAVAILABLE` 透传「响应超时/暂不可用」,不再吞成通用报错 |
| 2 | 辅助调用计量 | `usage.recordAuxUsage`:洞察/预言/势研判/履历/汇总/图谱等 rawText 系补记 `kind='aux'` token_usage,消除成本盲区 |
| 2 | 全站限流 | `@fastify/rate-limit` 全局 300/min/IP(跳过 /health、测试不启用) |
| 2 | 注册防薅 | `/auth/sms/send` 10/5min/IP、`/auth/login` 20/10min/IP |
| 3 | 输出侧内容审核 | `moderation` 输出侧 fail-closed;`gateway` 报告与非流式对话返回前审核,命中抛 `MODERATION_BLOCK` |
| 4 | 前端合规脚手架 | 协议/隐私/退款三页(占位文本【待法务替换】)、登录必须勾选同意、设置页跳转+客服入口 |
| 4 | AI 生成标识 | 对话页「内容由 AI 生成,仅供参考」+ 报告页脚「本内容由人工智能生成」 |
| 5 | 断连即停生成+退费 | SSE 监听 `close`;对话流式断连 break(取消 provider 流)+退预留、不持久化残缺回复;报告 section 断连停送 |

---

## 二、B 类:生产配置(待你执行,均为可直接跑的命令)

> 前提:先按 [[prod-deploy-method]] 用 `scripts/deploy-prod.sh` 发本分支代码到生产。**注意 deploy-prod 从不跑 db:seed**,所以额度改动在生产要手动 UPDATE(见下),不像 preprod 会自动 seed。发布前先 `git log --oneline --since=<prod src mtime> main` 亮明连带发什么。

**1. 设 `NODE_ENV=production`(收回被架空的沙箱护栏/SMS 屏蔽/安全告警)**
```bash
# systemd 单元加一行 Environment,或 prod .env 加 NODE_ENV=production
sudo sed -i '/^\[Service\]/a Environment=NODE_ENV=production' /etc/systemd/system/junshi-api.service
sudo systemctl daemon-reload && sudo systemctl restart junshi-api
```

**2. 修 temperature 冲突(0.7 与 Opus thinking 冲突致 400,当下在吞用户产出)**
```bash
sudo -u junshi psql -d junshi -c "UPDATE ai_setting SET temperature=1 WHERE id='default';"
sudo systemctl restart junshi-api   # ai_setting 有 4s 缓存,重启即时生效
```

**3. 生产体验版额度改 20 万 + 刷存量钱包**
```bash
sudo -u junshi psql -d junshi -c "UPDATE plan SET \"tokenQuotaPerMonth\"=200000 WHERE name='体验版';"
# 刷已有免费钱包(脚本从 seedConfig 读目标=200000);先 DRY 再 --apply
sudo -u junshi env HOME=/home/junshi bash -c "cd /opt/junshi/server && npm run db:bump-free-quota"
sudo -u junshi env HOME=/home/junshi bash -c "cd /opt/junshi/server && npm run db:bump-free-quota -- --apply"
```

**4. 数据库定时备份(P0,消掉最大不可逆风险)** —— 建 systemd timer 每日 pg_dump + 传 OSS:
```bash
# /etc/systemd/system/junshi-pgdump.service + .timer(示意,按实际路径/OSS 凭据补全)
sudo tee /etc/systemd/system/junshi-pgdump.service >/dev/null <<'EOF'
[Service]
Type=oneshot
User=junshi
ExecStart=/bin/bash -c 'pg_dump junshi | gzip > /var/backups/junshi-$(date +%%F).sql.gz'
# TODO: 再加一步 ossutil cp 到异地 bucket + 保留策略(如保 14 天)
EOF
sudo tee /etc/systemd/system/junshi-pgdump.timer >/dev/null <<'EOF'
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
sudo mkdir -p /var/backups && sudo chown junshi /var/backups
sudo systemctl daemon-reload && sudo systemctl enable --now junshi-pgdump.timer
# 首次手动验证一次能 dump + 能恢复(在测试库 restore)。
```

**5. SSL 自动续期(证书 9/1 到期,手动放置无续期)** —— 上 acme.sh 或 certbot,设 nginx reload 钩子。

**6. 监控告警最小集** —— 阿里云云监控加:站点 uptime 探活(`/api/health` 判 `db:up`)、证书到期、磁盘水位;应用侧「paid 未 applied」资损可加一条定时 SQL 巡检告警。

**7. 限流为多实例准备(可选,横向扩前)** —— 当前 rate-limit 用内存 store(单实例有效),多实例需接 Redis store(见分布式架构方案 Phase 1)。

---

## 三、C 类:只有你能办(我只能给清单)

- [ ] **微信支付六件套凭据**:MCHID / APIV3_KEY / CERT_SERIAL / PRIVATE_KEY / NOTIFY_URL / 平台证书,配进生产 `.env` 后 `/order` 才从 501 转正常;配平台证书后回调验签才 fail-closed。配齐后用真实小额跑通 created→paid→notify→applied→退款。
- [ ] **生成式 AI 备案 + 算法备案 + 小程序「深度合成/AI问答」类目**(用第三方模型也要,你即服务提供者)。关键路径 ~1 个月,**先启动**。
- [ ] **ICP 备案**(aibuzz.cn),主体须与小程序主体/支付商户一致;经营性 ICP 是否必办按属地通管局核实。
- [ ] **法务正文**:替换 `app/src/packages/main/legal/index.tsx` 里三份文档的【待法务替换】占位;登录勾选、可点页面、客服入口的骨架已就绪。
- [ ] **微信《小程序隐私保护指引》** 在小程序后台配置 + 接 `wx.requirePrivacyAuthorize`(不配则头像/手机号接口会失败;这是上架硬要求。前端协议页已做,授权接口待接——需先在后台配好指引)。
- [ ] **发票通道**:先「客服登记+人工开票」兜底,再接电子发票。
- [ ] **内容审核真实服务**:当前 provider 默认 `keyword`(仅演示词)。接真实合规审核服务并 `MODERATION_PROVIDER=http`+`MODERATION_API_URL`;输出侧已 fail-closed。日志留存≥6 个月。

---

## 四、本轮未做 / 降级 / 边界说明(诚实交代)

- **断连停生成——报告路径部分覆盖**:对话流式已完全处理(停生成+退费)。报告(deliverable)是单次 await 生成,无法中途 abort(需把 AbortSignal 深挖进 provider,风险高);已做「断连停 section 流式」,但报告 token 已产生,且报告落库可回看,故计费不变。
- **原生流式对话输出审核**:token 已逐个下发无法事后撤回,不做拦截式输出审核(报告与非流式对话已 fail-closed 审核;若监管要求流式正文也审,关掉对话原生流式走 fallback 即纳入,详见 gateway 注释)。
- **Dify 计量**:未补(生产走 qnaigc openai 路径,无 Dify 计费路径)。若启用 Dify 需另补。
- **provider 重试**:claude 已设 `maxRetries` + timeout;未加独立熔断器(有界重试足够,熔断留后续)。
- **PDF 元数据隐式标识**:仅做了显式「本内容由人工智能生成」;文件元数据隐式水印留 TODO(reportHtml 注释已标)。

---

## 五、上生产前的验证顺序(建议)

1. preprod 已部署本分支——在真机端到端过一遍:登录勾选、协议/隐私/退款页、客服入口、对话与报告(含 AI 标识)、断连退费。
2. 生产接微信支付六件套后,preprod/生产用真实小额跑通支付+退款全链路(含商户后台退款回收权益这条新路径)。
3. B 类 1–4 项(NODE_ENV / temperature / 额度+bump / 备份)先于开卖完成。
4. C 类备案启动(关键路径)。
5. 全绿后合并 `feat/commercialization-remediation` → main,发布生产。
