# 行止 A 后端交接与 A/B 手动测试操作指南

更新：2026-09-16 · 工作分支：`jianlin` · 远程发布目标：`main` · 适用：消费者新月度预算产品

> 本文按**当前代码**写，不把规划文档中的未来接口冒充已上线接口。文中金额单位是“分”：`8000` = ¥80，`50000` = ¥500。手动写入只在隔离的本地测试数据库进行；不要用已有历史订单／沙盒凭据所在的数据库做破坏性试验。

## 1. 先回答：A 是不是写完了？

按当前 A00—A06 和 B00—B07 分工，核心领域实现与后端补充收口均已完成，HTTP 集中验收已通过，M1 后端已放行进入 M2。A00 Demo 资金样例提供独立初始化入口；A01 本人账户事实/撤回、A02 自然月预算/项目/目标、A03 逐日现金流、A04 报价和意外预览、A05 同事务最终准入、A06 受控资金事件与月度复盘，以及 B03—B07 购买、Worker、调整、退款恢复和证据读取均已有实现。A02 的项目写函数和 A03 的草稿评估已由 `buildApp` 默认接入 B 路由；当前迁移为 001—029，目标套件最近记录 74/74（隔离库复跑通过，含收口新增 5 组）；服务端与共享契约类型检查通过。

这不是“整个新版产品已完成”。M1 已有证据覆盖受控 simulation 领域主链和补充收口集中验收（见[新版验证策略](docs/04-quality/verification.md)第十四节）；真实银行账户持续同步、新消费者流程的支付宝沙箱连续链、完整 N 案例、统一前端和用户连续操作仍未验证。当前本机 `xingzhi_dev` 的 A00 资金样例尚未加载，演示用隔离场景入口 `db:seed:consumer-scenario` 按需创建；代码、迁移和文档发布到远程 `main` 后，协作者仍须在自己的 PostgreSQL 中按增量执行 001—029 迁移，并按需加载 A00/B00 样例或隔离场景。

| A 编号 | 当前交付 | B 的接入点 | 能否单独手测 |
| --- | --- | --- | --- |
| A00 | 独立 Demo 借记账户、observed ¥2,000 快照、本月 ¥500 目标、¥900 必要、¥400 可调（¥80 晚餐含在内） | B00 的测试目录/报价；B01/B02 测试事实 | 可，须先准备本地测试用户 |
| A01 | 本人账户读取、现金依据、信用/负债与 pending 分离、撤回 | B03/B04/B05 在新执行前复核授权 | 账户列表/撤回可；真实银行同步不可 |
| A02 | 周期创建/读取/激活、目标审计、项目新增/修改/取消 | B01 外层事务把同一个 `PoolClient` 交给 A | 可；完整“新建 draft→激活”需另一测试借记账户，本 Demo 本月周期已 active |
| A03 | 月度和滚动 30 日逐日风险、草稿只读评估 | B02 预算草稿；B05/B06 变化后重算 | 可读评估；跨月未知须联合验证 |
| A04 | `POST /api/finance/assessments`，内部意外/调整选项预览 | B03 使用已保存评估，不自行改价 | 报价购买预览和 B06 意外评估已接入；真实银行事实仍未接入 |
| A05 | `commitPurchaseAssessment` 内部最终准入 | B04 的唯一外层事务及确认建单回调 | B04 消费者确认/建单已接入 simulation；外部付款仍需 M3 沙箱连续验证 |
| A06 | `applyVerifiedMoneyEvent` 内部资金事件及本人周期复盘 GET | B05/B06 的受信渠道/Worker 适配器 | B05/B06 已接入 simulation；事件仍不开放消费者直接写路由 |

## 2. 交给 B 的固定调用顺序

**同一笔购买：** 用户预算项目（A02/B01）→ B00 返回有效 `offerQuote` → A04 `POST /api/finance/assessments` 保存短时评估 → B03 创建本人 `proposed` 意图并绑定现有 `assessmentId` → 用户在 B04 的结构化确认页确认真实报价和规则 → B04 开启**唯一数据库事务**，把相同 `PoolClient` 传给 A05 → A05 锁账户→同账户周期→项目→报价/意图→订单，重读版本、快照、逐日现金和本人确认 → B04 回调在该事务内写一笔正确的新形状 `pending` 订单及意图状态 → A05 验证并把项目置 `committed` → 事务提交成功**之后**，B 才发起外部支付交接。`allowed` 评估本身不是购买授权；`unknown`、`needs_adjustment`、`blocked` 均不得进入建单。

**同一笔付款/退款结果：** B05/B06 先核验真实渠道来源、稳定 `providerEventId` 和订单结果；在自己的事务里把同一个 `PoolClient` 传给 A06 的 `applyVerifiedMoneyEvent(client, ownerId, event, { appliedLedgerEntryId? })`。`payment_pending`、`result_unknown`、`refund_requested`、`refund_verified` 只留证据，不增加确认现金；`payment_posted`/`refund_posted` 必须事先有本人、同订单、同金额、正确方向与来源的 `posted` 借记账户流水，并传其 ID。支付宝沙盒收银台成功不等于工行借记账户扣款，渠道退款成功不等于退款已入账；不能凭支付宝回执伪造 `bank_api` 流水。重复同一事件编号复用原结果，改参复用或重复引用一条流水必须失败。撤回账户或关闭月度周期后的**既有订单善后**仍可记录，不能重新授予新消费资格。

| 接口/函数 | 所属方 | B 必须提供/遵守 | A 的返回或拒绝 |
| --- | --- | --- | --- |
| `applyBudgetItemChange(client, ownerId, input)`、`cancelBudgetItem(...)` | A 写函数，B01 HTTP | 本人会话、路径/正文一致、同源、外层幂等、当前 `expectedPeriodVersion`；不要另写预算事件 | `{ item, basis }`；项目/周期新版本；跨月、旧版本、已承诺或已有意图拒绝 |
| `budgetPlanningDraftPort.assessPlanningDraft(...)` | A03 | 预算草稿必须同时有周期和两个版本；模型输出先通过 B02 严格校验 | 只读 `{ status, shortfallMinor, affectedDates, reasonCodes }`，不写项目/购买评估 |
| `assessPurchasePreview(...)`／已注册的评估 HTTP | A04 | 使用服务端 `quoteId`、项目与三个版本；用户估价和报价分开 | 短时 `assessmentId`、报价替换差额和风险；无可追溯快照时拒绝 |
| `commitPurchaseAssessment(client, input, callback)` | A05 | B04 事务、本人明确 `confirmedByUser=true`、成交确认金额、评估/报价/意图 ID 和版本；回调仅写一笔 pending 新订单 | 新鲜 `allowed` 且回调范围完全正确时返回 `orderId`；错误必须整笔回滚 |
| `applyVerifiedMoneyEvent(client, ownerId, event, options)` | A06 | B 先核原始渠道/Worker 证据；posted 事件传可信 posted 流水 ID | 本人/环境/来源/金额/方向/去重核验；非到账事件绝不改变现金 |
| `GET /api/budget-periods/:id/review` | A06 | B 前端展示“实际已核验”和“仍待到账”分栏 | 月末没有精确上海月底余额快照时，月底未用现金/目标差额为 `null`，不能写成已实际存下的钱 |

共同字段直接使用 `packages/contracts/src/consumer-backend.ts`；B 不另造 `financialVersion`、`periodVersion` 或近义错误码。三个版本各有用途：资金事实/订单承诺改变 `financialVersion`，月度目标/项目/周期改变 `periodVersion`，报价记录使用 `quoteVersion`。B 的幂等事实仅用现有 `idempotency_records`。新订单必须关联 `budget_period_id`/`purchase_intent_id`，旧计划/商户/授权字段为空；旧订单保持旧形状和历史善后路径。新旧订单不能相互“补空列”混用。

## 3. 手测前的环境和安全要求

1. 确认 B 已从远程 `main` 拿到同一版本的所有 A/B **代码及 001—029 迁移文件**。不要只把本机数据库状态当交接；每人分别确认自己的 PostgreSQL 迁移登记已到 029，再按需运行 A00/B00 独立样例入口。
2. 使用**独立本地测试库**。新库先完成迁移和通用测试用户初始化；已有历史/沙盒业务库不要重新运行旧 `db:seed`，因为它会更新旧 A/B/C/D 目录。不要清空或强制覆盖现有数据库。
3. `.env` 仅在本机配置 `DATABASE_URL`、`PORT`、`WEB_ORIGIN`、`SEED_DEMO_PASSWORD`；不要提交、截图公开或把账户/支付密钥放进请求示例。代码默认 `PORT=8787`（与 README 和前端 vite 代理一致），`WEB_ORIGIN=http://localhost:5173`、`PAYMENT_MODE=simulation`；本机 `.env` 可覆盖端口（历史手测曾用 8877），队友若不同，以各自 `.env` 为准，但改端口须同步 vite 代理目标。
4. PostgreSQL/Docker Desktop 应实际就绪；API 可访问。可从仓库根目录启动 `pnpm --filter @xingzhi/server dev`；要同时看旧 Web/Worker 可用 `pnpm dev`。新消费者前端尚未接齐这些 API，下面的步骤使用 PowerShell 或同等 HTTP 客户端，不以旧网页按钮作为验收依据。
5. Demo 样本的快照只在首次初始化时写入；超过 24 小时会因过期而变成 `unknown`。**重新运行种子不会刷新快照，也不应通过改库伪造余额来通过测试。** 若 `cashBasis.dataStatus` 不是 `observed`，标记“资金依据待刷新”，只做只读/错误边界；显式创建新隔离场景已经实现：`pnpm --filter @xingzhi/server db:seed:consumer-scenario <场景标识> <服务日期>`（详见 A/B 总方案第 11 节收口 5 与[运行边界](docs/04-quality/operations.md)），不能把重复运行旧种子当成刷新。

新隔离库的初始化顺序（在仓库根目录执行，先自行核对 `.env` 指向的库）：

```powershell
pnpm db:migrate
pnpm db:seed
pnpm --filter @xingzhi/server db:seed:consumer-finance
```

`db:seed` 使用 `.env` 内本机自设的 `SEED_DEMO_PASSWORD` 创建账号；该密码不是仓库固定值。测试用户为 `consumer-a@xingzhi.local`、`consumer-b@xingzhi.local`、`reviewer@xingzhi.local`。A00 独立初始化输出本机稳定的账户、快照、周期和晚餐项目 UUID；不要手填示例 UUID。

## 4. A 已有 HTTP 的手动操作

以下代码块适用 **Windows PowerShell**，都在新隔离库测试。先启动 API。为了不把密码留在命令历史，交互输入本机测试密码；密码只用于这次会话。

```powershell
$xzBase = 'http://localhost:8787'
$xzOrigin = 'http://localhost:5173'
$xzSecure = Read-Host '本机 SEED_DEMO_PASSWORD' -AsSecureString
$xzPassword = [System.Net.NetworkCredential]::new('', $xzSecure).Password
$xzLoginBody = @{ email = 'consumer-a@xingzhi.local'; password = $xzPassword } | ConvertTo-Json
$xzLogin = Invoke-RestMethod -Method Post -Uri "$xzBase/api/sessions" -Headers @{ Origin = $xzOrigin } -ContentType 'application/json' -Body $xzLoginBody -SessionVariable xzSession
Remove-Variable xzPassword,xzSecure,xzLoginBody -ErrorAction SilentlyContinue
$xzLogin.user.role
```

预期角色为 `consumer`。下列所有请求都传 `-WebSession $xzSession`；写请求另传同源 `Origin` 和**每次新操作独立**的 `Idempotency-Key`。若 API 端口不是代码默认的 8787，先改 `$xzBase`。

### 4.1 本人账户、自然月预算和真实/未知依据

```powershell
$xzAccounts = Invoke-RestMethod -Uri "$xzBase/api/finance/accounts" -WebSession $xzSession
$xzDemo = $xzAccounts.data.accounts | Where-Object { $_.account.displayName -eq '行止 Demo 生活费账户' } | Select-Object -First 1
$xzDemo.account.accountId
$xzDemo.account.financialVersion
$xzDemo.cashBasis.dataStatus
$xzPeriods = Invoke-RestMethod -Uri "$xzBase/api/budget-periods" -WebSession $xzSession
$xzCurrent = $xzPeriods.data.periods | Where-Object { $_.period.accountId -eq $xzDemo.account.accountId -and $_.period.status -eq 'active' } | Select-Object -First 1
$xzCurrent.period
$xzCurrent.basis
$xzCurrent.forecast.status
```

刚初始化的当前月 Demo 应显示：借记账户、`source=demo`、`cashBasis.dataStatus=observed`、确认现金 `200000`、目标 `50000`、必要项目 `90000`、可调项目合计 `40000`；晚餐项目 `8000` 是 `40000` 的组成部分。`expectedIncomeMinor`、pending 退款和信用额度不能加进确认现金。若当前年月、快照有效期或既有测试操作不同，以实际状态解释，不强行要求 `allowed`。

查看单个周期：

```powershell
$xzPeriodId = $xzCurrent.period.periodId
$xzDetail = Invoke-RestMethod -Uri "$xzBase/api/budget-periods/$xzPeriodId" -WebSession $xzSession
$xzDinner = $xzDetail.data.items | Where-Object { $_.title -eq '朋友聚餐' } | Select-Object -First 1
$xzDinner.itemId
$xzDinner.userEstimatedAmountMinor
```

预期晚餐估价为 `8000`、`linkedQuote=null`。估价是规划值，不是成交价。

### 4.2 B02 草稿与 A03 只读评估

下面测试“需求草稿可以缺金额，但不自动变预算事实”。写入后看 `missingFields`，再读预算项目数量，应没有增加。

```powershell
$xzBeforeCount = $xzDetail.data.items.Count
$xzDraftBody = @{
  periodId = $null; expectedFinancialVersion = $null; expectedPeriodVersion = $null
  items = @(@{
    title = '本周想减脂'; plannedOn = $null; userEstimatedAmountMinor = $null
    priority = $null; requirements = @('饮食建议'); catalogItemId = $null; suggestion = $null
  })
} | ConvertTo-Json -Depth 8
$xzDraft = Invoke-RestMethod -Method Post -Uri "$xzBase/api/ai/planning-drafts" -WebSession $xzSession -Headers @{ Origin = $xzOrigin; 'Idempotency-Key' = 'xz-manual-draft-001' } -ContentType 'application/json' -Body $xzDraftBody
$xzDraft.data.missingFields
(Invoke-RestMethod -Uri "$xzBase/api/budget-periods/$xzPeriodId" -WebSession $xzSession).data.items.Count
```

预期缺 `plannedOn`、`userEstimatedAmountMinor`、`priority`，预算项目数仍为 `$xzBeforeCount`。预算草稿分支必须同时填周期、资金版本和周期版本，A03 才给只读风险；草稿 `assessment=allowed` 也不能替用户创建项目或付款。模型工具白名单的定向测试已存在，但目前**不能**用网页自然语言对话宣称实际新 Agent 已调用这些工具。

### 4.3 B00 真实 Demo 报价和 A04 购买评估

在新隔离库从仓库根目录初始化**当日**目录报价（若已初始化相同日期，重复命令不会改报价）：

```powershell
$xzTz = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
$xzToday = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $xzTz).ToString('yyyy-MM-dd')
pnpm --filter @xingzhi/server db:seed:consumer-catalog $xzToday
$xzOffers = Invoke-RestMethod -Uri "$xzBase/api/offers?plannedOn=$xzToday&categoryCode=food" -WebSession $xzSession
$xzOffer = $xzOffers.data.items | Where-Object { $_.code -eq 'CONSUMER-DINNER-99' } | Select-Object -First 1
$xzQuote = Invoke-RestMethod -Uri "$xzBase/api/offers/$($xzOffer.id)/quote?plannedOn=$xzToday" -WebSession $xzSession
$xzQuote.data.priceMinor
```

预期 `CONSUMER-DINNER-99` 的独立报价为 `9900`，不是晚餐项目的用户估价 `8000`。只有 `purchaseMode=orderable` 和有效 quote 才能进入购买评估；`CONSUMER-FOOD-LISTING` 只能展示，不能取得可下单报价。若今天已过报价截止、晚餐项目不在当日、快照不新鲜，则本项应记录 `QUOTE_STALE`／`FINANCE_BASIS_UNKNOWN`，不要人工改 `valid_until` 或快照。

```powershell
$xzDetail = Invoke-RestMethod -Uri "$xzBase/api/budget-periods/$xzPeriodId" -WebSession $xzSession
$xzAssessBody = @{
  periodId = $xzPeriodId; budgetItemId = $xzDinner.itemId
  quoteId = $xzQuote.data.quoteId
  expectedFinancialVersion = $xzDetail.data.basis.financialVersion
  expectedPeriodVersion = $xzDetail.data.basis.periodVersion
  expectedQuoteVersion = $xzQuote.data.quoteVersion
  mode = 'preview'
} | ConvertTo-Json
$xzAssessment = Invoke-RestMethod -Method Post -Uri "$xzBase/api/finance/assessments" -WebSession $xzSession -Headers @{ Origin = $xzOrigin; 'Idempotency-Key' = 'xz-manual-assess-001' } -ContentType 'application/json' -Body $xzAssessBody
$xzAssessment.data | Select-Object assessmentId,replacedEstimateMinor,quotedAmountMinor,incrementalImpactMinor,status,reasonCodes,expiresAt
```

预期金额三项分别为 `8000`、`9900`、`1900`。`status` 由当天资金事实决定；只有新鲜 `allowed` 加上后续 A05 最终复核，才可能进入 B04 建单。现在可继续调用 `POST /api/purchase-intents` 创建 `proposed` 意图，再由本人确认接口完成 B04；不要调用旧计划购买入口来“补完”新流程。评估同一键同参数重试返回原 `assessmentId`；换参数复用该键为 `IDEMPOTENCY_CONFLICT`。评估最多五分钟有效；资金、周期或报价版本变化后必须重新评估。

### 4.4 自定义项目、幂等、版本、跨月与取消

在**隔离库**新增一个目录中不存在的用户自定义项目；用 `categoryCode=user_custom` 避免被误认为已有 food 商品。B01 会返回候选空数组，但项目本身应写入并参加资金规划。

```powershell
$xzDetail = Invoke-RestMethod -Uri "$xzBase/api/budget-periods/$xzPeriodId" -WebSession $xzSession
$xzItemBody = @{
  periodId = $xzPeriodId; itemId = $null
  expectedPeriodVersion = $xzDetail.data.basis.periodVersion
  kind = 'planned_spend'; title = '自己安排的晚餐'
  categoryCode = 'user_custom'; plannedOn = $xzToday
  userEstimatedAmountMinor = 8000; priority = 'adjustable'
  changeReason = '本人新建日常花费'
} | ConvertTo-Json
$xzItemHeaders = @{ Origin = $xzOrigin; 'Idempotency-Key' = 'xz-manual-item-create-001' }
$xzCreated = Invoke-RestMethod -Method Post -Uri "$xzBase/api/budget-periods/$xzPeriodId/items" -WebSession $xzSession -Headers $xzItemHeaders -ContentType 'application/json' -Body $xzItemBody
$xzRepeated = Invoke-RestMethod -Method Post -Uri "$xzBase/api/budget-periods/$xzPeriodId/items" -WebSession $xzSession -Headers $xzItemHeaders -ContentType 'application/json' -Body $xzItemBody
$xzCreated.data.item.itemId
$xzRepeated.data.item.itemId
$xzCreated.data.candidateOffers.Count
$xzCreated.meta.periodVersion
```

预期两次 `itemId` 一致、只新增一行、候选数量为 0、周期版本只增加一次。使用**新幂等键却仍提交旧 `expectedPeriodVersion`** 应是 `VERSION_CONFLICT`；计划日期填下一自然月而路径仍是本周期，应是 `VALIDATION_ERROR`，不得自动挤进当前周期。必要支出 `kind=essential_expense` 必须 `priority=required`。金额不能为 0 或负数。

继续修改和取消这条尚未承诺的项目（每一步使用上一响应返回的最新周期版本）：

```powershell
$xzItemId = $xzCreated.data.item.itemId
$xzEdit = $xzCreated.data.item
$xzPatchBody = @{
  periodId = $xzPeriodId; itemId = $xzItemId
  expectedPeriodVersion = $xzCreated.meta.periodVersion
  kind = 'planned_spend'; title = '自己安排的晚餐'
  categoryCode = 'user_custom'; plannedOn = $xzToday
  userEstimatedAmountMinor = 9000; priority = 'adjustable'
  changeReason = '本人调整预计晚餐费用'
} | ConvertTo-Json
$xzPatched = Invoke-RestMethod -Method Patch -Uri "$xzBase/api/budget-periods/$xzPeriodId/items/$xzItemId" -WebSession $xzSession -Headers @{ Origin = $xzOrigin; 'Idempotency-Key' = 'xz-manual-item-patch-001' } -ContentType 'application/json' -Body $xzPatchBody
$xzCancelBody = @{ periodId = $xzPeriodId; itemId = $xzItemId; expectedPeriodVersion = $xzPatched.meta.periodVersion; reason = '本人取消该晚餐' } | ConvertTo-Json
$xzCancelled = Invoke-RestMethod -Method Post -Uri "$xzBase/api/budget-periods/$xzPeriodId/items/$xzItemId/cancellations" -WebSession $xzSession -Headers @{ Origin = $xzOrigin; 'Idempotency-Key' = 'xz-manual-item-cancel-001' } -ContentType 'application/json' -Body $xzCancelBody
$xzCancelled.data.item.status
```

预期先看到估价 `9000` 与新项目版本，随后状态 `cancelled`，记录仍可在本人预算读取中看到但不再占预算。已 `committed`/`settled` 或有 `proposed`/`confirmed`/`ordered` 购买意图的项目不得用此接口改估价或直接取消，必须走 B06 善后。当前版本下再次取消已 cancelled 项应返回现状，不推进周期版本；使用旧版本仍冲突。

### 4.5 储蓄目标审计与复盘

本 Demo 初始目标 ¥500。**仅在隔离库**测试本人确认调至 ¥600，先取最新周期版本：

```powershell
$xzLatest = Invoke-RestMethod -Uri "$xzBase/api/budget-periods/$xzPeriodId" -WebSession $xzSession
$xzTargetBody = @{
  newTargetMinor = 60000
  expectedPeriodVersion = $xzLatest.data.basis.periodVersion
  reason = '本人确认提高本月储蓄目标'
  confirmedByUser = $true
} | ConvertTo-Json
$xzTarget = Invoke-RestMethod -Method Patch -Uri "$xzBase/api/budget-periods/$xzPeriodId/savings-target" -WebSession $xzSession -Headers @{ Origin = $xzOrigin; 'Idempotency-Key' = 'xz-manual-target-001' } -ContentType 'application/json' -Body $xzTargetBody
$xzTarget.data.targetChangeId
$xzTarget.data.period.savingsTargetMinor
$xzReview = Invoke-RestMethod -Uri "$xzBase/api/budget-periods/$xzPeriodId/review" -WebSession $xzSession
$xzReview.data | Select-Object originalSavingsTargetMinor,currentSavingsTargetMinor,targetChangeCount,confirmedOrderPaymentsMinor,confirmedRefundReceivedMinor,refundAwaitingArrivalMinor,periodEndUnspentCashMinor,reviewStatus
```

预期有非空 `targetChangeId`、当前目标 `60000`，复盘的初始/当前目标为 `50000/60000`，目标变更数加一。周期未关闭、没有精确上海月底 observed 余额事实时，`periodEndUnspentCashMinor=null`；“预计能存”不等于已经实际转入储蓄账户。提交 `confirmedByUser=false` 会被请求校验拒绝；AI 不得替用户调用此 PATCH。目标改变后旧购买评估的周期版本失效，必须重新评估。

### 4.6 draft 与账户撤回的负向测试

本 A00 Demo 的**当前月周期已 active**。想独立手测 `POST /api/budget-periods`，可在隔离库给同账户**下个月**建 draft；未来月不得用本月余额提前激活。想测“当前月 draft 成功激活”，需准备第二个**本人授权借记测试账户及完整 observed 快照**；当前没有公共账户创建 HTTP，不能把旧 Demo active 周期降回 draft。A02 定向数据库测试已覆盖当前月 draft→确认激活及明确确认“必要支出为零”，应作为目前替代证据。

账户撤回必须放在本轮测试**最后**：`POST /api/finance/accounts/:id/revocations`，正文 `{ "expectedStatus": "linked" }`，同源且独立幂等键。预期第一次撤回账户资金版本及关联预算周期版本各推进一次，再次撤回不推进；本人历史 GET 和既有订单复盘仍可读，新预算写入/评估/意图/确认/首次支付交接必须被拒绝为 `FINANCE_SCOPE_REVOKED`。撤回不可用种子“恢复”；不要在多人共用 Demo 数据库上做此项。

## 5. B 接线后追加的联合手动验收

以下联合 HTTP 案例的资金、权限与恢复路径已在验证策略第十四节集中验收中执行（主 API 故事、原单善后、未付款退出与恢复、幂等与权限、Agent 交接、财务展示与隔离场景）；J09 的支付宝沙箱与银行流水隔离仍留 M3。复测或新增用例时继续在隔离环境执行，并将每例记录为：请求时间、本人角色、周期/账户/项目/报价/评估/意图/订单 ID、三个前后版本、HTTP 状态/错误码、订单/支付/退款证据、是否影响确认现金。不要记录密码、密钥、全卡号或原始支付凭据。

| 用例 | 由谁发起/实现 | 必须观察的结果 |
| --- | --- | --- |
| J01 ¥80 用户估价→¥99 服务端报价 | B03/B04 + A04/A05 | 评估差额 ¥19，用户明确确认 ¥99，A05 新鲜复核后仅一笔 pending 新订单；估价不能进入订单成交价 |
| J02 同键重复确认、改参重用键 | B04 | 首次订单 ID 复用，不产生第二笔；改参 `IDEMPOTENCY_CONFLICT` |
| J03 报价过期/撤回、三版本任一变化 | B03/B04 + A05 | 不建单，返回 `QUOTE_STALE`/`VERSION_CONFLICT` 并要求重新评估；外部支付未发起 |
| J04 储蓄目标受损、月中先透支但月底够 | A03/A05 + B04 | 分别 `needs_adjustment`/`blocked`，不可将两者当 `allowed` 下单 |
| J05 同账户多个周期、下一月未建 | A03 + B02/B04 | 一份现金不被两个目标分别重复花；滚动 30 日未知后段保持 `unknown` |
| J06 用户突然生病/出游，调整未承诺项目 | A04 内部意外/选项评估 + B06 | 先预览缺口，再由本人选定调整；B 不直接降低储蓄目标或取消已承诺订单 |
| J07 支付 pending/unknown→核验 | B05 Worker + A06 | 未核结果不写成 paid/posted；可复查，不重复扣现金 |
| J08 模拟已核付款和退款申请→渠道成功→实际到账 | B05/B06 + A06 | 订单/银行流水只各核一次；申请和渠道成功不提前回补现金，posted 退款到账才增加确认现金 |
| J09 支付宝 sandbox 与银行流水隔离 | B05/B06 + A06 | 支付宝成功不自动构造工行 `bank_api` 扣款；实际银行到账须独立来源证据 |
| J10 跨用户/角色、账户撤回、旧入口绕过 | B03—B06 + A | 其他消费者/审核者不能操作本人预算和订单；撤回后不能新执行；旧计划新建单不能绕过 A05，新旧历史善后仍可读 |
| J11 消费者 Agent 实际运行 | B02/B07 + A03 | 模型只能读依据、查目录、存草稿；不能修改目标、确认购买、伪造流水或接触密钥；缺用户估价/日期仍列 missingFields |
| J12 完整月度复盘 | B07 + A06 | 原/现目标、实际 posted 收支、已核付款、退款待到账和月末未知分开；未实际转入储蓄账户前不宣称“已攒下 ¥X” |

特别留意 B04 的事务提交前后顺序，以及 B05 的**来源核验先于 A06 事件入库**。任何新增或复测用例通过前，不得宣称“新版金融 Agent 可以自动支付”或“真实资金闭环已完成”；M1 放行只覆盖受控 simulation 与收口集中验收范围。

## 6. 故障定位和交付检查

| 观察 | 首先检查 |
| --- | --- |
| API 打不开 | Docker/PostgreSQL 实际运行、`.env` 所指测试库、迁移登记已到 029、API 实际 `PORT`，不要只看 Docker Desktop 窗口已打开 |
| 401／403 | 会话 Cookie、消费者角色、写请求 `Origin` 是否等于 `WEB_ORIGIN` |
| `VALIDATION_ERROR` | 日期是否属于当前自然月、路径/正文 ID 是否一致、金额是正整数分、写请求是否带有效幂等键 |
| `VERSION_CONFLICT` | 重新 GET 账户/周期及报价，取最新版本；旧评估不能自动重用 |
| `FINANCE_BASIS_UNKNOWN` | 最新 observed 快照可用余额、覆盖游标、24 小时新鲜度、必要支出确认及还款事实；未知不可填零 |
| `QUOTE_STALE` | 商品 `orderable`、报价日期/规则/版本/有效期；不要靠改目录展示价解决 |
| `FINANCE_SCOPE_REVOKED` | 已撤回账户不能重授新执行；只允许历史读取和既有订单善后 |
| 支付/退款金额与页面不一致 | 分清用户估价、服务端报价、订单确认价、渠道回执、本人借记账户 posted 流水；只最后一种能改变确认现金 |

交付给 B 前再核对：实际发布到远程分支的代码版本、001→029 顺序迁移、B 可调用 A 内部函数的 import/类型、测试账号仅来自本地 `.env`、未把 `.env`/`.local-secrets` 送入 Git、A/B 相关测试在双方库可重复回滚、旧订单不被新 SQL 或初始化覆盖。A00 资金样例、B00 报价和隔离场景是独立种子，不会随 PostgreSQL 数据或 Git 自动同步；本文只提供交接和手测规则，不替代版本发布，也不把本地工作区当成远程已发布状态。

代码入口：[A02 自然月预算](apps/server/src/domain/budget-periods.ts)、[A03 逐日核算](apps/server/src/domain/budget-cashflow.ts)、[A04 购买评估](apps/server/src/domain/purchase-assessment.ts)、[A05 最终准入](apps/server/src/domain/purchase-commit.ts)、[A06 资金事件](apps/server/src/domain/verified-money-event.ts)、[共同契约](packages/contracts/src/consumer-backend.ts)、[现状验证](docs/04-quality/verification.md)。
