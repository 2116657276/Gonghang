# 行止消费者产品：A/B 后端开发总方案

更新日期：2026-09-15。本文只整理现状和开发任务，不表示本文所列业务 API 已经上线。本阶段两名开发者先完成后端，前端不排期。

## 1. 项目要做什么

唯一主要使用者是消费者。用户录入月度生活费、必要开支、储蓄目标和自定义每日消费项目及**自己的估价**；AI 在财务事实约束下提出安排和调整草案。对于可购买项目，系统取得**渠道报价**，算出与估价的差额和逐日资金风险；消费者明确确认后才建单并进入支付。意外支出出现时，系统重新评估、给出可调整选项，经用户确认后处理延期、替换、取消、退款，最终复盘实际储蓄结果。

演示主线：可支配 ¥2,000，拟存 ¥500，必要开支 ¥900，可调计划 ¥400，静态缓冲 ¥200；**晚餐估价 ¥80 已包含在 ¥400 可调计划中**，其渠道报价 ¥99，增量 ¥19，缓冲变 ¥181；再发生 ¥400 意外支出，静态缺口 ¥219。**实际准入还必须逐日计算**，不能仅用这些月末数字判断是否能支付。健康目标仅为用户自述规划约束，AI 不提供诊断。商户/渠道/平台仍有受控报价、支付、退款责任，但不设新的消费者可见“商户管理员”产品角色；真实工行账户、真实商户合作、自动扣款均不声称已接入。

## 2. 目前已经完成什么、尚未完成什么

| 领域 | 已完成的事实 | 仍缺少的部分 |
| --- | --- | --- |
| 数据库 | 本机 PostgreSQL `xingzhi_dev` 已应用 001–022；013–015 财务/30 天结构、016–022 月度预算与交易兼容结构均已建；迁移前备份保存在 Git 忽略的 `.local-secrets/xingzhi_dev_before_016_2026-09-15.dump` | 新表仍无正式演示数据；资金计算、报价联动、支付/退款核验的业务写入未实现；未做完整真实银行数据审计 |
| 历史交易 | Fastify 的旧计划/目录/订单/授权/Agent/Worker/支付宝沙盒流程存在；本机历史订单 2 条，增量迁移没有删除它们 | 旧建单只检查旧计划购买上限，**没有**新月度资金准入；旧 Worker/Agent 不认识新预算周期及新订单形状 |
| 共同契约 | `packages/contracts/src/consumer-backend.ts` 已导出严格的请求/响应校验、状态枚举和 TypeScript 类型；旧共享类型继续保留 | 新消费者路由尚未注册；内部最终准入函数、统一新响应适配和完整 API 集成测试尚未写 |
| 产品规划 | 已确定消费者目标、估价/报价分离、月度目标、逐日现金流、意外调整、安全确认和 A/B 模块界线 | AI 草案、用户自定义每日项目入口、报价意图、储蓄复盘仍未成为可运行的新闭环 |
| 验证 | 迁移器已应用 016–022；回滚探针验证账户/周期版本各从 1 增至 2、Demo 报价可过期；契约/服务端/Web 类型检查通过 | 后端旧定向测试曾 55/55，后续完整运行有旧 Agent 测试 54/55 的不稳定现象：全局 `agent_wakeups` 计数短时为 1；单独文件 13/13，原因待隔离；新消费者流程没有业务测试 |

2026-09-15 只读核对：迁移 22 条、`orders` 2 行、`finance_accounts`/`budget_periods`/`budget_items`/`offer_quotes`/`purchase_intents`/`finance_money_events` 各 0 行。**特别注意交接**：数据库“本机已应用”不等于队友已能从远端拉取；两人分开开发前，应核对远端 `huixiang` 分支确实包含 013–022 迁移、新契约和本方案，再在各自的 PostgreSQL 上执行迁移。本机数据库实例、历史订单与备份不会通过 Git 自动同步。

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

## 5. A/B 共用的接口契约（已定义类型，目标路由待开发）

权威类型文件：`packages/contracts/src/consumer-backend.ts`，由 `packages/contracts/src/index.ts` 导出。JSON 使用 camelCase；数据库列名 snake_case。消费者身份来自后端会话，请求体不收 `ownerId/actorUserId/source=bank_api/settledLedgerEntryId` 等受信字段。金额为安全整数分与 `CNY`；日期为有效 `YYYY-MM-DD`、周期时区 `Asia/Shanghai`，瞬时时间 ISO 8601 带时区。缺失资金事实为 `null+dataStatus=unknown`，不填 0。

### 5.1 必须照此交接的 DTO

| DTO | 字段与语义 | 提供方 → 使用方 |
| --- | --- | --- |
| `BudgetItemChangeInput` | `periodId, itemId/null, expectedPeriodVersion, kind, title, categoryCode/null, plannedOn, userEstimatedAmountMinor, priority, changeReason`；必要支出 priority=required，不含商户报价 | B 消费者入口 → A 保存与重算 |
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
| `POST /api/budget-periods`、`GET /api/budget-periods/:id` | 创建月度周期；返回本人 `BudgetBasis`、项目、逐日风险、未知依据和版本 | A |
| `PATCH /api/budget-periods/:id/savings-target` | 本人直接确认目标变化、理由、前后值和审计 ID | A |
| `POST/PATCH /api/budget-periods/:id/items` | B 接收自定义/必要/收入项目，A 受控写入；路径 periodId 与正文一致 | B 入口，A 内部写函数 |
| `POST /api/finance/assessments` | `mode=preview`，短时资金评估，不执行 | A |
| `POST /api/ai/planning-drafts` | 仅结构化草案、说明、受控数据范围，不执行 | B |
| `GET /api/offers`、`GET /api/offers/:id/quote` | 目录与有效报价，来源/规则/过期/服务日期 | B |
| `POST /api/purchase-intents`、`POST /api/purchase-intents/:id/confirm` | 报价/评估/待确认 → 本人显式确认、最终准入、订单或拒绝 | B，确认事务调用 A |
| `POST /api/orders/:id/payment-handoff` | 本人订单交接/业务号/operationId/未知状态 | B |
| `POST /api/emergencies/assess`、`POST /api/adjustments/:id/confirm` | 变化选项逐项核算 → 本人确认后调整/取消/退款受理 | B 编排，A 财务判断/写入 |
| `GET /api/budget-periods/:id/review` | 月度实际结果、目标差异、退款到账和未知事项 | A |

统一普通响应目标：`{ data, meta: { financialVersion?, periodVersion?, quoteVersion?, asOf?, source? } }`；异步 HTTP 202 返回 `operationId,state=accepted`，不表示付款成功。错误目标：`{ error: { code, message, details? }, correlationId }`。写请求要求 `Idempotency-Key`，变更/确认要求预期版本；同一主体/路径/键且规范化参数相同返回原结果，参数不同 409。客户端不能用 `confirmedByUser=true` 代替会话归属、明确确认范围和服务端准入。Agent/Worker/渠道适配器不得调用消费者确认入口替用户点击。

统一状态：周期 `draft|active|closed`；项目 `planned|committed|settled|cancelled`；报价 `valid|expired|withdrawn`；评估 `allowed|needs_adjustment|blocked|unknown`；购买意图 `proposed|confirmed|ordered|expired|rejected`。只有**新鲜 allowed + 最终事务复核**才可落单。错误码来自 `consumerApiErrorCodes`：`UNAUTHENTICATED, RESOURCE_FORBIDDEN, VALIDATION_ERROR, AMOUNT_OUT_OF_RANGE, IDEMPOTENCY_CONFLICT, VERSION_CONFLICT, QUOTE_STALE, ITEM_NOT_ORDERABLE, INSUFFICIENT_FUNDS, SAVINGS_TARGET_AT_RISK, FINANCE_BASIS_UNKNOWN, PROVIDER_RESULT_UNKNOWN, CONFIRMATION_REQUIRED, CONFIRMATION_SCOPE_MISMATCH`。旧 API 的 `fits|requires_change|conditional|unknown` 与旧错误形状只能由兼容层映射，conditional 不能当 allowed。

## 6. A 的详细开发任务：资金、预算、最终准入

### A00｜交接基线和稳定 Demo 事实

- 输入：已应用 001–022、共享契约、当前空财务表和旧 seed；先确认基线迁移在双方工作区可见、数据库能重复迁移且不会覆盖历史订单。
- 实现：稳定的 `demo` 借记账户、脱敏标识、`observed` 且有 `available_balance_minor/as_of/covered_through_at` 的 ¥2,000 快照，以及本月 ¥500 目标、¥900 必要、¥400 可调样例；其中晚餐 ¥80 是 ¥400 的组成部分，不额外新增占用。Demo `source=demo`，密钥/测试账号放本地私密配置，不提交。
- 产出：可重复初始化方式与一份固定 JSON/UUID 样例；二次运行不改变历史目录报价/订单规则。验收：账户、快照、预算周期/项目正确归属，旧 2 条订单不消失。

### A01｜账户、余额快照、流水和还款读取

- 实现 `GET /api/finance/accounts` 和受控内部资金事实读取；只取本人已授权账户，区分 debit、credit、loan。使用 `as_of`/覆盖游标选择新鲜 observed 基准，晚到旧快照不替代新快照；已覆盖流水只用于展示，不重复补入余额。
- 展示 pending/posted/reversed，预计收入、未核退款、信用额度和负债分开返回。`finance_obligations` 中账单覆盖分期、还款已结清、包含链循环和主还款账户由确定性逻辑处理。
- 验收：跨用户账户不可读、撤销授权不可新建执行基准、快照缺覆盖/余额返回 unknown、信用额度不能使 blocked 变 allowed。

### A02｜月度预算、用户项目、目标变更

- 实现 `POST/GET /api/budget-periods`、储蓄目标 PATCH、内部 `applyBudgetItemChange`。`draft` 可编辑规划，具备完整资金依据后转 active；一个账户一个自然月一个周期。项目日期按 Asia/Shanghai 归月，收入/必要/自定义消费写同一 `budget_items`，不写旧 30 天表。
- B 的项目路由只能把 `BudgetItemChangeInput` 传给 A 内部函数；服务端检查本人、路径/正文周期一致、版本、幂等、状态，返回项目和新周期版本。必要支出 required，已承诺估价不改；目标变化必须本人确认、留 `budget_target_changes` 审计，AI 不改目标。
- 验收：无商品的晚餐 ¥80 仍参加预算但不能下单；重复点击只建一行；跨月日期拒绝或归入正确周期，下一月未知不推断零支出。

### A03｜保守逐日现金流引擎

- 从确认借记余额开始，按每日已知收入/必要支出/账单/用户项目/已承诺订单/已确认付款/退款到账计算，不将估价与订单重复计入；每一天产出预计最低余额、缺口、受影响日期和周期末可存。
- 月度储蓄目标作为保留约束；退款申请、预计收入和信用额度单列为 conditional 信息，不参与准入。跨月 30 日视图读取相邻月周期，不存在则 unknown。
- 用固定样例验算静态 ¥200→¥181→缺 ¥219，再排一组“月末余额够、月中先透支”的日期，确保仍阻止购买。验收：同账户两个目标不能各自占用全部现金。

### A04｜购买/意外调整的预览评估

- 实现 `POST /api/finance/assessments` 及内部 `assessPurchasePreview`；报价由服务端按 quoteId 读取，核商品 orderable、来源、币种、服务日期、规则/有效期、项目估价和三个版本。
- 写 `funding_assessments` 短时证据，返回 `FundingAssessment`。估价 ¥80→报价 ¥99 得 `replacedEstimate=8000, quoted=9900, incremental=1900`；给出 `allowed|needs_adjustment|blocked|unknown` 和可解释 reasonCodes。unknown/needs_adjustment 不给 B 虚假订单许可。
- 意外支出金额/日期和 B 提供的每个调整选项也走同一个确定性逐日引擎。验收：过期报价、旧快照、跨主人项目、信用额度、未到账退款均不放行。

### A05｜与 B 共同完成最终事务准入

- 提供接收同一个 `PoolClient`/事务上下文的内部 `commitPurchaseAssessment`（命名可共同调整，语义不能变）。固定锁顺序：账户 → 预算周期 → 项目 → 报价/意图 → 相关订单；重读账户授权、快照、所有同账户承诺、版本、报价、用户确认、逐日现金流。
- B 在**该事务中**确认意图并落单；A 将原估价占用替换为报价/订单承诺。若数据变化，整笔回滚并返回 VERSION_CONFLICT/QUOTE_STALE/资金不足，不得拿几分钟前的 HTTP preview 当最终准入。
- 与 B 检查旧代码的 plan-first 锁顺序和旧建单路径；旧新写入若无法接统一账户准入，应对新消费者流程关闭，旧已受理订单查询/善后继续。验收：并发两笔下单同账户不能双花，一意图只生成一个订单，事务失败无部分占用。

### A06｜已核验支付/退款事实与周期复盘

- 提供受控 `applyVerifiedMoneyEvent`；核提供方稳定事件 ID、原订单、本人、环境、金额、方向、Demo/银行来源。pending/unknown/退款申请只留事实或待办，不改确认现金；posted 需要同订单同金额方向来源的 posted 流水，并由 `finance_money_events` 去重。
- 处理周期关闭后晚到结算、已退款批次与实际到账差异，避免双扣/双回补。实现 `GET /api/budget-periods/:id/review`，分别报告原目标、已确认实际、待到账、意外影响和未知事项，不将 AI 建议节省额冒充实际收益。
- 验收：重复支付通知/退款回调只记一次，sandbox 不冒充 bank_api，退款请求不增加可用现金，旧订单历史仍可恢复。

## 7. B 的详细开发任务：每日规划、AI、报价和交易

### B00｜目录与稳定 Demo 报价

- 审查 `catalog_items` 的 food、category、purchase_mode、available_from/to、取消规则和旧 seed 的 ON CONFLICT 更新行为；设计不会改变历史订单当时规则的 Demo 商品/报价初始化。
- 实现 `GET /api/offers`、`GET /api/offers/:id/quote`；orderable 商品才有 `offer_quotes`，listing 只能推荐。报价记录独立于目录可变价，保存 provider、demo/channel_api 来源、服务日期、规则快照、quoteVersion、validUntil；价变新建记录。
- 验收：¥80 用户估价不等于 ¥99 报价；过期/撤回/禁用商品不再可买；Demo 来源不会显示成真实商户接口。

### B01｜消费者自定义每日项目与目标组织

- 实现用户新增、编辑、改日期、取消尚未执行的项目入口，输入标题、分类、日期、估价、required/adjustable。新项目默认 planning_only；不要求先选择固定目录商品。
- 路由校验共享 `budgetItemChangeInput`，调用 A 的受控项目写函数；B 不自行 UPDATE `budget_items` 金额或维护独立预算余量。返回估价、月度风险、可关联候选报价；服务端核 path periodId=body periodId。
- 验收：无商品项目可规划但无法通过订单入口；已承诺金额不能静默修改；同一幂等键重试不会再加一行。

### B02｜AI 草案和 Agent 工具权限

- 基于 A `BudgetBasis`、B 的用户目标/每日项目/可买商品，生成结构化每日建议、可调项和意外情况选项，写 `planning_drafts`；模型输出必须通过模式校验、商品存在性校验和 A 逐日财务评估。
- 对**新消费者流程**代码级限定模型工具为本人授权读取、生成/保存待确认草案。移除或隔离新流程对旧 `create_order/request_payment/pause_purchases/submit_change` 执行工具的访问；不能只在 prompt 写“请勿执行”。历史已授权订单善后如继续保留 Agent 执行工具，仍经原授权与统一最终准入，不允许扩大范围。
- 最小化模型输入，不上传账户密钥、支付凭据、病史和不必要的逐笔流水；健身/饮食建议非医疗建议。验收：伪造模型建议不能创建订单、降储蓄目标或触发退款。

### B03｜购买意图、报价关联和待确认摘要

- 实现 `POST /api/purchase-intents`；用户先选择真实 quoteId，B 核 quoteSource/有效期/商品规则，调用 A preview，展示估价、报价、差额、储蓄/逐日影响与取消规则。
- 仅对本人、同周期预算项目建立 `purchase_intents`，绑定 funding assessment、financial/period/quote 三版本和到期时间；needs_adjustment/blocked/unknown 不包装成“可以买”。商品报价变化要新报价、新评估、新意图，保留旧证据。
- 用模拟 A 响应并行开发，交接时改接真实函数。验收：跨主人引用失败，同一项目不出现两个活跃意图，报价 ¥99 不能在确认阶段换成 ¥109。

### B04｜消费者确认、订单与支付交接

- 实现 `POST /api/purchase-intents/:id/confirm`，只允许本人直接请求。核确认金额=有效报价、确认范围/规则/版本/到期；与 A 的最终准入在同一事务内把意图 confirmed→ordered、创建**新订单形状**（预算/意图有值，旧计划/商户/授权列为空），写预算事件。
- 实现新订单读取与 `payment-handoff`；检查本人、报价、资金最新状态、固定支付业务号、幂等和环境。交接只能跳沙盒/受控支付适配，不替用户输入密码或宣称自动扣款。支付结果 unknown 时停止重试建单，使用原业务号复核。
- 验收：账户级并发准入、重复确认/回调不重复下单，旧 2 条订单仍能按原字段查询和善后。

### B05｜Worker、新旧订单范围与支付/退款事件回传

- 检查旧 Worker、jobs、operations、payment_attempts、refund_batches、manual_tasks 中 `plan_id/merchant_id/confirmation_id` 必定非空的代码假设；为新 `budget_period_id` 形状增加受控路径，不直接让旧路径读 NULL。
- 受理/lease/恢复/复核继续保持固定业务号；支付成功、失败、未知、关单、取消、退款分批明确分状态。把受信渠道核验结果转成 `VerifiedMoneyEvent` 给 A，不能仅靠支付宝沙盒通知更新 Demo/银行现金。人工恢复是后端运营职责，不新增消费者可见商户管理员入口。
- 验收：未知支付不会二次下单；退款申请、渠道成功、实际到账状态分明；并发 Worker 不重复应用事件。

### B06｜意外开支、调整确认、取消和善后

- 实现 `POST /api/emergencies/assess`；用户报告意外金额/日期/理由后，B 提出延期、替换、缩减、取消等结构化选项，A 为每个选项逐日计算资金与储蓄影响，存 `budget_adjustment_proposals`。
- 实现 `POST /api/adjustments/:id/confirm`；本人选 optionId，核资金/周期版本、确认范围、取消费用/预期退款，A 更新预算事实，B 受理旧或新订单的停止/取消/退款。已支付退款需要渠道规则和受控责任，不能把申请金额写成已到账资金。
- 验收：¥400 意外时缺口和选项可解释；AI 不自动降低 ¥500 目标；已付款取消拒绝/延迟/分批退款有可恢复状态，历史订单仍可追踪。

### B07｜消费者闭环证据与 API 交接

- `budget_events` 记录建议、报价、确认、订单、结果、调整和善后的可追溯摘要；统一新 API `{data,meta}`、错误码和权限。前端本阶段不改，但提供可调用的路径、样例 JSON、运行步骤、Demo/沙盒限制与未知状态说明。
- 与 A 共同完成从预算到复盘的消费者故事，不以商品分类数量或 AI 文案数量充当完成度。验收：仅凭 API 可演示完整因果链，证据不泄露密钥或模型思维链。

## 8. 两人怎么并行、在哪里必须会合

现有代码定位：A 主要新增/维护账户、预算和财务核算路由与领域函数，并负责 Demo 资金事实；B 主要检查 `routes/api.ts`、`routes/agent.ts`、`domain/business-actions.ts`、`domain/agent-tools.ts`、`domain/worker-runtime.ts`、`domain/channel-worker.ts` 及目录/支付种子。现有 `db/seed.ts` 同时涉及 A/B 数据，约定一名合并人或各自先实现独立局部种子逻辑，不同时直接改同一段。`app.ts` 的路由注册、`packages/contracts/src/index.ts`、统一错误/幂等和同事务下单函数也是交汇文件，先约定合并人再改；两人不要同时在巨大的旧 `routes/api.ts` 内穿插新资金代码。可以新增小而直接的领域/路由文件，不必受旧文件布局束缚，也不为未来假想需求预建框架。

| 阶段 | A 独立交付 | B 独立交付 | 双方交接/门禁 |
| --- | --- | --- | --- |
| 0：基线同步（约 1–2 天） | Demo 账户/快照/预算样例 | Demo 商品/¥99 报价样例 | **先确认远端已包含迁移和契约**；核同一 JSON、错误、日期、锁顺序；不同时改同一公共文件 |
| 1：可独立工作（约 3–5 天） | A01–A03，`BudgetBasis`、项目受控写函数 | B00–B02，项目入口、只读 AI 草案、报价 | B 用固定模拟 A 响应，A 用固定报价输入；无须等对方全完成 |
| 2：第一集成（约 3–5 天） | A04–A05，preview 与内部 commit | B03–B04，意图/本人确认/新订单 | 同一事务账户优先锁、版本/报价重读；跨计划防双花与旧入口策略通过才合并 |
| 3：结果和意外（约 3–4 天） | A06，核验资金事件/复盘 | B05–B06，Worker/取消/退款/调整 | `VerifiedMoneyEvent` 去重、未知停机、退款到账分离、¥400 意外方案闭环 |
| 4：后端验收（约 2–3 天） | 逐日现金流、授权/来源/资金测试 | Agent 权限、订单/Worker/接口测试 | 统一 API 文档、Demo 演示、旧订单恢复；前端只收契约，本阶段不排 UI |

两人分别维护自己的领域文件；共享契约、跨表迁移和同事务函数由双方审核。分支可以各自开发，但不能各自修改已执行的 013–022 或产生相同迁移编号。对需要补字段的真实缺口追加 023+，不得重写已执行 SQL、清库或删除旧表。涉及历史订单、资金事件、授权或隐私的修改先对照本文件约束并做定向验证。

## 9. 最终后端验收清单

1. 完整 Demo：¥2,000、¥500 储蓄、¥900 必要、¥400 可调；用户自己加晚餐 ¥80，无商户也参加预算；报价 ¥99 时只新增 ¥19，用户确认后才可下单。
2. ¥400 意外支出和跨月/逐日预测返回可解释缺口/未知日期；“月末看似够、月中先透支”必须阻止购买，不自动降低储蓄目标。
3. 同账户多个目标不能双花；三个版本、报价有效期、商品规则、本人确认、幂等键和账户授权在后端生效；Agent 没有代码级绕行工具。
4. 预计收入、信用额度、待退款、支付未知、渠道请求成功但银行未到账都不能冒充可用现金；一笔商品只计一次估价/订单/已付/到账转换。
5. 新订单成功、失败、未知、关单、取消申请、退款分批/到账有可恢复状态；同提供方事件或前端重复点击不新增第二笔订单/流水；旧 2 条订单仍能查询/善后。
6. 新消费者路由类型、权限、错误和时间/金额契约一致；普通消费者无法伪造银行事实或访问他人账户；沙盒/模拟能力被清楚标记而非声称真实银行集成。
7. 新业务的定向测试通过；旧 Agent 全局队列计数测试的不稳定原因完成隔离，不能把某一次 55/55 说成持续稳定的全量门禁。

## 10. 开工时的第一句话

数据库**结构**和共享**字段定义**已经在本机准备好，但新财务表没有样例事实，新消费者路由没有实现。确认远端基线并在两位开发者各自的 PostgreSQL 中应用迁移后，A 从 Demo 资金事实和逐日核算开始，B 从每日项目、只读 AI 草案和 Demo 报价开始；两人在最终准入与结果回传两个节点会合。这样可以并行，不会让任何一人独自决定资金、确认或支付的边界。
