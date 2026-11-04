# 统一身份最终发布验收（2026-10-10）

身份代码efafbcaa；最终发布b9886f49（剔除无关网关注释记录）。/opt/junshi/server和/opt/junshi-quickreel/server两实例均已部署，junshi-api与junshi-quickreel active，公网health DB up。未发布无关admin/H5或工作区开发内容。

## 实现及门禁

已关联UID同步合法完整手机/昵称/头像，拒绝错误主体和验证状态；窄条件写入与UID锁/事件时钟保护旧资料不倒灌。后台取消最新300截断。新增持久identity_subject墓碑、identity_outbox_cursor及identityTokenVersion，生命周期撤销旧内部JWT；首登前关闭/合并不复活UID。

中心登记quickreel-server，产品quickreel、client_credentials、product.link；两实例机密配置受限，仅quickreel scheduler消费共享数据库。严格事件页校验，处理提交→合并存活UID链接确认→COMPLETED→游标；失败不跳过。注销复用既有清理/保留期，产品ID/租户/角色/钱包不搬移。

Node24编译通过；独立PostgreSQL全量2197项，2195通过、2既有跳过、0失败。

## 线上验收

隔离UID广播21–30，真实中心账号未修改。注销25/28、合并27回执COMPLETED，持久游标30。旧有效签名注销/合并令牌访问生产/api/me均401“登录状态已失效，请重新登录”。回补1个既有有效中心UID产品链接，仅PROVISIONED，不赠积分、不改授权。

备份/opt/junshi/backups/identity-sop-20261010：PG dump 72,158,010 bytes及两实例旧代码/配置。没有seed、接受数据丢失或提示词回灌；部署提示既有运营提示词漂移，保留运营配置。

快出片小程序abfc3aa开发版0.1.1已上传，正式发布/真机验收尚未完成。中心报告见../../aibuzz-id/docs/INTEGRATION-SOP-AUDIT-20261010.md。
