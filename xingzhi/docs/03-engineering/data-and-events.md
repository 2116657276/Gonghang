# 数据与事件设计

| 字段 | 内容 |
| --- | --- |
| 文档编号 | XZ-DATA |
| 更新日期 | 2026-09-06 |
| 状态 | P0 逻辑模型已确认；未创建数据库或迁移脚本 |

## 一、事实分层

会话保存用户与模型交流；业务库保存计划、授权、订单和操作；渠道证据保存查询与通知依据。三者关联但互不替代。下面是逻辑实体，不锁定 ORM 或数据库产品。

| 实体 | 最少字段 | 约束 |
| --- | --- | --- |
| Plan / PlanItem | id、ownerId、目的、类别、依赖、状态、version | 依赖有方向，不能反向取消明确保留项 |
| CatalogQuote | 商品、商户、价格、币种、规则引用、expiresAt | 确认及创建订单前校验有效性 |
| Authorization | id、planId、owner、类型（购买／善后／查询）、对象范围、购买上限或可接受费用、期限、状态、version、confirmationId | 购买、善后和查询用途分开；善后授权只能引用既有订单 |
| Proposal / Confirmation | 方案快照、版本、摘要、费用、确认人及时间、authorizationId | 确认人由服务端绑定；确认创建对应不可变授权；不能模型自填 |
| MerchantOrder | 商户、用户、商品快照、金额、环境、状态 | 订单号在商户和环境范围唯一 |
| PaymentAttempt | 原单、业务支付号、渠道交易号、金额、状态、占用 | 未知重试复用同一业务号 |
| CancellationRequest | 原单、确认关联、规则版本、决定及理由 | 用户申请与商户批准分开 |
| RefundOperation | 原支付、业务退款号、金额、状态、退款占用 | 商户与环境内退款号唯一；金额变动不可沿用原请求 |
| BusinessOperation / Job | 类型、业务对象、状态、幂等键、参数摘要、nextRunAt、领取版本 | 同一作用域的幂等键唯一；接管不能重复业务动作 |
| ChannelEvidence | 原始状态、证据类型、关联号、发生及收到时间、核验结果 | 秘密字段不进入日志与导出；访问受限 |
| Event / AgentRun | 事件号、对象序号、关联运行、动作、版本、来源 | 业务事件追加；AgentRun 不决定资金状态 |

所有交易实体均带环境和创建／更新时间。环境参与唯一约束，防止模拟数据命中沙箱对象。核心金额使用整数分且非负，费用与报价、实付与退款分别保存。

## 二、事务与任务

确认接口原子保存确认事实与后续操作；购买准入原子校验授权及预算并写占用；退款准入原子校验可退金额并写占用。对外请求在提交之后发出。使用事务性待发送记录或等价机制，避免只写订单没写任务。

执行者领取任务有到期时间与领取版本。旧执行者回写须检查领取版本；重复调用仍由固定业务编号约束。崩溃发生在外部调用之后时，接管者先查询原操作；不能认为本地未保存结果就等于渠道未执行。

## 三、事件与去重

建议事件类型为 PurchaseConfirmed、OrderCreated、PaymentObserved、PurchasesPaused、ChangeConfirmed、CancellationDecided、RefundObserved、ReconciliationRequired 和 OperationResolved。每项事件包含 eventId、aggregateId、aggregateVersion、occurredAt、receivedAt、correlationId、环境与脱敏负载。

事件投递可能重复与乱序；消费者按事件标识去重，业务对象按合法转换核验。原始通知通过签名与字段检查后关联处理记录，重复通知不能重复记账。补发旧付款事实不允许把已退款业务状态降回仅已付款。

## 四、恢复、保存与删除

启动后扫描非终态操作，按 nextRunAt 恢复核查；会话按 planId 与 runId 重建，不批量重放历史写工具。界面通过业务快照加事件游标恢复，不依赖内存聊天流。

保存期限、备份周期和数据清理权限为实施前开放项。只删除经确认的测试数据；删除会话不自动删除交易记录，注销与授权撤回的保存边界需单独定义。不在 Markdown 中记录真实账号、密钥或完整回执。

[领域规则](../02-domain/rules-and-state.md) · [运行与保护](../04-quality/operations.md)
