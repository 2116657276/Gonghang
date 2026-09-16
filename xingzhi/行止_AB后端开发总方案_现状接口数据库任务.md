# 行止消费者产品：A/B 后端开发总方案

> 2026-09-16 实施更新：001—028、A00—A06 与 B00—B07 已进入当前代码基线，M1 受控 simulation 原范围目标套件已有 69/69 记录；模型费用测试隔离修复已应用，但本工作区尚待重新执行完整套件确认。第 11 节为本次审核后的补充收口契约，待实施和 HTTP 验收，通过前暂停 M2。已有 simulation 领域检查覆盖报价、购买意图、本人确认、订单、支付、意外调整、取消退款、到账事实和预算事件；新 Agent 只保存非执行草稿。统一前端、真实银行与新流程支付宝沙箱连续演示仍待 M2/M3。当前本机 A00 资金样例尚未加载，详细证据见 [验证记录](docs/04-quality/verification.md)。

更新日期：2026-09-16。本文只整理现状和开发任务，不表示本文所列业务 API 已经部署到真实银行或对外开放。本阶段先完成后端，前端在 M2 按冻结契约统一联调。本文同时作为 A/B 的实施分工和交接基线；遇到旧实现与本文冲突时，先保留历史交易可读与善后能力，再按本文为新消费者流程增加独立路径，不用兼容名义绕过资金准入、本人确认或来源边界。

## 1. 项目要做什么

唯一主要使用者是消费者。用户录入月度生活费、必要开支、储蓄目标和自定义每日消费项目及**自己的估价**；AI 在财务事实约束下提出安排和调整草案。对于可购买项目，系统取得**渠道报价**，算出与估价的差额和逐日资金风险；消费者明确确认后才建单并进入支付。意外支出出现时，系统重新评估、给出可调整选项，经用户确认后处理延期、替换、取消、退款，最终复盘实际储蓄结果。

演示主线：可支配 ¥2,000，拟存 ¥500，必要开支 ¥900，可调计划 ¥400，静态缓冲 ¥200；**晚餐估价 ¥80 已包含在 ¥400 可调计划中**，其渠道报价 ¥99，增量 ¥19，缓冲变 ¥181；再发生 ¥400 意外支出，静态缺口 ¥219。**实际准入还必须逐日计算**，不能仅用这些月末数字判断是否能支付。健康目标仅为用户自述规划约束，AI 不提供诊断。商户/渠道/平台仍有受控报价、支付、退款责任，但不设新的消费者可见“商户管理员”产品角色；真实工行账户、真实商户合作、自动扣款均不声称已接入。

## 2. 目前已经完成什么、尚未完成什么

| 领域 | 已完成的事实 | 仍缺少的部分 |
| --- | --- | --- |
| 数据库 | 本机 PostgreSQL `xingzhi_dev` 已应用 001–028；020 扩展新预算周期 operation/refund 范围，027 补人工任务范围，028 增加消费者 Agent 运行范围 | 未做真实银行数据审计；支付宝沙箱连续链留在 M3 |
| 历史交易 | Fastify 的旧计划/目录/订单/授权/Agent/Worker/支付宝沙盒流程存在；本机历史订单 24 条，增量迁移前后按原字段逐行一致 | 旧建单只检查旧计划购买上限，**没有**新月度资金准入；旧 Worker/Agent 不认识新预算周期及新订单形状 |
| 共同契约 | `packages/contracts/src/consumer-backend.ts` 已导出严格的请求/响应校验、状态枚举和 TypeScript 类型；A00—A06、B00—B07 路由及内部端口已接通 | 前端尚未消费新契约 |
| 产品规划 | 已确定消费者目标、估价/报价分离、月度目标、逐日现金流、意外调整、安全确认和 A/B 模块界线；B02 需求／预算草稿、B03—B07 交易与恢复边界已落入 API | 前端尚未消费新契约；真实银行和新流程支付宝沙箱连续链仍未验证 |
| 验证 | 迁移器已应用 001—028；回滚探针验证账户/周期版本、Demo 报价过期和新旧订单边界；契约/服务端类型检查通过；原范围目标套件已有 69/69 记录，隔离修复后的本工作区复跑待确认 | 真实银行、前端连续流程、支付宝沙箱新消费者链和新版 N 案例仍未验证 |

2026-09-16 只读核对：迁移 28 条、`orders` 24 行、`offer_quotes` 2 行、`finance_accounts`/`finance_account_snapshots`/`finance_ledger_entries`/`finance_obligations`/`budget_periods`/`budget_items`/`planning_drafts` 各 0 行。A00 资金样例尚未加载；当前只有迁移和 B00 Demo 报价事实。`huixiang` 已合并进本地 `jianlin` 基线；当前工作区的 B/M1 代码与文档变更不代表已经发布到远程 `main`，数据库实例、历史订单、A00 样例和本地备份也不会通过 Git 自动同步，协作者仍须在各自数据库执行 001—028 迁移并按需单独加载种子。

## 3. 技术边界与一条因果链

保持一个 Fastify 后端、一个 PostgreSQL 数据库、按领域划分代码，不为两名开发者拆成微服务。**A 是资金与预算事实的唯一所有者；B 是规划建议、目录报价、用户确认与交易编排的所有者。**B 不保存另一份“剩余余额”，A 不让模型决定可支付性。B 可用按本文定义的模拟 A 响应先开发；最终下单和意外调整必须在同一数据库事务中调用 A 的确定性准入。

```text
消费者输入 → B 接收每日目标/估价 → A 保存预算事实并算逐日风险
        → B 提出 AI 草案/商品报价 → A 预览差额与资金影响
        → 消费者明确确认 → B 与 A 同事务最终准入和建单
        → B 支付交接/核验 → A 仅按已核验流水更新资金事实
        → 意外支出 → B 生成选项、A 逐项核算 → 用户确认后调整/善后/复盘
```

资金占用只能在一处：用户估价 ¥80 已列入计划；报价 ¥99 进入购买评估时，新增影响是 ¥19；下单时原 ¥80 规划占用**转为** ¥99 订单承诺，不能形成 ¥80+¥99 两笔承诺。预计收入、待到账退款、信用额度不参加保守购买准入。支付未知时停下，不按成功处理；沙盒支付事实和银行账户流水是两类来源。

## 4. 数据库：表、字段、来源和责任

以下字段是**当前迁移的实际结构**，不是拟建字段。`UUID` 为内部 ID；金额以 `_minor` 表示分。新表金额多数是 `BIGINT`，013 及旧交易金额部分仍是 `INTEGER`。列出的 nullable 字段不等于业务可把未知当作 0。`created_at/updated_at` 均为带时区时间。

### 4.1 A 的账户和资金事实

| 表 | 当前字段（类型） | 用途与关键约束 |
| --- | --- | --- |
| `finance_accounts` | `id UUID`、`owner_id UUID`、`provider TEXT`、`account_type TEXT`、`provider_account_ref TEXT`、`masked_identifier TEXT`、`display_name TEXT`、`currency TEXT`、`source TEXT`、`status TEXT`、`authorized_at TIMESTAMPTZ`、`revoked_at TIMESTAMPTZ?`、`financial_version BIGINT`、`created_at/updated_at TIMESTAMPTZ` | 消费者授权账户目录；`provider=demo/icbc`、`type=debit/credit/loan`、`source=demo/bank_api`；不存卡号/密码；同一用户/提供方引用唯一；账户事实变动使版本递增 |
| `finance_account_snapshots` | `id UUID`、`account_id UUID`、`available_balance_minor INTEGER?`、`current_balance_minor INTEGER?`、`outstanding_minor INTEGER?`、`credit_limit_minor INTEGER?`、`as_of TIMESTAMPTZ`、`covered_through_at TIMESTAMPTZ?`、`covered_through_ref TEXT?`、`captured_at TIMESTAMPTZ`、`fact_status TEXT`、`source TEXT`、`provider_snapshot_ref TEXT?` | 保留可回溯余额基准；执行只用已授权借记账户的 `observed`、有可用余额和覆盖截止、来源匹配的快照；信用额度只展示，不加入现金 |
| `finance_ledger_entries` | `id UUID`、`owner_id UUID`、`account_id UUID`、`source TEXT`、`source_ref TEXT?`、`direction TEXT`、`amount_minor INTEGER`、`occurred_at TIMESTAMPTZ`、`posted_at TIMESTAMPTZ?`、`status TEXT`、`category TEXT?`、`merchant_name TEXT?`、`note TEXT?`、`order_id UUID?`、`dedupe_key TEXT`、`created_at/updated_at TIMESTAMPTZ` | 入账流水；`pending/posted/reversed`，同账户/来源/去重键唯一；账户来源及订单消费者归属由复合外键锁住；只有未被快照覆盖的已确认增量可补入现金基准 |
| `finance_obligations` | `id UUID`、`owner_id UUID`、`liability_account_id UUID?`、`repayment_account_id UUID?`、`obligation_type TEXT`、`label TEXT`、`period_label TEXT?`、`sequence_no/sequence_total INTEGER?`、`due_on DATE`、`amount_due_minor INTEGER`、`outstanding_minor INTEGER?`、`status TEXT`、`settled_ledger_entry_id UUID?`、`included_in_obligation_id UUID?`、`source TEXT`、`source_ref TEXT?`、`created_at/updated_at TIMESTAMPTZ` | 信用账单/贷款/分期当期应还；`source=demo/bank_api/user_input`，已包含在账单中的分期不能重复扣；包含链循环、账户类型与还款来源仍由 A 服务校验 |

A 负责受控 Demo/未来银行适配的真实性、快照覆盖游标、晚到旧快照、信用/贷款不计入现金、银行流水与订单关联、账单/分期去重。普通消费者和 Agent 不可伪造 `bank_api` 流水或“已入账余额”。

### 4.2 A 的月度预算与用户估价

| 表 | 当前字段（类型） | 用途与关键约束 |
| --- | --- | --- |
| `budget_periods` | `id UUID`、`owner_id UUID`、`primary_account_id UUID`、`baseline_snapshot_id UUID?`、`month_start/month_end DATE`、`timezone TEXT`、`savings_target_minor BIGINT`、`status TEXT`、`version BIGINT`、`closed_at TIMESTAMPTZ?`、`created_at/updated_at TIMESTAMPTZ` | 一个用户/借记账户/自然月一个周期；`draft/active/closed`；active 需要完整 observed 快照，draft 可以规划但不可购买；储蓄目标不由模型改写；关闭后保留历史和后到核验 |
| `budget_items` | `id UUID`、`owner_id UUID`、`period_id UUID`、`account_id UUID`、`kind TEXT`、`title TEXT`、`category_code TEXT?`、`planned_on DATE`、`user_estimated_amount_minor BIGINT`、`priority TEXT`、`status TEXT`、`source TEXT`、`version BIGINT`、`settled_ledger_entry_id UUID?`、`created_at/updated_at TIMESTAMPTZ` | `expected_income/essential_expense/planned_spend`；金额是用户预计值，不是成交价；`required/adjustable`，必要支出必须 required；`planned/committed/settled/cancelled`；同周期/账户/消费者复合归属、日期在本月；settled 有同账户同方向 posted 流水 |
| `budget_target_changes` | `id UUID`、`owner_id UUID`、`period_id UUID`、`confirmed_by UUID`、`previous_target_minor/new_target_minor BIGINT`、`reason TEXT`、`basis_period_version BIGINT`、`created_at TIMESTAMPTZ` | 目标调整审计；确认人必须是本人，前后值不同，原证据不可删除/改写 |

**不双写的旧结构**：013 已有 `cashflow_plans(id, owner_id, primary_account_id, basis_snapshot_id, horizon_start, horizon_end, timezone, reserve_target_minor, status, version, created_at, updated_at)` 和 `cashflow_plan_items(id, owner_id, cashflow_plan_id, line_type, label, category_code, amount_minor, due_on, source, fact_status, related_plan_id, selected_plan_item_id, settled_ledger_entry_id, created_at, updated_at)`。它们是早期 30 天方案，本机目前为空；新消费者预算只写 `budget_periods`/`budget_items`，30 日视图由自然月预算和事实派生。相邻月份还没建时相应日期返回 unknown，不把空记录说成无开支。旧空表暂留，不清库、不改已执行迁移。

### 4.3 B 的商品、报价、意图与 AI

| 表 | 当前字段（类型） | 用途与关键约束 |
| --- | --- | --- |
| `catalog_items` | `id UUID`、`merchant_id UUID`、`code TEXT`、`name TEXT`、`kind TEXT`、`description TEXT`、`price_minor INTEGER`、`currency TEXT`、`rule_label TEXT`、`rule_version INTEGER`、`cancellation_fee_minor INTEGER`、`simulation_mode TEXT`、`active BOOLEAN`、`created_at/updated_at TIMESTAMPTZ`、`cancellation_rule TEXT`、`close_simulation_mode/refund_simulation_mode TEXT`、`category_code TEXT?`、`location_label TEXT?`、`tags TEXT[]`、`purchase_mode TEXT`、`available_from/available_to DATE?` | 目录展示价可变化；`kind` 已支持 food；`listing` 只能规划/推荐，`orderable` 才能出有效报价；旧 merchant_id 是渠道/后台责任，不要求商户管理员产品界面 |
| `offer_quotes` | `id UUID`、`catalog_item_id UUID`、`provider TEXT`、`quote_source TEXT`、`provider_quote_ref TEXT?`、`quote_version BIGINT`、`price_minor BIGINT`、`currency TEXT`、`service_on DATE?`、`rule_version BIGINT`、`rule_snapshot JSONB`、`valid_until TIMESTAMPTZ`、`status TEXT`、`created_at TIMESTAMPTZ` | 不可变实际候选报价；`quote_source=demo/channel_api`；active/orderable/CNY 商品才可建，价变新建报价，旧行只可过期/撤回；有效报价须由 B 再核渠道状态 |
| `funding_assessments` | `id UUID`、`owner_id UUID`、`period_id UUID`、`account_id UUID`、`budget_item_id UUID`、`quote_id UUID`、`financial_version/period_version/quote_version BIGINT`、`replaced_estimate_minor/quoted_amount_minor/incremental_impact_minor BIGINT`、`status TEXT`、`shortfall_minor BIGINT`、`affected_dates DATE[]`、`reason_codes TEXT[]`、`basis_snapshot_id UUID`、`expires_at/created_at TIMESTAMPTZ` | A 写、B 读取的短时评估证据；差额必须是报价减用户估价；`allowed/needs_adjustment/blocked/unknown`；证据不可改写，preview 不是支付授权 |
| `purchase_intents` | `id UUID`、`owner_id UUID`、`period_id UUID`、`budget_item_id UUID`、`quote_id UUID`、`assessment_id UUID`、`financial_version/period_version/quote_version BIGINT`、`accepted_amount_minor BIGINT?`、`status TEXT`、`expires_at TIMESTAMPTZ`、`confirmed_at TIMESTAMPTZ?`、`idempotency_key TEXT`、`created_at/updated_at TIMESTAMPTZ` | `proposed/confirmed/ordered/expired/rejected`；项目/报价/评估同本人同周期；确认前金额为空，确认后金额须等于报价；确认时资金/预算/报价仍新鲜；一项目一个活跃意图/订单 |
| `planning_drafts` | `id UUID`、`owner_id UUID`、`period_id UUID`、`basis_financial_version/basis_period_version BIGINT`、`model_source TEXT`、`validated_payload JSONB`、`status TEXT`、`created_at TIMESTAMPTZ` | 结构化 AI 草案；`draft/accepted/discarded/stale`；只存校验后的必要建议，模型不可直接建订单、确认、改资金或降储蓄目标 |

`catalog_items.price_minor` 与 `budget_items.user_estimated_amount_minor`、`offer_quotes.price_minor` 是三种不同金额：展示价、用户估价、渠道报价。消费者估价不能直接填订单金额。旧 `orders.amount_minor` 仍为 INTEGER，因此当前可下单报价最高 `2,147,483,647` 分；超界返回 `AMOUNT_OUT_OF_RANGE`，不能发生整数溢出。Demo 报价标 `demo`，不得写成真实商户接口结果。

### 4.4 共同交易、调整、审计与资金事件

| 表 | 当前字段（类型） | 用途与关键约束 |
| --- | --- | --- |
| `orders` | `id UUID`、`plan_id/plan_item_id UUID?`、`owner_id UUID`、`merchant_id UUID?`、`confirmation_id/purchase_authorization_id UUID?`、`budget_period_id/purchase_intent_id UUID?`、`item_name TEXT`、`amount_minor INTEGER`、`currency TEXT`、`environment TEXT`、`provider TEXT`、`status/payment_status TEXT`、`simulation_mode/close_simulation_mode/refund_simulation_mode TEXT`、`reserved_minor/refunded_minor INTEGER`、`created_at/updated_at TIMESTAMPTZ` | **二选一形状**：旧订单保留计划/计划项/确认/授权/商户，预算/意图为空；新订单保留本人预算/已确认有效意图，旧关联为空。一意图一订单；订单改变使账户资金版本递增，但旧代码尚不会处理新形状 |
| `budget_adjustment_proposals` | `id UUID`、`owner_id UUID`、`period_id UUID`、`basis_financial_version/basis_period_version BIGINT`、`reason TEXT`、`proposed_changes JSONB`、`status TEXT`、`expires_at TIMESTAMPTZ`、`confirmed_by UUID?`、`confirmed_at TIMESTAMPTZ?`、`created_at/updated_at TIMESTAMPTZ` | 意外变化选项；`proposed/confirmed/executing/complete/expired/rejected/pending_review`；必须先未确认建立，确认后方案/确认人不可改写 |
| `budget_events` | `id BIGSERIAL`、`owner_id UUID`、`period_id UUID`、`actor_id UUID?`、`type TEXT`、`data JSONB`、`correlation_id UUID?`、`created_at TIMESTAMPTZ` | 新月度闭环事件游标；A/B 在自己的事实写入点留因果记录，不存密钥或模型思维链 |
| `finance_money_events` | `id UUID`、`owner_id UUID`、`order_id UUID`、`provider TEXT`、`provider_event_id TEXT`、`event_type TEXT`、`amount_minor BIGINT`、`currency TEXT`、`occurred_at TIMESTAMPTZ`、`verification_state TEXT`、`source TEXT`、`applied_ledger_entry_id UUID?`、`created_at TIMESTAMPTZ` | 提供方 ID/事件类型去重；支付/退款 posted 必须 verified 且关联同订单、金额、方向、来源一致的 posted 流水；证据不可改写；沙盒回执不是工行账户流水 |
| `operations` | `id UUID`、`plan_id UUID?`、`budget_period_id UUID?`、`owner_id UUID`、`type TEXT`、`entity_id UUID`、`authorization_id UUID?`、`state TEXT`、`purpose TEXT`、`result JSONB`、`next_run_at TIMESTAMPTZ`、`lease_until TIMESTAMPTZ?`、`lease_version/attempt_count INTEGER`、`sent_at TIMESTAMPTZ?`、`channel_evidence JSONB`、`created_at/updated_at TIMESTAMPTZ` | 旧操作按 plan，新操作按预算周期；状态 unknown/recheck/恢复由 B 的 Worker 适配；HTTP 202 只表示受理 |
| `cancellation_requests` | `id UUID`、`order_id UUID`、`proposal_id/confirmation_id UUID?`、`owner_id/budget_adjustment_id UUID?`、`accepted_fee_minor/accepted_refund_minor INTEGER`、`status TEXT`、`rule_version INTEGER`、`rule_preset TEXT`、`decision/decision_reason TEXT?`、`decided_by UUID?`、`decided_at TIMESTAMPTZ?`、`created_at/updated_at TIMESTAMPTZ` | 旧善后用旧 proposal/confirmation，新善后用本人 budget_adjustment；申请不等于退款到账 |
| `refund_batches` | `id UUID`、`cancellation_request_id/order_id UUID`、`merchant_id UUID?`、`responsible_provider TEXT?`、`operation_id UUID?`、`environment/provider TEXT`、`batch_number INTEGER`、`business_number TEXT`、`amount_minor INTEGER`、`status TEXT`、`created_at/updated_at TIMESTAMPTZ` | 保留旧商户责任或受控平台/渠道责任；多批退款有业务号/状态，未知时复核，实际资金到账仅以 A 的已核验流水为准 |

旧 `payment_attempts`、`payment_notifications`、`jobs`、`idempotency_records`、`manual_tasks`、`authorizations` 等仍在。B 应逐表检查旧 Worker 对 `plan_id`/`merchant_id` 非空的假设，新订单不满足这些旧假设；不得因为数据库接受新行就让旧 Worker 直接处理。

## 5. A/B 共用的接口契约（当前已实现与待收口路径）

权威类型文件：`packages/contracts/src/consumer-backend.ts`，由 `packages/contracts/src/index.ts` 导出。JSON 使用 camelCase；数据库列名 snake_case。消费者身份来自后端会话，请求体不收 `ownerId/actorUserId/source=bank_api/settledLedgerEntryId` 等受信字段。金额为安全整数分与 `CNY`；日期为有效 `YYYY-MM-DD`、周期时区 `Asia/Shanghai`，瞬时时间 ISO 8601 带时区。缺失资金事实为 `null+dataStatus=unknown`，不填 0。

### 5.1 必须照此交接的 DTO

| DTO | 字段与语义 | 提供方 → 使用方 |
| --- | --- | --- |
| `BudgetItemChangeInput` | `periodId, itemId/null, expectedPeriodVersion, kind, title, categoryCode/null, plannedOn, userEstimatedAmountMinor, priority, changeReason`；必要支出 priority=required，不含商户报价 | B 消费者入口 → A 保存与重算 |
| `BudgetItemCancelInput` | `periodId, itemId, expectedPeriodVersion, reason`；只取消尚未结算且未进入订单承诺的项目，不删除原记录 | B 消费者入口 → A 取消与重算；阶段 0 已补共享类型 |
| `BudgetBasis` | `accountId, periodId, currency, financialVersion, periodVersion, basisSnapshotId/null, asOf/null, confirmedCashMinor/null, savingsTargetMinor, essentialRemainingMinor, adjustablePlannedMinor, committedOrdersMinor, expectedIncomeMinor, pendingRefundMinor, minimumProjectedCashMinor/null, minimumCashOn/null, dataStatus` | A 计算 → B/Agent 只读 |
| `AssessPurchaseInput` | `periodId, budgetItemId, quoteId, expectedFinancialVersion, expectedPeriodVersion, expectedQuoteVersion, mode=preview`；报价/金额由服务端读，不信客户端自报 | B → A 预览 |
| `FundingAssessment` | `assessmentId, accountId, periodId, budgetItemId, quoteId, basisSnapshotId, financialVersion, periodVersion, quoteVersion, quotedAmountMinor, replacedEstimateMinor, incrementalImpactMinor, status, shortfallMinor, affectedDates, reasonCodes, expiresAt` | A → B 展示/建立待确认意图 |
| `PurchaseIntentCreateInput` | `periodId, budgetItemId, quoteId, assessmentId, expectedFinancialVersion, expectedPeriodVersion, expectedQuoteVersion` | B 入口并核 A 的评估 |
| `PurchaseIntentConfirmInput` | `acceptedAmountMinor, expectedFinancialVersion, expectedPeriodVersion, expectedQuoteVersion, confirmedByUser=true`；布尔值本身不构成授权 | 消费者直接确认 → B + A 同事务 |
| `VerifiedMoneyEvent` | `orderId, provider, providerEventId, eventType, amountMinor, currency, occurredAt, verificationState, source`；posted 必须 verified 并对应同订单流水 | B/受控渠道 → A 核验/去重/更新 |
| `EmergencyAssessInput` | `periodId, amountMinor, plannedOn, reason, expectedFinancialVersion, expectedPeriodVersion` | B 编排 → A 逐日评估 |
| `BudgetAdjustmentConfirmInput` | `acceptedOptionId, expectedFinancialVersion, expectedPeriodVersion, confirmedByUser=true` | 消费者直接确认 → B 编排、A 写资金变化 |

版本含义固定：`financialVersion` 反映账户快照、流水、义务及新订单承诺；`periodVersion` 反映月度目标/项目/周期；`quoteVersion` 属于不可变报价。任一版本变化、报价过期或账户撤销，旧 preview 不得用于建单。订单落库本身使资金版本递增，所以付款交接核**最新订单和资金状态**，不把落单后的版本与落单前评估直接比较。

### 5.2 目标消费者 HTTP 路由及任务归属

| 路径 | 请求/响应关键内容 | 开发者 |
| --- | --- | --- |
| `GET /api/finance/accounts` | 本人账户脱敏目录、授权/来源/时间 | A |
| `POST /api/finance/accounts/:id/revocations` | 本人撤回账户授权；幂等保留历史，阻止新评估、确认、建单和首次支付交接，不阻断既有订单善后 | A；B 消费并透传撤回错误 |
| `POST /api/budget-periods`、`GET /api/budget-periods/:id` | 创建月度周期；返回本人 `BudgetBasis`、项目、逐日风险、未知依据和版本 | A |
| `PATCH /api/budget-periods/:id/savings-target` | 本人直接确认目标变化、理由、前后值和审计 ID | A |
| `POST /api/budget-periods/:id/items` | 新增自定义/必要/收入项目；正文 `itemId=null`，路径 periodId 与正文一致 | B 入口，A 内部写函数 |
| `PATCH /api/budget-periods/:id/items/:itemId` | 修改尚未承诺项目；路径 periodId/itemId 与正文一致 | B 入口，A 内部写函数 |
| `POST /api/budget-periods/:id/items/:itemId/cancellations` | 取消尚未结算且未进入订单承诺的项目，保留原记录与事件 | B 入口，A 内部取消函数 |
| `POST /api/finance/assessments` | `mode=preview`，短时资金评估，不执行 | A |
| `POST /api/ai/planning-drafts` | 仅结构化草案、说明、受控数据范围，不执行 | B |
| `GET /api/offers`、`GET /api/offers/:id/quote` | 目录与当前有效报价，来源/规则/过期/服务日期；GET 只读，不在请求内创建报价 | B |
| `POST /api/purchase-intents`、`POST /api/purchase-intents/:id/confirm` | 报价/评估/待确认 → 本人显式确认、最终准入、订单或拒绝 | B，确认事务调用 A |
| `POST /api/orders/:id/payment-handoffs` | 本人订单交接/业务号/operationId/未知状态 | B |
| `POST /api/emergencies/assess`、`POST /api/adjustments/:id/confirm` | 变化选项逐项核算 → 本人确认后调整/取消/退款受理 | B 编排，A 财务判断/写入 |
| `GET /api/budget-periods/:id/review` | 月度实际结果、目标差异、退款到账和未知事项 | A |

统一普通响应目标：`{ data, meta: { financialVersion?, periodVersion?, quoteVersion?, asOf?, source? } }`；异步 HTTP 202 返回 `operationId,state=accepted`，不表示付款成功。错误目标：`{ error: { code, message, details? }, correlationId }`。写请求要求 `Idempotency-Key`，变更/确认要求预期版本；同一主体/路径/键且规范化参数相同返回原结果，参数不同 409。客户端不能用 `confirmedByUser=true` 代替会话归属、明确确认范围和服务端准入。Agent/Worker/渠道适配器不得调用消费者确认入口替用户点击。

统一状态：周期 `draft|active|closed`；项目 `planned|committed|settled|cancelled`；报价 `valid|expired|withdrawn`；评估 `allowed|needs_adjustment|blocked|unknown`；购买意图 `proposed|confirmed|ordered|expired|rejected`。只有**新鲜 allowed + 最终事务复核**才可落单。错误码来自 `consumerApiErrorCodes`：`UNAUTHENTICATED, RESOURCE_FORBIDDEN, VALIDATION_ERROR, AMOUNT_OUT_OF_RANGE, IDEMPOTENCY_CONFLICT, VERSION_CONFLICT, QUOTE_STALE, ITEM_NOT_ORDERABLE, INSUFFICIENT_FUNDS, SAVINGS_TARGET_AT_RISK, FINANCE_BASIS_UNKNOWN, PROVIDER_RESULT_UNKNOWN, CONFIRMATION_REQUIRED, CONFIRMATION_SCOPE_MISMATCH`，账户撤回统一返回 `FINANCE_SCOPE_REVOKED`。共享契约、A02/A03 内部端口和 B03—B07 路由已经落入当前代码；双方不得另造近义错误或私有请求形状。旧 API 的 `fits|requires_change|conditional|unknown` 与旧错误形状只能由兼容层映射，conditional 不能当 allowed。

### 5.3 开发前固定的内部交接与草稿边界

以下是 A 侧与 B-Ⅱ／B-Ⅲ 已实施的交接契约；B01 所需类型和签名、B02 草稿 schema 及 A04—A06 内部端口均已落入共享代码；没有建立远程调用服务或第二套资金引擎。

**项目写入：** A 提供 `applyBudgetItemChange(client, ownerId, input)` 与 `cancelBudgetItem(client, ownerId, input)`。`client` 是 B 外层事务的同一 `PoolClient`，`ownerId` 来自会话。B 负责 HTTP、路径与正文一致性、外层幂等记录和提交／回滚；A 负责账户→周期→项目的锁顺序、归属、版本、状态、预算事实写入和预算事件。返回 `{ item: BudgetItemView, basis: BudgetBasis }`，二者均代表该事务中的修改后状态；B 不另算风险、不再写一份预算事件。候选目录由 B 单独查询，不把报价检索塞进 A 写函数。取消只允许 planned 项；已 cancelled 且当前版本匹配时返回现状，不推进版本；committed/settled 必须走调整善后，不直接取消。旧版本仍返回 VERSION_CONFLICT，同一幂等键优先返回原结果。

**AI 需求草稿与预算草案：** 复用 `planning_drafts` 的持久化和同一个 `POST /api/ai/planning-drafts` 入口。无账户需求请求使用 `periodId=null, expectedFinancialVersion=null, expectedPeriodVersion=null`；三个值必须同为空。预算草案三者必须都有值，校验本人周期及真实版本。无账户分支只提取用户明确提供的需求、日期、估价和约束，不判断资金可行性。023 已允许这三列成组为空、补 owner 到用户表的直接外键，并保留非空预算草稿的原周期归属约束；017 未改写。旧 `createPlanInput` 仍必须带商品，不能用来伪造空计划。

B02 为模型输出和保存响应补充同一份严格模式：`{ draftId, periodId, status, basisFinancialVersion, basisPeriodVersion, items, missingFields }`。items 仅包含标题、日期或 null、用户估价或 null、必要／可调属性或 null、需求条件，以及可选目录引用；保留用户提供的值，模型建议值须单独标为建议，不覆盖原始输入。需求分支依据版本为 null；缺失字段显式列入 missingFields；目录引用须由 B 核实。预算草案另带 A 的只读评估摘要 `{ status, shortfallMinor, affectedDates, reasonCodes }`，shortfallMinor 可为 null 表示未知，事实不完整时 status=unknown。A03 提供 `assessPlanningDraft(client, ownerId, periodId, expectedFinancialVersion, expectedPeriodVersion, proposedItems)`，复用逐日算法在内存中评估建议，不写 budget_items 或 funding_assessments；B 核模型输出后调用，A 重读本人依据和版本。此摘要不等同于需要 quoteId 的购买评估。只读获取使用 `GET /api/ai/planning-drafts/:id`，仅本人可读；不暴露任意草稿状态 PATCH。

用户选定账户和周期后，需求草稿仍保留为原始记录；用户通过 B01 逐项确认完整项目，必要时再基于该周期生成新预算草案，不把原草稿自动改为 active，不把缺失金额补零。首版不维护“整份草案已执行”状态或自动关联交易；表中 accepted 状态暂不由新入口写入。无账户分支与预算分支都不能确认选择或交易。

**购买评估顺序：** 先请求 A 的 `POST /api/finance/assessments` 获取评估，再把 `assessmentId` 连同 quoteId、项目与三版本交给 B 的 `POST /api/purchase-intents`。B 校验同本人、同项目／报价、未到期、版本匹配且 status=allowed，绑定原评估，不在该接口重复生成评估。失效时明确返回对应错误，调用方重新评估。确认时仍由 A 在 B 的外层事务内重读事实并最终准入；持久化评估永远不是购买授权。

**资金缺失与撤回：** 无有效快照时返回 FINANCE_BASIS_UNKNOWN，不创建要求非空 basisSnapshotId 的评估记录；已有快照但其他事实不足可保存 unknown 评估。账户撤回由 A01 实现固定接口：本人、Idempotency-Key、`expectedStatus=linked`；首次写 revoked/revokedAt，账户 financialVersion 及关联预算周期 version 各推进一次（复用数据库版本机制，不双加）；重复撤回不再推进。返回 `{ accountId, status, revokedAt, financialVersion, affectedPeriodIds }`。禁止新事实刷新、创建／重新关联周期、新评估、意图、确认、建单与首次付款交接，统一 FINANCE_SCOPE_REVOKED；本地历史读取及既有订单善后继续。通用目录和只读报价无账户入参，可以继续浏览，但不能据此取得购买资格。M2 显示撤回及最后快照时间，不再把该账户列为可选账户。

## 6. A 的详细交付与验收现状：资金、预算、最终准入

本节对已进入当前代码基线的 A00—A06 交付作现状记录。“验收”仅指原范围的领域或定向检查；M1 补充收口和消费者 HTTP 连续验收仍以第 11 节为准，不能把本节的实现说明当作整体放行结论。

### A00｜交接基线和稳定 Demo 事实

- 输入：已应用 001—028、共享契约、当前空财务表、2 条 B00 Demo 报价和旧 seed；A00 资金样例可通过独立命令加载，先确认基线迁移在双方工作区可见、数据库能重复迁移且不会覆盖历史订单。
- 已提供：稳定的 `demo` 借记账户、脱敏标识、`observed` 且有 `available_balance_minor/as_of/covered_through_at` 的 ¥2,000 快照，以及本月 ¥500 目标、¥900 必要、¥400 可调样例；其中晚餐 ¥80 是 ¥400 的组成部分，不额外新增占用。Demo `source=demo`，密钥/测试账号放本地私密配置，不提交。
- 产出：可重复初始化方式与一份固定 JSON/UUID 样例；二次运行不改变历史目录报价/订单规则。验收：账户、快照、预算周期/项目正确归属，旧 2 条订单不消失。

### A01｜账户、余额快照、流水和还款读取

- 已提供 `GET /api/finance/accounts`、账户撤回接口（按 5.3 节）和受控内部资金事实读取；目录允许返回本人已撤回账户的本地历史摘要，新事实读取只取本人已授权账户，区分 debit、credit、loan。使用 `as_of`/覆盖游标选择新鲜 observed 基准，晚到旧快照不替代新快照；已覆盖流水只用于展示，不重复补入余额。
- 展示 pending/posted/reversed，预计收入、未核退款、信用额度和负债分开返回。`finance_obligations` 中账单覆盖分期、还款已结清、包含链循环和主还款账户由确定性逻辑处理。
- 验收：跨用户账户不可读、撤销授权不可新建执行基准、快照缺覆盖/余额返回 unknown、信用额度不能使 blocked 变 allowed。

### A02｜月度预算、用户项目、目标变更

- 已提供 `POST/GET /api/budget-periods`、储蓄目标 PATCH、内部 `applyBudgetItemChange`。`draft` 可编辑规划，具备完整资金依据后转 active；一个账户一个自然月一个周期。项目日期按 Asia/Shanghai 归月，收入/必要/自定义消费写同一 `budget_items`，不写旧 30 天表。
- B 的项目路由只能把 `BudgetItemChangeInput` 传给 A 内部函数；服务端检查本人、路径/正文周期一致、版本、幂等、状态，返回项目和新周期版本。必要支出 required，已承诺估价不改；目标变化必须本人确认、留 `budget_target_changes` 审计，AI 不改目标。
- 验收：无商品的晚餐 ¥80 仍参加预算但不能下单；重复点击只建一行；跨月日期拒绝或归入正确周期，下一月未知不推断零支出。

### A03｜保守逐日现金流引擎

- 从确认借记余额开始，按每日已知收入/必要支出/账单/用户项目/已承诺订单/已确认付款/退款到账计算，不将估价与订单重复计入；每一天产出预计最低余额、缺口、受影响日期和周期末可存。
- 月度储蓄目标作为保留约束；退款申请、预计收入和信用额度单列为 conditional 信息，不参与准入。跨月 30 日视图读取相邻月周期，不存在则 unknown。
- 用固定样例验算静态 ¥200→¥181→缺 ¥219，再排一组“月末余额够、月中先透支”的日期，确保仍阻止购买。验收：同账户两个目标不能各自占用全部现金。

### A04｜购买/意外调整的预览评估

- 已提供 `POST /api/finance/assessments` 及内部 `assessPurchasePreview`；报价由服务端按 quoteId 读取，核商品 orderable、来源、币种、服务日期、规则/有效期、项目估价和三个版本。
- 写 `funding_assessments` 短时证据，返回 `FundingAssessment`。估价 ¥80→报价 ¥99 得 `replacedEstimate=8000, quoted=9900, incremental=1900`；给出 `allowed|needs_adjustment|blocked|unknown` 和可解释 reasonCodes。unknown/needs_adjustment 不给 B 虚假订单许可。
- 意外支出金额/日期和 B 提供的每个调整选项也走同一个确定性逐日引擎。验收：过期报价、旧快照、跨主人项目、信用额度、未到账退款均不放行。

### A05｜与 B 共同完成最终事务准入

- 提供接收同一个 `PoolClient`/事务上下文的内部 `commitPurchaseAssessment`（命名可共同调整，语义不能变）。固定锁顺序：账户 → 预算周期 → 项目 → 报价/意图 → 相关订单；重读账户授权、快照、所有同账户承诺、版本、报价、用户确认、逐日现金流。
- B 在**该事务中**确认意图并落单；A 将原估价占用替换为报价/订单承诺。若数据变化，整笔回滚并返回 VERSION_CONFLICT/QUOTE_STALE/资金不足，不得拿几分钟前的 HTTP preview 当最终准入。
- 与 B 检查旧代码的 plan-first 锁顺序和旧建单路径；旧新写入若无法接统一账户准入，应对新消费者流程关闭，旧已受理订单查询/善后继续。验收：并发两笔下单同账户不能双花，一意图只生成一个订单，事务失败无部分占用。

### A06｜已核验支付/退款事实与周期复盘

- 提供受控 `applyVerifiedMoneyEvent`；核提供方稳定事件 ID、原订单、本人、环境、金额、方向、Demo/银行来源。pending/unknown/退款申请只留事实或待办，不改确认现金；posted 需要同订单同金额方向来源的 posted 流水，并由 `finance_money_events` 去重。
- 处理周期关闭后晚到结算、已退款批次与实际到账差异，避免双扣/双回补。已提供 `GET /api/budget-periods/:id/review`，分别报告原目标、已确认实际、待到账、意外影响和未知事项，不将 AI 建议节省额冒充实际收益。
- 验收：重复支付通知/退款回调只记一次，sandbox 不冒充 bank_api，退款请求不增加可用现金，旧订单历史仍可恢复。

## 7. B 的详细交付与验收现状：每日规划、AI、报价和交易

本节对已进入当前代码基线的 B00—B07 交付作现状记录。原开发阶段的固定桩和分批计划保留用于追溯；当前运行已接入 A02/A03、A04/A05 和 A06 的核心路径，但第 11 节列出的补充收口与 HTTP 连续验收仍未完成。

### B00｜目录与稳定 Demo 报价

- 已审查 `catalog_items` 的 food、category、purchase_mode、available_from/to、取消规则和旧 seed 的 ON CONFLICT 更新行为，并落地不会改变历史订单当时规则的 Demo 商品/报价初始化。新 Demo 商品使用独立稳定 code，初始化不覆盖旧 A/B/C/D 的价格、规则或激活状态。B 提供商品与报价数据定义；若仍需修改共用 `db/seed.ts`，只由约定的合并人落入，避免与 A 的账户/预算种子同时改同一段。
- 已实现 `GET /api/offers`、`GET /api/offers/:id/quote`；目录查询至少支持 `plannedOn`，可选 `categoryCode`，只返回 active 且日期可用的商品。orderable 商品才有 `offer_quotes`，listing 只能推荐。报价记录独立于目录可变价，保存 provider、demo/channel_api 来源、服务日期、规则快照、quoteVersion、validUntil；价变新建记录。B00 的固定 Demo 报价由初始化过程预先写入，GET 只返回当前有效记录；以后如需渠道刷新，使用受控内部函数另建报价，不把写操作藏进 GET。
- 验收：¥80 用户估价不等于 ¥99 报价；过期/撤回/禁用商品不再可买；Demo 来源不会显示成真实商户接口。

### B01｜消费者自定义每日项目与目标组织

- 已实现用户新增、编辑、改日期、取消尚未执行的项目入口，输入标题、分类、日期、估价、required/adjustable。预算项目在关联有效报价并通过购买意图前都只是规划事项；`budget_items` 不新增不存在的 `planning_only` 字段，也不要求先选择固定目录商品。
- B 拥有该消费者 HTTP 路由、请求解析和响应组装；路由校验共享 `budgetItemChangeInput`，把同一事务上下文和规范化输入交给 A 的 `applyBudgetItemChange`。B 不自行 UPDATE `budget_items` 金额或维护独立预算余量。返回估价、月度风险、可关联候选报价；服务端核 path periodId=body periodId。
- 验收：无商品项目可规划但无法通过订单入口；已承诺金额不能静默修改；同一幂等键重试不会再加一行。

### B02｜AI 草案和 Agent 工具权限

- 已落地基于 A `BudgetBasis`、用户目标/每日项目和登记商品的结构化需求／预算草稿保存与严格校验；预算草案接入 A03 只读评估，需求草稿保留缺失事实。完整候选比较、意外情况选项和 Agent 产物交接属于第 11 节补充收口，不能从当前草稿接口推断已完成。
- 新消费者流程已在代码级限定模型工具为本人授权读取、检索登记商品和保存待确认草稿。旧 `create_order/request_payment/pause_purchases/submit_change` 执行工具与新入口隔离；历史已授权订单善后如继续保留 Agent 执行工具，仍经原授权与统一最终准入，不扩大范围。
- B-Ⅰ 未新增“整份草案一键执行”接口。无账户需求草稿、预算草案和读取入口已按 5.3 节落地。草案被用户采用时，仍通过 B01 的结构化项目入口逐项写入预算并接受 A 的版本校验；草案保存成功不等于预算项目已经变化。
- 最小化模型输入，不上传账户密钥、支付凭据、病史和不必要的逐笔流水；健身/饮食建议非医疗建议。验收：伪造模型建议不能创建订单、降储蓄目标或触发退款。

### B03｜购买意图、报价关联和待确认摘要

- 已实现 `POST /api/purchase-intents`；按 5.3 节先取得 A preview，再提交 quoteId 与 assessmentId。B 核 quoteSource/有效期/商品规则和评估绑定关系，复用该评估展示估价、报价、差额、储蓄/逐日影响与取消规则，不重复调用 preview。
- 仅对本人、同周期预算项目建立 `purchase_intents`，绑定 funding assessment、financial/period/quote 三版本和到期时间；needs_adjustment/blocked/unknown 不包装成“可以买”。商品报价变化要新报价、新评估、新意图，保留旧证据。
- 原开发阶段曾使用固定 A 响应并行开发；当前 `buildApp` 已接入 A04 的真实评估和 A05 的同事务准入，固定桩只保留在边界测试中，不进入日常运行路径。验收：跨主人引用失败，同一项目不出现两个活跃意图，报价 ¥99 不能在确认阶段换成 ¥109。

### B04｜消费者确认、订单与支付交接

- 已实现 `POST /api/purchase-intents/:id/confirm`，只允许本人直接请求。B 发起并控制唯一的外层数据库事务，把同一个 `PoolClient` 交给 A 的最终准入函数；核确认金额=有效报价、确认范围/规则/版本/到期，在该事务内完成意图 confirmed→ordered、创建**新订单形状**（预算/意图有值，旧计划/商户/授权列为空）和预算事件。A/B 不得各开事务，也不得在事务提交前发送支付请求。
- 已实现新订单读取与 `payment-handoffs`；检查本人、报价、资金最新状态、固定支付业务号、幂等和环境。交接只能跳沙盒/受控支付适配，不替用户输入密码或宣称自动扣款。支付结果 unknown 时停止重试建单，使用原业务号复核。
- 验收：账户级并发准入、重复确认/回调不重复下单，旧 2 条订单仍能按原字段查询和善后。

### B05｜Worker、新旧订单范围与支付/退款事件回传

- 已检查旧 Worker、jobs、operations、payment_attempts、refund_batches、manual_tasks 中 `plan_id/merchant_id/confirmation_id` 必定非空的代码假设，并为新 `budget_period_id` 形状增加受控路径；不直接让旧路径读 NULL。新订单支付交接、结果复核、取消、退款和人工任务按实际调用链分流，不为新形状重构全部旧 Worker。
- 受理/lease/恢复/复核继续保持固定业务号；支付成功、失败、未知、关单、取消、退款分批明确分状态。把受信渠道核验结果转成 `VerifiedMoneyEvent` 给 A，不能仅靠支付宝沙盒通知更新 Demo/银行现金。人工恢复是后端运营职责，不新增消费者可见商户管理员入口。
- 验收：未知支付不会二次下单；退款申请、渠道成功、实际到账状态分明；并发 Worker 不重复应用事件。

### B06｜意外开支、调整确认、取消和善后

- 已实现 `POST /api/emergencies/assess`；用户报告意外金额/日期/理由后，B 提出延期、替换、缩减、取消等结构化选项，A 为每个选项逐日计算资金与储蓄影响，存 `budget_adjustment_proposals`。
- 已实现 `POST /api/adjustments/:id/confirm`；本人选 optionId，核资金/周期版本、确认范围、取消费用/预期退款，A 更新预算事实，B 受理旧或新订单的停止/取消/退款。已支付退款需要渠道规则和受控责任，不能把申请金额写成已到账资金。
- 验收：¥400 意外时缺口和选项可解释；AI 不自动降低 ¥500 目标；已付款取消拒绝/延迟/分批退款有可恢复状态，历史订单仍可追踪。

### B07｜消费者闭环证据与 API 交接

- `budget_events` 记录建议、报价、确认、订单、结果、调整和善后的可追溯摘要；统一新 API `{data,meta}`、错误码和权限。前端本阶段不改，但提供可调用的路径、样例 JSON、运行步骤、Demo/沙盒限制与未知状态说明。
- 与 A 共同完成从预算到复盘的消费者故事，不以商品分类数量或 AI 文案数量充当完成度。验收：仅凭 API 可演示完整因果链，证据不泄露密钥或模型思维链。

### B 的三批交付和固定模拟 A 响应

B 不同时铺开目录、Agent、交易和善后，按以下三批集中实现与验收：

| 批次 | 内容 | 允许依赖 | 统一验收结果 |
| --- | --- | --- | --- |
| B-Ⅰ | B00—B02：目录、报价、每日项目入口、只读 AI 草案 | 共享契约、A 的 `BudgetBasis`/项目写入边界；不依赖真实购买准入 | 原范围目录、草稿和 Agent 工具隔离已落地；固定 A 桩仅用于边界测试，补充收口和 HTTP 连续验收待完成 |
| B-Ⅱ | B03—B04：购买意图、本人确认、新订单、支付交接 | A04 preview、A05 同事务 commit；账户撤回错误已进入共享契约 | 新鲜 allowed 才能本人确认并建一笔订单，提交后才能支付交接，旧订单仍可读 |
| B-Ⅲ | B05—B07：Worker、资金事件、意外调整、取消退款和证据 | A06 资金事件与复盘接口 | 原范围领域链已有记录；未知结果、退款分层和完整 API 因果链仍需按第 11 节集中验收 |

B-Ⅰ 开发阶段曾使用固定模拟 A 响应推动开发；当前项目写入桩只注入定向测试，不注册为日常服务写接口，日常运行已接入 A02/A03、A04/A05 和 A06 的核心路径。固定模拟层不得实现另一套资金算法，也不得进入生产式支付路径。以下资金结果矩阵保留供边界检查使用：

| 场景 | 固定语义 | B 必须表现 |
| --- | --- | --- |
| `allowed` | ¥80 估价、¥99 报价、只替换增加 ¥19，版本与依据完整 | 可建立待确认意图，但仍不可自动确认或下单 |
| `needs_adjustment` | 尚有调整方案，但当前购买会破坏约束 | 显示需调整，不显示为可直接购买 |
| `blocked` | 逐日现金或储蓄目标明确不足 | 拒绝进入确认，展示短缺与受影响日期 |
| `unknown` | 已有快照但跨月事实等不足；完全无有效快照时返回 FINANCE_BASIS_UNKNOWN | 停止购买链，不将未知金额补 0 |
| `VERSION_CONFLICT` | preview 后账户或周期版本变化 | 废弃旧意图依据，重新读取和评估 |
| `QUOTE_STALE` | 报价过期、撤回或版本变化 | 新建报价、评估和意图，保留旧证据 |
| `FINANCE_SCOPE_REVOKED` | 主账户授权已撤回 | 阻止新评估、确认、建单和首次支付交接；既有订单善后继续 |

## 8. 两人怎么并行、在哪里必须会合

现有代码定位：A 维护账户、预算和财务核算路由与领域函数，并负责 Demo 资金事实；B 维护 `routes/api.ts`、`routes/agent.ts`、`domain/business-actions.ts`、`domain/agent-tools.ts`、`domain/worker-runtime.ts`、`domain/channel-worker.ts` 及目录/支付种子。以下并行拆分保留用于职责追溯；已进入代码基线的核心实现不代表第 11 节补充收口或 HTTP 集中验收已经通过。两人不要同时在巨大的旧 `routes/api.ts` 内穿插新资金代码。可以新增小而直接的消费者路由/领域文件，不必受旧文件布局束缚，也不为未来假想需求预建框架。

交汇文件采用单一落笔人，不用额外建立审批系统：

| 交汇点 | 默认职责 | 合并规则 |
| --- | --- | --- |
| `db/seed.ts` | A 提供账户/预算事实，B 提供商品/报价定义 | 阶段 0 约定一名合并人；另一方提交独立定义或明确补丁位置，不同时改同一段 |
| `app.ts` 与路由注册 | B 注册新消费者规划、目录、意图和交易路由；A 注册资金路由 | 同一批次由一名合并人处理，避免双方反复改注册顺序 |
| `packages/contracts/src/index.ts`、消费者错误码 | 公共契约 | 修改前对照本文 DTO；阶段 0 补 `FINANCE_SCOPE_REVOKED` 与 `BudgetItemCancelInput`，落实 5.3 节项目写入的输入／返回签名；B02 再补草稿模式，双方按各自消费范围复核后使用 |
| 幂等与错误适配 | 各领域复用既有实现，B 负责新消费者外层响应 | 不各自创建一套错误形状或幂等表；需要扩展时由当前调用链的合并人完成 |
| 最终准入与建单 | B 控制外层事务，A 提供接收同一 `PoolClient` 的准入函数 | 固定账户优先锁顺序；任一检查失败整笔回滚；事务提交后才允许支付交接 |
| 渠道结果与资金事实 | B 形成受信 `VerifiedMoneyEvent`，A 核验并应用 | 渠道成功不直接写余额；A 拒绝的事件保留待核，不由 B 绕过 |

| 阶段 | A 独立交付 | B 独立交付 | 双方交接/门禁 |
| --- | --- | --- | --- |
| 0：基线同步（约 1–2 天） | Demo 账户/快照/预算样例 | Demo 商品/¥99 报价样例 | **先确认远端已包含迁移和契约**；核同一 JSON、错误、日期、锁顺序；不同时改同一公共文件 |
| 1：可独立工作（约 3–5 天） | A01–A03，`BudgetBasis`、项目受控写函数 | B-Ⅰ（B00–B02），项目入口、只读 AI 草案、报价 | B 用本文固定模拟 A 响应，A 用固定报价输入；无须等对方全完成 |
| 2：第一集成（约 3–5 天） | A04–A05，preview 与内部 commit | B03–B04，意图/本人确认/新订单 | 同一事务账户优先锁、版本/报价重读；跨计划防双花与旧入口策略通过才合并 |
| 3：结果和意外（约 3–4 天） | A06，核验资金事件/复盘 | B05–B06，Worker/取消/退款/调整 | `VerifiedMoneyEvent` 去重、未知停机、退款到账分离、¥400 意外方案闭环 |
| 4：后端验收（约 2–3 天） | 逐日现金流、授权/来源/资金测试 | Agent 权限、订单/Worker/接口测试 | 统一 API 文档、Demo 演示、旧订单恢复；前端只收契约，本阶段不排 UI |

两人分别维护自己的领域文件；共享契约、跨表迁移和同事务函数由双方审核。分支可以各自开发，但不能各自修改已执行的 001—028 或产生相同迁移编号。对需要补字段的真实缺口追加 029+，不得重写已执行 SQL、清库或删除旧表。涉及历史订单、资金事件、授权或隐私的修改先对照本文件约束并做定向验证。

阶段 0 的历史完成判定是：双方代码基线均含 013—023 和 `consumer-backend.ts`；当前 M1 基线已追加至 028，A/B 使用同一组 DTO、日期、金额、错误码和锁顺序，各自本地数据库独立应用 001—028。Git 分支同步不代表 PostgreSQL 数据、历史订单、A00 资金样例或本地私密配置已经同步，任何一方都不能据此跳过自己的迁移核对。

## 9. 最终后端验收清单

1. 完整 Demo：¥2,000、¥500 储蓄、¥900 必要、¥400 可调；用户自己加晚餐 ¥80，无商户也参加预算；报价 ¥99 时只新增 ¥19，用户确认后才可下单。
2. ¥400 意外支出和跨月/逐日预测返回可解释缺口/未知日期；“月末看似够、月中先透支”必须阻止购买，不自动降低储蓄目标。
3. 同账户多个目标不能双花；三个版本、报价有效期、商品规则、本人确认、幂等键和账户授权在后端生效；Agent 没有代码级绕行工具。
4. 预计收入、信用额度、待退款、支付未知、渠道请求成功但银行未到账都不能冒充可用现金；一笔商品只计一次估价/订单/已付/到账转换。
5. 新订单成功、失败、未知、关单、取消申请、退款分批/到账有可恢复状态；同提供方事件或前端重复点击不新增第二笔订单/流水；已有历史订单仍能查询/善后（当前本机记录为 24 条）。
6. 新消费者路由类型、权限、错误和时间/金额契约一致；普通消费者无法伪造银行事实或访问他人账户；沙盒/模拟能力被清楚标记而非声称真实银行集成。
7. 新业务的定向测试和现有目标套件已有 69/69 记录；模型费用账本、旧 Agent 全局队列计数等共享状态的隔离修复已落入工作区，但尚未重新复跑确认，不能把未复跑的结果当成当前门禁。

## 10. 已有实现与恢复入口

下一步从第 11 节收口 1 开始，通过集中验收后再进入前端。数据库结构、A00—A06、B00—B07 和共享字段定义已经进入当前代码基线。新消费者 Agent 已接入实际运行，但工具仍限定为本人资金读取、登记商品检索和非执行草稿保存。B03 的 `proposed` 意图必须经过 B04 本人确认，B05/B06 的渠道及资金事实继续遵守 A06 到账证据边界；任何阶段都不能越过资金、确认或支付边界。

## 11. M1 后端收口：进入 M2 前的补充任务

2026-09-16 只读审核决定：保留 A00—A06、B00—B07 已有实现及原有 69/69 检查记录（隔离修复后的本工作区复跑待确认），但撤回“后端契约已冻结、直接进入 M2”的放行结论。现有连续测试主要调用领域函数，不能代替消费者 HTTP 连续验收。本节是现行后端契约的补充，优先于本文和其他文档中较早的完成摘要；以下任务均为**待实施、待验证**，不是本轮已经修改代码。仍属于 M1，不另建大阶段或第二套文档。

顺序固定为：收口 1 → 收口 2 → 收口 3 → 收口 4 → 收口 5 → 收口 6。B 主责交易、Agent、HTTP 接线和整合；A 主责资金事实、分类展示数据及 Demo 账户数据；共享契约和新增迁移由实际执行者统一落笔，沿用同一 `PoolClient`，不得各自创建同号迁移。单人继续 B 工作时，可以按本节修改必要的 A 公共模块，无需重复实现资金算法。001—028 不改写，只在确有字段需求时追加迁移。

### 收口 1：购买意图放弃、过期与重新购买（B）

问题：`proposed` 意图没有失效路径，项目编辑/取消门禁与唯一索引会一直占用该项目。恢复范围只包含未确认、未建单意图，不能借此撤销真实订单。

- 新增 `POST /api/purchase-intents/:id/rejections`，消费者本人、同源、`Idempotency-Key`，请求 `{ "expectedStatus": "proposed" }`；成功返回 `{data:{purchaseIntentId,status},meta:{}}`。明确放弃写 `rejected`；已经到期则写 `expired`；已 rejected/expired 的新键重试返回现状；confirmed/ordered 返回 `CONFIRMATION_SCOPE_MISMATCH`，引导原订单善后。保留原记录、评估与报价，不删除历史。
- 在创建意图以及编辑/取消同一项目时，按账户→周期→项目→意图的既有顺序，在业务事务内先把到期的 proposed 意图转为 expired，再检查有效意图。失效仅释放意图占用，不增加账户余额、不释放已建单承诺；这类惰性清理足够，不新增定时扫描服务。事务回滚后，下次调用仍须能够重复清理，不能依赖失败请求曾经保存状态。
- 用户放弃仍有效的意图后可修改预算或换商品；重新购买必须重新取得有效评估、创建新意图并本人确认。旧意图不能复活。与确认并发时只允许一个状态转换成功，同键重试沿用原结果。

### 收口 2：既有订单独立善后（B 主责，A 核实资金事件）

问题：当前调整入口只收已付款订单，且把退款申请与新增支出、整份资金可行性绑定；待付款退出、资金不足及撤回后的既有订单善后不能完整覆盖。允许善后不等于允许新购买，也不等于退款已到账。

- 补充本人新订单的 `POST /api/orders/:id/aftercare-previews` 和 `POST /api/orders/:id/aftercare-confirmations`。两者均要求消费者会话、同源和幂等键；预览请求 `{ "action": "close" | "cancel" }`，只生成有限时效、绑定原单状态和规则的预览，不向渠道发起动作。返回预览 ID、原单、动作、规则版本、费用、预计退款、有效期和当前状态。确认请求 `{ "previewId": "uuid", "acceptedFeeMinor": 整数分, "acceptedRefundMinor": 整数分, "confirmedByUser": true }`；确认重读原单与规则，金额/范围不一致拒绝并要求重新预览，不能靠客户端布尔值取得权限。
- 确认在同一事务保存确认事实并受理原单操作，返回 HTTP 202 的 `{data:{orderId,operationId,state:"accepted"},meta:{}}`，不表示关单或退款成功；复用既有 operations/jobs、取消请求、固定业务号和资金事件。对同一原单已经受理的相同动作复用原操作；已经终结的订单返回现状，不新增退款。operation 的确认依据必须可持久读取，不只依靠前端保存预览。
- pending/unknown 订单先按原付款号查询，再决定能否关单。查询发现已付时，不把关单授权自动扩大为退款，返回需重新预览并确认。只有核实关闭才释放未付承诺；不因用户点击取消就释放预算。paid 订单走取消规则及退款；原账目、已核付款和到账事实保留。
- 这两个入口不创建必要支出、不修改储蓄目标，也不要求新的资金预测为 allowed。账户撤回或当前现金不足不能阻断本人既有订单查询/善后；仍禁止新增购买、首次付款交接和新银行事实刷新。退款结果沿原受信证据处理，预计退款始终不增加现金。
- 意外支出调整继续对会修改预算的组合做确定性评估；若方案依赖退款到账，显示“退款待到账，缺口尚未解决”，由独立善后入口先处理原单。到账后用户重新评估并确认预算变化，不自动执行旧方案。不要简单删除整份调整的资金检查，也不要把未确认的 400 元支出伪装为已经写入预算。

### 收口 3：Agent 上下文、草稿产物和读取交接（B）

- `read_budget_basis` 使用服务端本次绑定的 periodId，工具不要求模型猜 UUID；服务端向模型提供当前上海日期、是否绑定周期等最小可信上下文。保存预算草稿的周期和依据版本来自本次实际读取的资金结果，保存时再次校验；无账户草稿三项关联值保持 null，不因模型建议补齐用户缺失金额。
- 草稿落库与 run→draft 引用在同一事务保存；`GET /api/ai/agent-runs/:id` 增加 `artifacts: [{type:"planning_draft",draftId}]`，产物属于本人且与当前运行关联。即使生成最终文字失败，已保存的产物仍可读取，不能让模型自然语言成为唯一索引。前端通过已有草稿详情接口构建确认卡片，沿 B01 逐项确认。
- 增加本人运行列表 `GET /api/ai/agent-runs?periodId=&cursor=`，使用有限分页、稳定游标；省略 periodId 返回本人运行，明确 `periodId=null` 返回无账户运行。只返回运行摘要及产物引用，不暴露模型私有推理。页面刷新从列表/详情恢复，不重新调用模型。首版仍按当前消息处理，不在本轮建设长期对话记忆；缺失字段由结构化界面补充并本人确认。
- 商品比较复用登记目录、报价和 A 的只读评估：前端展示至少两个有效候选各自的价格、规则和资金影响；模型只解释已有事实。没有分别取得评估就不能声称“两套都可行”。不新增独立推荐引擎或方案表；N06 的真实模型解释与页面比较在 M2/M3 验证。

### 收口 4：分类纠正与财务展示契约（A 主责，B 接口整合）

复核后明确：现有 `GET /api/finance/accounts` 已返回 ledger 和 obligations，缺少独立列表路由不等于财务事实完全不可读。本轮复用该入口，不为页面重复建立流水/还款读取 API；前端所需字段缺失时补充当前 DTO，未知值保持 null。历史接口文档中的独立 GET 只作后续拆分参考，不作为本轮开工门槛。

- 实现 `PATCH /api/finance/ledger/:id/category`，本人、同源、幂等键，请求 `{ "category": "food" }`，分类取现有固定分类字典；只允许授权仍有效账户的本人流水，撤回后保留历史读取、拒绝新增纠正。响应返回 entryId、原始 category、用户 displayCategory 和更新时点。
- 用户分类作为独立展示覆盖保存，原始已入账流水及其 category 保持不变；复用或追加最小的按流水唯一关联的分类覆盖记录。现有 024 保护已引用流水的资金字段（并未禁止 category 修改），但 016 对流水的任何 UPDATE 都推进账户版本，且原始 refund 类别参与待退款展示逻辑。因此采用展示覆盖避免分类操作影响财务依据；不得放松原流水保护，也不得用用户分类改变资金计算、去重、账户 financialVersion 或购买评估。
- 财务读取统一返回有效展示分类及原始分类，确保账户列表和未来流水详情口径一致。补受控账单/分期样例，验证包含关系只扣一次；主演示必要支出与当期还款总计仍为 900 元，不能在原 900 元之上再加样例还款。信用负债仅供展示，不增加自有现金。

### 收口 5：可重复准备的隔离 Demo 场景（A 资金样例，B 目录/运行说明）

本轮选择“显式创建新隔离场景”，不实现自动银行同步或修改原快照时间。沿用现有种子和命令入口，增加明确场景标识；每个新场景使用独立测试消费者、账户、当前月预算、当前 observed 快照及匹配服务日期的报价。固定 2,000/500/900/400（含 80 元晚餐）口径；同标识重复执行不覆盖状态、延长报价或复活撤回账户。旧用户、旧订单、流水、模型费用、密钥和沙箱证据均保留。

场景准备输出脱敏标识、服务日期、快照时间和到期边界，测试密码继续采用本机私密配置。快照超过 24 小时或日期不匹配时显式提示创建新场景；新场景不能冒充旧订单后续进度。演示的一条连续链始终使用同一场景，不能中途切换来拼接成功。创建用户复用现有身份写入逻辑，不运行会重置旧目录的通用 seed，不增加通用重置后台或外部数据服务。

### 收口 6：一次消费者 HTTP 连续验收与契约冻结（B 整合，A 核对金额）

收口 1—5 完成后统一验收，具体范围见 [验证策略第十四节](docs/04-quality/verification.md#十四m1-后端收口集中验收待执行)。通过前暂停 M2 前端实现；通过后才将新 DTO、路径及样例冻结为 M2 基线。69/69 作为原范围证据保留，不能代替本次新增行为。无须逐任务全量测试或构建；已有实现未变的证据复用，资金/授权问题只在需要定位时做窄范围复现。
