# 接口与支付集成契约：银行场景下的青年消费规划

> 消费者新产品的 A/B 后端共同字段、状态和当前接口，现以项目根目录《行止_AB后端开发总方案_现状接口数据库任务.md》及 `packages/contracts/src/consumer-backend.ts` 为准。本文件保留旧交易接口说明和早期 M1 设计目标；下文明确标注“设计目标／当前未注册”的内容不能作为前端当前可调用接口。新路径、撤回响应和草稿分支统一见 [A/B 后端总方案](../../行止_AB后端开发总方案_现状接口数据库任务.md)第 5 节。历史路由是否可用仍以代码为准。

| 字段 | 内容 |
| --- | --- |
| 文档编号 | XZ-API |
| 更新日期 | 2026-09-16 |
| 状态 | 001—029、A00—A06、B00—B07 与 M1 补充收口已进入当前代码基线；HTTP 与目标回归通过，M1 后端契约冻结并进入 M2 |
| 适用范围 | 账户范围、轻量流水、30 天规划、登记目录、消费执行、计划变化和支付适配 |
| 实施顺序 | M1 后端迁移与接口 → M2 前端统一工作区 → M3 集中验收 |

本文件替换原“出行计划与善后”接口文档。路径前缀、用户确认、订单、支付、退款、幂等和权限规则沿用当前实现；A00—A06 与 B00—B07 已接入。SQL、种子和实际验证进度见开发计划与验证策略。

## 一、公共约定

### 1.1 传输、身份和金额

所有路径使用 `/api` 前缀。用户身份只来自服务端会话，不能使用请求体中的 `userId`、`merchantId` 或账户标识替代归属判断。消费者只能访问自己的账户、流水、资金规划和消费计划；商户管理员只处理自己的目录、订单和退款职责；审核者只能访问服务端分配计划的脱敏结果。

写请求使用 `Idempotency-Key`；修改既有规划、计划或目录时使用 `expectedVersion`。同一主体、路径、幂等键和相同参数返回原结果，参数不同返回冲突。服务端计算金额和资金影响，客户端或 Agent 只提交选择、用户输入和确认范围。余额、账单和退款金额均为整数分，币种单独返回，首版固定 `CNY`。

数据库时间保存为带时区的 UTC 时间戳，规划响应同时返回 `timezone`（首版 `Asia/Shanghai`）以及按该时区计算的日期。账户快照必须返回：

```json
{
  "asOf": "2026-09-14T08:00:00.000Z",
  "coveredThroughAt": "2026-09-14T08:00:00.000Z",
  "capturedAt": "2026-09-14T08:00:02.000Z",
  "source": "demo"
}
```

`asOf` 是余额事实时间，`coveredThroughAt` 是快照已包含流水的截止时间，`capturedAt` 只表示本地收到时间。刷新快照后，服务端以新基线和覆盖截止点重算，不把旧余额与新快照包含的全量流水相加。

异步业务写接口返回 `operationId` 和受理状态，HTTP 202 不表示支付、退款或银行入账成功。读取接口返回已持久化事实、来源、观察时间、版本和未决事项。财务 source 的总集合为 `demo`、`bank_api`、`user_input`，但各表只接受数据契约规定的子集：账户、快照和已发生流水不接受 `user_input`；还款安排可接受三类来源，用户预计收入和必要支出规划行只使用 `user_input`。交易 `environment` 使用 `simulation`、`sandbox`，必须与财务来源分别返回，不能把测试数据写成工行真实接口结果。

### 1.2 统一响应和错误

普通读取直接返回业务快照；列表使用 `items`、`entries`、`obligations` 或 `plans` 数组，分页时返回 `nextCursor`。涉及条件判断的响应使用以下结构：

```json
{
  "status": "fits|requires_change|conditional|unknown",
  "impactDate": "2026-09-20",
  "reasonCodes": ["RESERVE_BELOW_TARGET"],
  "cashflowVersion": 3,
  "basisSnapshotId": "uuid"
}
```

`status=unknown` 表示资料缺失、覆盖范围不明或外部事实未核验，不能当作“可以购买”。新消费者接口的错误码以共享契约 `consumerApiErrorCodes` 为唯一来源；下表只列当前共享枚举中的代码：

| 错误码 | 含义 |
| --- | --- |
| `UNAUTHENTICATED` | 未登录或会话无效 |
| `RESOURCE_FORBIDDEN` | 资源不属于当前消费者、角色无权访问或对象不可见 |
| `VALIDATION_ERROR` | 请求字段、路径或来源不符合契约 |
| `FINANCE_SCOPE_REVOKED` | 账户授权已撤回，只能读取本地历史事实和继续既有交易善后 |
| `AMOUNT_OUT_OF_RANGE` | 金额不在允许范围内 |
| `IDEMPOTENCY_CONFLICT` | 相同幂等键被复用于不同参数 |
| `VERSION_CONFLICT` | 资金、周期、项目或计划依据版本已变化 |
| `QUOTE_STALE` | 报价已过期、撤回、规则不一致或不再适用于服务日期 |
| `ITEM_NOT_ORDERABLE` | 商品只能展示或规划，不能进入执行链 |
| `INSUFFICIENT_FUNDS` | 当前已知事实不足以满足本次执行的资金条件 |
| `SAVINGS_TARGET_AT_RISK` | 执行会损伤用户确认的储蓄目标，需要先调整 |
| `FINANCE_BASIS_UNKNOWN` | 账户快照、还款或其他资金事实不足以安全计算 |
| `PROVIDER_RESULT_UNKNOWN` | 渠道结果尚未核实，不能继续重复执行 |
| `CONFIRMATION_REQUIRED` | 缺少本人明确确认 |
| `CONFIRMATION_SCOPE_MISMATCH` | 确认范围与本次草稿、账户或操作不一致 |

错误响应继续使用当前 `{ error, message, details? }` 形式。错误详情只返回可解释的业务事实和字段，不返回模型思维链、支付密钥或银行凭据。

## 二、当前实现并继续保留的接口

下表登记当前代码中的主要路由。它们是既有实现基线；M1 通过兼容扩展使新产品使用这些入口，不复制另一套交易 API。

### 2.1 身份和目录

| 路径 | 当前用途与权限 |
| --- | --- |
| `POST /api/sessions` | 本地测试账号登录；服务端创建会话，消费者、商户管理员和审核者共用 |
| `GET /api/session` | 读取当前会话身份 |
| `DELETE /api/session` | 退出并撤销会话 |
| `GET /api/catalog` | 读取 active 登记商品、价格、取消规则、规则版本和模拟结果；需要登录 |
| `GET /api/merchant/catalog` | 商户读取自己的目录；仅商户管理员 |
| `PUT /api/merchant/catalog/:id/rule` | 更新取消规则以及可选的付款／关单／退款模拟结果；需要 `expectedVersion`，仅商户管理员 |
| `GET /api/payment-readiness` | 读取支付宝沙箱配置是否就绪；需要登录，不表示已付款 |

当前 `catalog_items.kind` 已允许 `food`，新目录项返回 `categoryCode`、`purchaseMode` 等字段；`unbooked` 与 `listing` 只能用于规划或推荐。只有登记为 `orderable` 且存在有效报价的商品可以进入购买意图。

### 2.2 生活目标、购买和支付

| 路径 | 当前用途与权限 |
| --- | --- |
| `POST /api/plans` | 用 `purpose` 和 `itemIds` 创建消费计划；当前要求至少一个计划项，消费者写入并带幂等键 |
| `GET /api/plans`、`GET /api/plans/:id` | 读取本人或审核范围内的计划列表和快照；商户不读取消费者计划 |
| `POST /api/plans/:id/purchase-proposals` | 根据计划项生成购买草稿；只读目录并重新计算报价，不产生授权或订单 |
| `POST /api/purchase-proposals/:id/confirm` | 消费者确认购买范围、预算上限和恢复范围；创建确认记录及购买授权，不直接付款 |
| `POST /api/orders` | 按确认和计划项建单；原子检查授权、报价、暂停和计划预算，返回受理的操作 |
| `POST /api/orders/:id/payment-handoffs` | 返回模拟付款状态或支付宝沙箱收银台交接；不能替用户输入支付信息 |
| `POST /api/orders/:id/payment-rechecks` | 消费者主动核验沙箱待付／未知订单；复用同一业务号和限频，不新建支付订单 |
| `POST /api/plans/:id/pause` | 暂停指定计划项或全计划的新购买准入；不冻结银行账户，不撤销善后授权 |

### 2.3 计划变化、操作和证据

| 路径 | 当前用途与权限 |
| --- | --- |
| `GET /api/plans/:id/orders` | 读取计划内有权查看的订单快照 |
| `GET /api/orders/:id/cancellation-quote` | 读取已付款订单的取消费用和可退金额；不产生退款 |
| `POST /api/plans/:id/change-proposals` | 提交保留、停止、关单或取消意图，生成结构化变更草稿 |
| `POST /api/change-proposals/:id/confirm` | 消费者确认善后范围、费用、退款总额和查询期限；分别生成善后／查询授权 |
| `POST /api/change-proposals/:id/execute` | 执行已确认的关单或取消申请；逐项返回操作，不直接替商户退款 |
| `GET /api/operations/:id` | 读取操作状态、结果、来源和观察时间；消费者按归属，审核者按分配范围脱敏读取 |
| `POST /api/operations/:id/rechecks` | 复核既有操作；消费者须有查询授权，商户须有自身订单职责 |
| `GET /api/plans/:id/events` | 按游标读取脱敏计划事件 |
| `POST /api/plans/:id/evidence-exports` | 生成脱敏 JSON／HTML 行迹；消费者本人或审核范围 |
| `GET /api/evidence-exports/:id` | 下载尚未过期的证据导出 |
| `POST /api/plans/:id/aftercare-query-revocations` | 撤回尚未受理的受托善后／查询动作，不删除历史事实 |
| `POST /api/plans/:id/query-authorizations` | 只续期既有订单查询授权，不重新发起取消或退款 |

既有接口的确认仍由真实用户触发。方案草稿只保存可执行选择、金额、规则版本和事实摘要；未选择的目录候选是只读响应，不创建第二个活跃执行方案。结束复盘由计划、订单和退款事实派生，净支出为已付款减已核实退款，不另建复盘表。

### 2.4 商户、Agent 和支付宝

| 路径 | 当前用途与权限 |
| --- | --- |
| `GET /api/merchant/orders` | 商户读取自己的订单 |
| `GET /api/merchant/cancellations`、`POST /api/merchant/cancellations/:id/decisions` | 商户查看取消申请并批准、拒绝或延迟 |
| `GET /api/merchant/cancellations/:id/refund-batches`、`POST /api/merchant/cancellations/:id/refund-batches` | 商户按已批准申请查看或受理固定退款批次 |
| `GET /api/merchant/manual-tasks`、`POST /api/merchant/manual-tasks/:id/actions` | 商户领取人工任务并记录复核；不提供手改资金成功入口 |
| `POST /api/plans/:id/agent-runs` | 消费者在指定计划下启动 Pi 运行；运行只能读取和生成待确认方案，执行工具仍受确认和授权约束 |
| `GET /api/plans/:id/agent-runs/latest`、`GET /api/agent-runs/:id` | 读取最新或指定运行，支持刷新恢复 |
| `POST /api/agent-runs/:id/cancel` | 停止推理，不撤销已经受理的订单操作 |
| `POST /api/payments/alipay/notify` | 支付宝沙箱通知入口；不使用用户会话，按签名、应用、卖家、订单、金额和通知号去重 |

历史计划 Agent 继续复用 `search_catalog`、`get_plan_orders`、`get_cancellation_quote`、`get_operation_status`。新消费者 Agent 的当前工具只见 2.12 节；它不能确认授权、写流水、修改余额或接触银行／支付密钥。

### 2.5 B-Ⅰ 已实现的新消费者接口

B00 的 `GET /api/offers`、`GET /api/offers/:id/quote` 以及 B01 的预算项目新增／修改／取消入口已经注册。B02 新增 `POST /api/ai/planning-drafts` 和 `GET /api/ai/planning-drafts/:id`。写草稿要求消费者会话、同源请求和 `Idempotency-Key`；读取只返回本人草稿，不提供通用状态修改入口。

草稿请求固定为 `{ periodId, expectedFinancialVersion, expectedPeriodVersion, items }`，成功响应外层为 `{ data, meta }`。前三项必须同时为 null 或同时有值。每个 item 只允许 `title`、可空 `plannedOn`、可空 `userEstimatedAmountMinor`、可空 `priority`、`requirements`、可空 `catalogItemId` 和可空 `suggestion`；`suggestion` 使用独立的 `estimatedAmountMinor`，不能覆盖用户估价。`data` 返回 `{ draftId, periodId, status, basisFinancialVersion, basisPeriodVersion, items, missingFields, assessment }`；无账户需求草稿的 assessment 为 null，预算草稿取得 A03 的只读摘要。日常服务已注入真实 A03；资金事实不足时摘要为 `unknown`，账户撤回时返回 `FINANCE_SCOPE_REVOKED`，仍不产生购买授权。

023 已允许需求草稿的周期和两个依据版本成组为空，并补 owner 直接外键。新消费者 Agent 工具白名单仅含 `read_budget_basis`、`search_offers`、`save_planning_draft`，现已通过 `/api/ai/agent-runs` 接入独立 `consumer_planning` 运行。旧 Agent 的建单、付款、暂停和提交变更工具只属于历史已授权计划入口，不注册进新消费者工具目录。

### 2.6 A06 当前资金事件与复盘接口

受控内部 `applyVerifiedMoneyEvent(client, ownerId, VerifiedMoneyEvent, { appliedLedgerEntryId? })` 由 B05/B06 的**受信渠道适配器**在数据库事务中调用，不能通过消费者 HTTP 或模型工具直接写入。B 必须先核验渠道来源与稳定 `providerEventId`；A 核本人新订单、原周期借记账户、订单环境/提供方、金额和账户来源。`payment_posted`/`refund_posted` 必须附 `appliedLedgerEntryId` 且该流水已经 posted、与原订单及金额/方向/来源一致；非到账事件不允许附流水。渠道 pending/unknown/退款申请或仅渠道确认不增加执行现金。Demo simulation 只接受 Demo 来源；支付宝 sandbox 回执不是工行银行流水。重复同内容事件复用原 `eventId`，重用编号改内容或重复引用一条已入账流水返回冲突。024、025 依次增加数据库层不可改写和防直接写表绕过约束。

`GET /api/budget-periods/:id/review` 仅本人消费者可读，响应为 `{ data: BudgetPeriodReview, meta: {} }`；共享结构见 `packages/contracts/src/consumer-backend.ts`。分别返回 `originalSavingsTargetMinor/currentSavingsTargetMinor`、周期内 posted 收支、按原订单归属的已核付款/实际退款、`refundRequestedMinor/refundChannelVerifiedMinor/channelRefundSucceededMinor/refundAwaitingArrivalMinor`、本次可确认现金与 `unknownIssues`。`periodEndUnspentCashMinor` 和 `periodEndTargetGapMinor` 只有 closed 周期存在精确上海月末 observed 余额快照时才非 null。B05/B06 已接入 simulation 资金事件；支付宝回执仍只作为渠道事实，真实银行到账和新沙箱连续链尚未验证。

### 2.7 A02 当前月度预算接口

`POST /api/budget-periods` 正文 `{ accountId, monthStart, savingsTargetMinor, expectedFinancialVersion }`，创建本人借记账户的自然月 draft；同账户同月不可重复。`GET /api/budget-periods`／`GET /api/budget-periods/:id` 只读本人周期、全部项目、`BudgetBasis` 和逐日结果，事实或生命周期不满足时返回 unknown 而非假定零开支。`POST /api/budget-periods/:id/activations` 正文 `{ expectedFinancialVersion, expectedPeriodVersion, confirmedNecessities: true }`，仅当前月 draft 且 observed 可覆盖余额和还款事实齐全时激活；026 的 `necessities_confirmed_at` 明确记录用户确认为零必要开支的情况。`PATCH /api/budget-periods/:id/savings-target` 正文 `{ newTargetMinor, expectedPeriodVersion, reason, confirmedByUser: true }`，本人确认后写目标前后值审计和预算事件。上述写接口均要求消费者会话、同源及 `Idempotency-Key`，响应为 `{ data: { period, items, basis, forecast, targetChangeId? }, meta }`；目标不变时 `targetChangeId=null` 且不加版本。B01 的项目入口现默认注入 A02 内部事务写函数；新增自定义估价只作预算，不构成商品报价和下单许可。

### 2.8 B03 当前购买意图接口

`POST /api/purchase-intents` 正文为 `{ periodId, budgetItemId, quoteId, assessmentId, expectedFinancialVersion, expectedPeriodVersion, expectedQuoteVersion }`。接口只接受本人消费者、同源请求和 `Idempotency-Key`；它复用已经持久化的 A04 评估，不再次调用 preview。创建前核对账户仍授权、周期 active、项目仍 planned、商品和报价仍可购买、评估属于同一项目与报价、三个版本一致、估价与报价未变化、评估未过期且状态为 `allowed`。

`POST /api/purchase-intents/:id/rejections` 正文为 `{ expectedStatus: "proposed" }`，要求本人消费者、同源请求和 `Idempotency-Key`。有效意图转为 `rejected`，已经到期的意图转为 `expired`；两者均保留原评估与报价证据并释放项目的编辑、取消和重新评估入口。确认与放弃采用一致锁顺序并串行化，只有一个状态迁移成功；`confirmed/ordered` 必须转入原订单善后。

到期 `proposed` 意图也会由后续购买评估、项目编辑/取消、意外调整评估等写请求在业务事务内惰性转换为 `expired` 并写入 `purchase_intent_expired` 预算事件；没有定时扫描，只读 GET 不触发转换。惰性释放不推进 financialVersion/periodVersion，也不释放已建单承诺。

成功时仅创建 `status=proposed` 的购买意图和 `purchase_intent_proposed` 预算事件，不确认、不建单、不触发付款。响应 `{ data, meta }` 中 `data` 包含意图／周期／项目／报价／评估标识，用户估价、渠道报价、差额、资金状态、受影响日期、原因、商品规则摘要、到期时间及 `confirmationRequired=true`；`meta` 返回三个版本和到期时间。`needs_adjustment`、`blocked`、`unknown` 分别拒绝为 `SAVINGS_TARGET_AT_RISK`、`INSUFFICIENT_FUNDS`、`FINANCE_BASIS_UNKNOWN`。同一项目的开放意图由项目锁和数据库唯一约束共同限制。B03 成功仍不等于购买授权，必须继续调用 B04 本人确认。

### 2.9 B04 本人确认、订单和支付交接

`POST /api/purchase-intents/:id/confirm` 正文为 `{ acceptedAmountMinor, expectedFinancialVersion, expectedPeriodVersion, expectedQuoteVersion, confirmedByUser: true }`，要求本人消费者、同源请求和 `Idempotency-Key`。接口在唯一数据库事务中调用 A05，重新读取账户、同账户周期、项目、报价、评估和意图；只有确认金额等于当前报价且所有依据仍有效时，才创建一笔新消费者订单并把预算项目置为 `committed`。响应 `{ data, meta }` 返回 `ordered` 意图、新订单及最新版本。`GET /api/orders/:id` 读取本人新订单。

`POST /api/orders/:id/aftercare-previews` 与 `POST /api/orders/:id/aftercare-confirmations` 是本人新订单的独立善后入口。预览正文 `{ action: "close" | "cancel" }`，确认正文 `{ previewId, acceptedFeeMinor, acceptedRefundMinor, confirmedByUser: true }`；两者均要求同源和幂等键。确认重读原单状态与规则后复用现有 operation/job、关单和退款机制。账户撤回或当前资金不足不阻止既有订单善后，也不恢复新购买权限；`refund_requested`、渠道成功和银行 posted 仍是三个不同事实阶段。

`POST /api/orders/:id/payment-handoffs` 复用既有路径并按订单形状分流。simulation 创建固定业务号的 `simulate_payment` 操作和任务，无需用户动作；sandbox 返回支付宝官方收银台地址并要求用户自行确认付款。重复幂等请求或已有操作复用原操作，不新建订单或业务号。账户在首次交接前撤回时返回 `FINANCE_SCOPE_REVOKED`。

### 2.10 B05 支付、退款和恢复

Worker 的 operation/job 可绑定旧 `plan_id` 或新 `budget_period_id`，两者必须且只能存在一种。simulation 支付成功生成明确标注为 `demo` 的 posted 支出流水，再通过 A06 写 `payment_posted`；simulation 退款成功先写 `refund_verified`，再生成 Demo 入账流水和 `refund_posted`。pending/unknown 保留占用和原业务号，不能重新下单或创建替代退款批次。

支付宝通知、付款复核和沙箱退款也按两种订单范围分流。支付宝付款或退款成功只形成渠道核验事实；没有同订单、同金额、同来源的工行 posted 流水时，不写 `payment_posted`/`refund_posted`，不增加确认现金。新消费者人工待办使用 `budget_period_id + responsible_provider`，历史任务继续使用 `plan_id + merchant_id`。

### 2.11 B06 意外调整和善后

`POST /api/emergencies/assess` 正文为 `{ periodId, amountMinor, plannedOn, reason, expectedFinancialVersion, expectedPeriodVersion }`。服务端保存意外支出基线和多个结构化选项，包括保留当前计划、取消一个或全部尚未承诺的可调项目，以及对符合条件的已付款订单发起取消。每个选项都调用 A 的逐日核算；预计退款不作为当前可用资金，因此已付款取消本身不能填平当日缺口。

`POST /api/adjustments/:id/confirm` 正文为 `{ acceptedOptionId, expectedFinancialVersion, expectedPeriodVersion, confirmedByUser: true }`。接口重算选项后写入必要支出、取消本人确认的未承诺项目，并按已记录取消规则创建拒绝、延迟人工复核或固定退款批次。退款申请只写 `refund_requested`，实际到账由 B05/A06 处理。`GET /api/adjustments/:id` 返回方案、确认状态、取消申请和渠道已成功退款金额。

### 2.12 B07 事件与新消费者 Agent

`GET /api/budget-periods/:id/events?cursor=0` 仅本人可读，返回 `{ data: { events }, meta: { nextCursor } }`，每页最多 100 条。事件只保存可追溯业务摘要，不保存密钥、原始支付凭据或模型思维链。

新消费者自然语言入口为 `POST /api/ai/agent-runs`，正文 `{ message, periodId }`，其中 `periodId` 可为 null，以支持未选账户时保存需求草稿；写请求要求同源和 `Idempotency-Key`。详情、列表和取消分别使用 `GET /api/ai/agent-runs/:id`、`GET /api/ai/agent-runs?periodId=&cursor=`、`POST /api/ai/agent-runs/:id/cancel`；详情返回 `artifacts`，列表省略 periodId 时读取本人全部运行，`periodId=null` 只读取无周期运行。刷新读取不重新调用模型。该运行只注册 `read_budget_basis`、`search_offers`、`save_planning_draft`，不能选择商品、修改正式预算或目标、确认购买、建单、支付、取消或退款。旧 `/api/plans/:id/agent-runs` 继续服务历史计划，不与新入口混用。

## 三、早期 M1 财务接口设计目标

以下内容保留早期设计和前端规划。除明确标为“当前已实现”的路径外，均为设计目标，当前未注册、未纳入 M2 可调用基线；不能据此声称已有对应路由。首版账户来自预置 Demo 或银行未来提供的授权适配器；不存在让用户把银行登录密码提交给行止的流程。

### 3.1 账户和余额

`GET /api/finance/accounts`（消费者，当前已实现）返回本人已经登记的账户摘要，包括仍可使用的 `linked` 账户和为历史解释保留的 `revoked` 账户，不直接把所有余额混在列表中。只有 `linked` 账户可以被选为新规划的主账户：

```json
{
  "data": {
    "accounts": [
      {
        "id": "uuid",
        "provider": "demo",
        "accountType": "debit",
        "maskedIdentifier": "****1234",
        "displayName": "日常借记账户",
        "currency": "CNY",
        "status": "linked",
        "source": "demo",
        "lastSnapshotAt": "2026-09-14T08:00:00.000Z"
      }
    ]
  },
  "meta": {}
}
```

`GET /api/finance/accounts/:id/snapshot`（消费者，设计目标，当前未注册）返回该账户已经保存的最新事实：`availableBalanceMinor`、`currentBalanceMinor`、`outstandingMinor`、`creditLimitMinor`、`asOf`、`coveredThroughAt`、`capturedAt`、`factStatus`、`source`。信用额度只作展示，不能成为可安排金额；未知数值返回 `null`。可执行规划必须使用已授权借记账户的 `observed` 快照，并具备可用余额和覆盖截止时间；估算、自报或未知余额只能进入条件说明。账户撤回后仍可读取本人已经保存的历史快照，但该读取不得触发提供方刷新、导入新事实或恢复授权。

账户关联由银行宿主或受控 Demo 配置完成，M1 不开放通用 `POST /api/finance/accounts` 让客户端伪造账户。用户通过以下确定接口撤回行止对账户的使用范围：

`POST /api/finance/accounts/:id/revocations`（消费者，当前已实现）必须携带 `Idempotency-Key`，请求体为 `{ "expectedStatus": "linked" }`。仅账户所有者可以调用；首次成功时把账户改为 `revoked`、记录 `revokedAt`，并将使用该账户的预算周期版本推进。响应返回账户当前状态、`revokedAt`、`financialVersion` 和受影响的 `affectedPeriodIds`。相同幂等键和参数重复提交返回原结果；账户已撤回后使用新的幂等键再次提交，返回当前撤回状态，不重复推进版本。账户不存在或不属于当前消费者时按对象不可见处理。

撤回只停止后续使用，不删除账户、历史快照、流水、规划、订单、确认或退款事实。撤回后禁止刷新新的账户事实、创建或重新关联资金规划；报价、商品选定后的购买预览、购买确认、建单和首次付款交接统一返回 `FINANCE_SCOPE_REVOKED`。既有规划保留历史基准并标记为“账户授权已撤回、当前结果不可继续执行”。已经受理的订单仍可读取，关单、取消、退款、渠道查询和恢复继续按原善后或查询授权处理。M2 页面显示撤回状态、撤回时间和最后一次历史快照时间，不再把该账户列为可选主账户。

### 3.2 轻量流水和还款安排

**2026-09-16 收口补充：** 当前 `GET /api/finance/accounts` 已返回 `ledger` 与 `obligations`，流水同时提供 `originalCategory` 与 `displayCategory`；M1 复用该入口，下面独立 GET 不作为必需新增接口。分类 PATCH 使用独立展示覆盖，不直接 UPDATE 已入账流水。意图退出、新订单独立善后和 Agent 产物/读取路径均已注册并纳入 M2 冻结契约。

`GET /api/finance/ledger?accountId=&from=&to=&cursor=`（设计目标，当前未注册）返回本人账户已经保存的流水，字段包括 `id`、`accountId`、`direction`、`amountMinor`、`occurredAt`、`postedAt`、`status`、`category`、`merchantName`、`source`、`sourceRef`、`orderId` 和 `dedupeKey`。读取按账户归属和时间范围过滤，不能读取别人的账户；账户撤回后只允许读取本地历史记录，不触发外部同步。

`PATCH /api/finance/ledger/:id/category`（当前已实现）请求 `{ "category": "food" }`，带同源和幂等键。仅本人可修改仍在授权范围内流水的 displayCategory，响应保留原始 category；展示覆盖独立保存，金额、账户、来源、时间、入账状态、原始分类和订单关联均不可修改。分类不影响资金计算或资金版本，无需使购买确认失效。

首版不开放手工新增已入账流水接口。用户报告“新增 400 元必要支出”时，保存为资金规划中的必要支出安排，并标为用户输入；如果确实已由测试账户扣款，使用受控 Demo 数据入口产生带来源的流水并关联原安排，不能同时保留同一笔未履行支出。真实银行流水导入不由普通客户端或模型完成。

`GET /api/finance/obligations?accountId=&from=&to=`（设计目标，当前未注册）返回信用卡当期账单、贷款当期还款和分期安排，字段包括 `id`、`liabilityAccountId`、`repaymentAccountId`、`obligationType`、`label`、`dueOn`、`amountDueMinor`、`outstandingMinor`、`status`、`includedInObligationId`、`source` 和 `sourceRef`。`includedInObligationId` 指向已包含某个分期子项的账单；子项可以展示，但不再次加入现金流。

`POST /api/finance/obligations`（设计目标，当前未注册）只补充用户明确提供的近期必要还款，写入 `source=user_input`，不能把信用额度或全部贷款本金伪装成当期应还。请求字段为 `repaymentAccountId`、可空 `liabilityAccountId`、`obligationType`、`label`、`dueOn`、`amountDueMinor`；首版仅补充尚未支付的当期义务，服务端设 `outstandingMinor=amountDueMinor`、`status=upcoming`、`source=user_input`，生成来源引用。关联账户必须归本人所有且有效。银行账单不能由此接口覆盖；账单包含分期的关联只由受控数据导入设置。新增成功使受影响资金规划版本递增。来自银行的同步待真实接口可用后另行实现。

### 3.3 30 天资金规划（设计目标，当前未注册）

`POST /api/cashflow-plans`（消费者）创建一份主账户资金视角。M1 请求最小字段为：

```json
{
  "primaryAccountId": "uuid",
  "reserveTargetMinor": 50000,
  "timezone": "Asia/Shanghai",
  "items": [
    { "lineType": "income", "label": "本月实习收入", "amountMinor": 120000, "dueOn": "2026-09-28" },
    { "lineType": "essential_expense", "label": "房租与生活费", "amountMinor": 130000, "dueOn": "2026-09-20" }
  ]
}
```

`items` 只接收用户补充的预计收入和必要支出，不能把订单、退款批次、银行流水或还款安排复制进来。服务端从账户快照、流水、`finance_obligations` 和关联消费计划动态派生其余行。`horizonStart`、`horizonEnd` 由服务端生成 30 天窗口，不能由客户端扩大为长期资金池。

`GET /api/cashflow-plans`（消费者）返回本人规划列表；`GET /api/cashflow-plans/:id`（消费者）返回完整快照：

```json
{
  "id": "uuid",
  "primaryAccountId": "uuid",
  "timezone": "Asia/Shanghai",
  "horizonStart": "2026-09-14",
  "horizonEnd": "2026-10-13",
  "version": 3,
  "basis": {
    "snapshotId": "uuid",
    "availableBalanceMinor": 260000,
    "asOf": "2026-09-14T08:00:00.000Z",
    "coveredThroughAt": "2026-09-14T08:00:00.000Z",
    "source": "demo"
  },
  "summary": {
    "confirmedInflowsMinor": 0,
    "confirmedOutflowsMinor": 0,
    "futureObligationsMinor": 150000,
    "unsettledCommitmentsMinor": 48000,
    "reserveTargetMinor": 50000,
    "expectedIncomeMinor": 120000,
    "pendingRefundMinor": 0,
    "minimumProjectedMinor": 12000,
    "minimumAt": "2026-09-20",
    "status": "fits"
  },
  "items": [],
  "linkedPlanIds": ["uuid"]
}
```

规划摘要中的确认余额只包含快照基准和覆盖截止点之后、尚未被快照纳入的 `posted` 流水；预计收入和待退款单独返回，默认不进入确认余额。`futureObligationsMinor` 统计观察期内未结清且未被账单覆盖的当期应还，加上用户必要支出安排；可分别通过明细解释，示例合计为 150000 分。`unsettledCommitmentsMinor` 由关联消费计划中的未付款及已付款但尚未反映到账户的安排动态派生，已付款且已反映在账户快照或关联流水中的订单不再扣一次。

`PUT /api/cashflow-plans/:id`（消费者）以完整请求替换保留金额及用户规划行，请求为 `{ expectedVersion, reserveTargetMinor, items }`。已有行携带 `id`，新增行省略 `id`；服务端校验行归属，遗漏的旧行标记 cancelled 并保留历史，新旧行在同一事务落地，版本只递增一次。不能提交派生订单行或银行字段；时区固定 `Asia/Shanghai`，不开放任意变更。重复幂等请求返回原结果，不重复新增行；版本冲突返回 409。账户快照、覆盖截止点、还款事实或关联消费计划发生变化时，服务端递增 `version`，旧可行性卡和购买草稿不再可直接确认。

### 3.4 目标草稿、候选和关联（设计目标，当前未注册）

当前 `POST /api/plans` 仍是历史交易入口，`itemIds` 至少需要一个商品 ID；它没有实现允许空项目的 M1 扩展。新消费者无账户需求草稿应使用 `POST /api/ai/planning-drafts` 的 `periodId=null` 分支，不创建旧计划。允许空项目的 `cashflowState=draft` 仍是设计目标，当前未注册。

`POST /api/plans/:id/cashflow-link`（消费者，设计目标，当前未注册）请求 `{ "cashflowPlanId": "uuid", "expectedVersion": 1 }`。仅允许 `cashflowState=draft` 的新计划关联当前用户的 active 资金规划；旧 `cashflowState=legacy` 的 NULL 计划不得改绑，原订单和善后继续按原授权完成。关联成功后计划状态变为 `active`，服务端返回新的计划版本和资金规划版本。

`POST /api/cashflow-plans/:id/catalog-candidates`（消费者，设计目标，当前未注册）只读筛选已登记目录，最小请求为：

```json
{
  "categoryCode": "hotpot",
  "keywords": ["火锅"],
  "location": "校园周边",
  "availableOn": "2026-09-20",
  "maxPriceMinor": 60000,
  "purchaseMode": "orderable",
  "limit": 10
}
```

响应返回多个候选及 `reasonCodes`、价格、规则版本、取消条件、`purchaseMode` 和只读的 `financialImpact`。该接口不创建交易报价、授权、计划项或订单，不保存推荐结果。价格适配、候选条件和影响日期由服务端确定；AI 只将这些字段解释给用户。

`PATCH /api/plans/:id/goal`（消费者，设计目标，当前未注册）请求 `expectedVersion` 以及待修改的 `purpose`、`targetDate`、`targetBudgetMinor`。用户主动改目标金额不等于提高购买授权上限；更新计划版本并使旧购买草稿失效，已关联资金规划同步递增版本。已付款项不随目标编辑被删除。Agent 仅可通过受控草稿工具保存用户当前消息中明确表达的字段；计划进入 active 后，Agent 只能生成修改建议，由用户通过结构化界面调用本接口。

`PUT /api/plans/:id/selections`（消费者，设计目标，当前未注册）提交用户在结构化界面明确确认的完整选定集合；Agent 没有调用权限：

```json
{
  "expectedVersion": 2,
  "cashflowVersion": 3,
  "items": [
    { "catalogItemId": "uuid", "required": true, "adjustable": false }
  ]
}
```

该集合只编辑尚无订单的计划项。保留项可携带 `planItemId`，新增项只带 `catalogItemId`；同一目录项不重复。服务端读取当前目录，复制名称、kind、价格、规则版本、使用条件和 purchaseMode 为计划项快照，返回明确的 `planItemId`。有订单项必须原样保留，删改此类项返回冲突并引导现有变更链；不能通过替换绕过取消费用。草稿未关联资金规划时省略 cashflowVersion，只能保存用户已经确认的选择意图；关联后必须匹配版本。保存成功递增计划及关联资金规划版本、使旧购买草稿失效。展示型商品可以保留作参考，但不进入可执行报价、确认或订单。商品选择确认与后续购买方案确认是两个独立步骤，前者不产生购买授权。

### 3.5 与现有购买接口的闭合扩展

以下是早期的“旧 plans + cashflow_plans”闭环设计，不是当前新消费者可调用路径。当前已实现的新消费者闭环是 2.8—2.12 的购买意图、本人确认、订单、Worker 和调整接口；本节仅保留用于迁移讨论。

1. 空状态先通过 `POST /api/plans` 创建 `cashflowState=draft`，可没有计划项。Agent 只能保存用户当前消息明确给出的目标、日期、初始预算和需求条件，不自行补值；该非执行草稿不需要逐字段二次确认。
2. 读取 `/api/finance/accounts` 和快照，创建或关联 `cashflow_plan`；同一主账户的多个 `plans` 共享该规划版本。
3. Agent 或界面调用 `POST /api/cashflow-plans/:id/catalog-candidates`，未选候选只读；Agent 只解释和提出待选择方案，用户在结构化界面确认后由消费者会话调用 `PUT /api/plans/:id/selections`；后续购买接口的 `itemIds` 使用返回的计划项 ID，不使用目录商品 ID。
4. `POST /api/plans/:id/purchase-proposals` 继续生成唯一可执行草稿，响应增加 `cashflowPlanId`、`cashflowVersion`、`basisSnapshotId`、`status`、`impactDate` 和 `reasonCodes`。
5. `POST /api/purchase-proposals/:id/confirm` 在现有 `expectedVersion` 外，M1 对 active 规划要求 `cashflowVersion` 和 `basisSnapshotId` 与草稿一致；服务端保存于 confirmation snapshot，并创建原有购买授权。
6. 旧 `POST /api/orders` 仍只接受 `confirmationId` 与 `planItemId`，不应被前端用来替代当前 B03/B04 新消费者路径。早期设计中的 `CASHFLOW_PLAN_REQUIRED`、`CASHFLOW_INSUFFICIENT` 不属于当前共享错误码；新路径分别使用 `FINANCE_BASIS_UNKNOWN`、`INSUFFICIENT_FUNDS` 或 `SAVINGS_TARGET_AT_RISK`，具体以当前代码为准。
7. 报价、购买确认、建单及首次新付款交接均经共用服务重新检查账户归属、linked 状态、active 规划、有效 observed 基准和财务版本；不能仅在关联时检查。`listing`、`unbooked` 或停用商品不能进入可执行报价、确认和订单；报价与确认快照保留 purchaseMode，目录规则变化要求重新预览。目标预算 null 不产生默认授权，确认必须由用户明确购买上限。
8. 付款仍走 `payment-handoffs`、模拟 worker 或支付宝沙箱。没有账户流水关联的已付沙箱订单不自动扣主账户余额，仍保留待账户核对的消费安排，不能释放规划空间。受控 Demo 主链可生成一次明确标注 source=demo 的关联流水，替代该安排；它不是银行到账证明。

财务授权撤回后，上述新购买动作统一返回 `FINANCE_SCOPE_REVOKED`；已受理的订单查询、关单和退款仍依原善后／查询授权处理，不能因账户撤回中断恢复或强制重新关联。对已可能发送的付款先查原业务号，不重发。

变更闭环继续使用 `POST /api/plans/:id/change-proposals`、`POST /api/change-proposals/:id/confirm` 和 `POST /api/change-proposals/:id/execute`。变更草稿响应增加 `cashflowVersion`、`basisSnapshotId`、`impactDate` 和条件状态；涉及新消费的确认再次检查资金规划版本；已受理交易的纯善后使用原独立授权，不因财务范围撤回而堵塞。执行后从订单、退款批次和账户流水动态重算。决策摘要只保留事实版本、规则结果、差异、用户确认、操作和结果，不保存模型思维链。

## 四、资金状态和重复计算的响应口径

### 4.1 可行性卡

候选或变更响应中的 `financialImpact` 是只读派生结构，不是授权：

```json
{
  "status": "fits|requires_change|conditional|unknown",
  "impactDate": "2026-09-20",
  "availableBeforeMinor": 60000,
  "availableAfterMinor": 12000,
  "reserveTargetMinor": 50000,
  "expectedIncomeMinor": 120000,
  "pendingRefundMinor": 8000,
  "reasonCodes": ["WITHIN_RESERVE"],
  "cashflowVersion": 3,
  "basisSnapshotId": "uuid"
}
```

`availableAfterMinor` 默认不加入预计收入和待退款；同日收入与支出先后不明时返回 `unknown` 或注明依赖条件。条件情景可以在响应中单独返回，但不能替代确认前的基础口径。

### 4.2 订单、账单和退款

订单已付款、银行流水已入账、退款渠道成功和退款到账分别返回不同状态。若退款批次已在支付宝或商户侧成功，但主账户没有关联 `posted` 流水，规划只显示 `pendingRefundMinor`，不增加 `availableBalanceMinor`。如果该退款已经出现在快照覆盖范围内，则不再以增量流水重复加入。

信用卡消费流水可以用于分类；信用卡当期账单在还款日作为主账户未来现金流。账单通过 `includedInObligationId` 覆盖分期子项时，子项只展示。实际还款流水关联到相应安排后，不再同时扣账单和还款流水。信用额度永远不进入可安排资金。

同一主账户下多个消费计划共用 `cashflowVersion`。规划表不存订单金额副本；关联订单、未付安排、退款批次和还款安排在读取时派生，并通过现有业务编号和来源去重。现有 `orders.reserved_minor` 仍是购买授权账本的唯一硬占用；规划可行性不形成银行账户冻结。

## 五、Agent、权限和支付边界

历史 Agent 运行继续绑定已有 `planId`。新消费者规划运行使用独立 `consumer_planning` 工作流，可绑定一个本人 `budgetPeriodId`，也可在未选账户时保持为空；它只读取已持久化预算、按条件检索登记商品并保存非执行草稿，不共享旧交易执行工具。

当前新消费者 Agent 可以根据用户当前消息中明确表达的内容保存非执行需求草稿，并返回待选择的解释性文本；`propose_purchase`、`propose_change` 是历史／早期方案形状，不是当前消费者运行的工具或可执行结果。Agent 不得推断缺失金额、降低保留目标或替用户决定优先级，不能调用商品选定、目标 active 修改、购买／变更确认接口，不能写财务流水、改变账户快照、执行商户退款或取得支付凭据。结构化界面是商品选定、active 目标变化和交易确认的唯一入口；用户取消 Agent 运行不撤销已受理订单操作。模型输出和商户目录文本都是输入资料，不能覆盖金额、授权、订单和退款事实。

支付环境继续沿用现有适配：

- `simulation` 只调用本地模拟 worker，默认日常开发使用；模拟付款、关单和退款结果是测试事实。
- `sandbox` 使用支付宝沙箱的固定业务号、收银台交接、主动查单和可选通知；只有渠道查询或验签后的结果才能写入沙箱订单事实。
- 支付宝沙箱成功不代表工行账户已扣款，退款成功不代表主账户已到账；两者不能自动写成 `bank_api` 流水。
- 任何登录密码、支付密码、应用密钥和证书都不进入请求体、Agent 上下文、日志或导出。

## 六、迁移、兼容和阶段门槛

M1 已按 013—029 的增量结构落入当前代码基线；A00—A06、B00—B07 与 M1 补充收口已有实现，simulation 领域检查、消费者 HTTP 连续验收和 74/74 目标套件均已在隔离数据库登记通过。已有 `/api/catalog`、`/api/plans`、购买、变更和支付路径继续保留，新消费者路径按预算周期和购买意图分流。

迁移后，旧 `plans` 回填 `cashflowState=legacy` 且 `cashflowPlanId=NULL`；它们只能完成迁移前已受理的订单、关单、退款和核验。新空状态计划明确写 `cashflowState=draft`，可以没有账户规划但只能编辑；关联 active 规划后才允许新购买确认和建单。旧订单不得搬到新规划，不能通过旧路径绕过资金准入。

| 阶段 | API 工作 | 状态 |
| --- | --- | --- |
| M1 后端 | A00—A06、B00—B07、001—029、补充收口和统一 API 证据 | 集中验收通过（HTTP 连续链、74/74 套件、真实模型代表性检查），M2 契约冻结 |
| M2 前端 | 基于已有快照和新规划响应统一空状态、记账、规划、候选、确认、支付与变化调整 | 未开始 |
| M3 集中验收 | 一次性核对权限、余额基准、快照覆盖、去重、跨计划、模拟／沙箱隔离和完整演示 | 未开始 |

M1 的 API 验收必须能从“空状态目标草稿”走到“账户关联、候选比较、用户确认、建单、支付、突发支出、变更确认、订单／退款结果和规划复算”。只读候选、可行性卡和结束复盘不独立形成账本。现有交易、授权、幂等和支付表及路径继续作为执行基础，新增财务接口只提供解释和现金流准入所需的最小事实。

[数据与事件设计](data-and-events.md) · [开发计划](development-plan.md) · [领域规则](../02-domain/rules-and-state.md) · [运行与保护](../04-quality/operations.md)
