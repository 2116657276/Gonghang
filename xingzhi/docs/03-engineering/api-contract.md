# 接口与支付集成契约：银行场景下的青年消费规划

> 消费者新产品的 A/B 后端共同字段、状态和拟新增接口，现以项目根目录《行止_AB后端开发总方案_现状接口数据库任务.md》及 `packages/contracts/src/consumer-backend.ts` 为准。本文件保留旧交易接口说明和早期 M1 设计，不应把下文的拟新增路径误认作已经实现。

| 字段 | 内容 |
| --- | --- |
| 文档编号 | XZ-API |
| 更新日期 | 2026-09-15 |
| 状态 | 新方向接口目标；现有交易接口继续可用，财务规划接口与契约扩展属于 M1 设计，尚未实现 |
| 适用范围 | 账户范围、轻量流水、30 天规划、登记目录、消费执行、计划变化和支付适配 |
| 实施顺序 | M1 后端迁移与接口 → M2 前端统一工作区 → M3 集中验收 |

本文件替换原“出行计划与善后”接口文档。路径前缀、用户确认、订单、支付、退款、幂等和权限规则沿用当前实现；新增的账户与规划接口明确标为“拟新增”。当前代码不因本文件而自动获得新能力，账户及规划路由仍待实现；SQL 和种子的实际进度见开发计划。

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

`status=unknown` 表示资料缺失、覆盖范围不明或外部事实未核验，不能当作“可以购买”。主要错误保持现有 HTTP 语义，并为 M1 增加少量明确错误：

| 错误码 | 含义 |
| --- | --- |
| `FINANCE_SCOPE_FORBIDDEN` | 账户不属于当前消费者或不在授权范围 |
| `CASHFLOW_PLAN_REQUIRED` | 新确认／建单没有关联 active 资金规划 |
| `CASHFLOW_VERSION_CONFLICT` | 余额基准、规划行或同账户其他计划已经变化 |
| `BALANCE_BASIS_INCOMPLETE` | 快照缺少覆盖截止点或余额范围不能安全计算 |
| `DUPLICATE_FINANCE_SOURCE` | 同一账户、来源和外部引用已保存 |
| `OBLIGATION_ALREADY_COVERED` | 账单已覆盖该分期，不能再次加入现金流 |
| `CASHFLOW_INSUFFICIENT` | 按当前已知事实在影响日期前不能满足保留目标或必要支出 |
| `FINANCE_DATA_UNKNOWN` | 银行、账单或退款事实仍待核对 |
| `FINANCE_SCOPE_REVOKED` | 主账户授权已撤回，只能读取本地历史事实和继续既有交易善后 |
| `QUOTE_STALE`、`CONFIRMATION_SCOPE_MISMATCH`、`VERSION_CONFLICT` | 继续沿用现有报价、确认和计划版本错误 |

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

当前 `catalog_items.kind` 允许 `transport`、`stay`、`activity`、`unbooked`；`unbooked` 只能留在消费计划中。M1 扩展共享类型和数据库约束后才允许 `food`，新目录项还要返回 `categoryCode`、`purchaseMode` 等字段。未登记为可执行的商品只能推荐或跳转，不能走订单接口。

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

当前模型工具的 `search_catalog`、`get_plan_orders`、`get_cancellation_quote`、`get_operation_status` 继续复用。M1 可以把财务快照加入只读工具，但 Agent 不能确认授权、写流水、修改余额或接触银行／支付密钥。

## 三、M1 拟新增的财务接口

以下路径和字段是设计目标，当前不存在。首版账户来自预置 Demo 或银行未来提供的授权适配器；不存在让用户把银行登录密码提交给行止的流程。

### 3.1 账户和余额

`GET /api/finance/accounts`（消费者）返回本人已经登记的账户摘要，包括仍可使用的 `linked` 账户和为历史解释保留的 `revoked` 账户，不直接把所有余额混在列表中。只有 `linked` 账户可以被选为新规划的主账户：

```json
{
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
}
```

`GET /api/finance/accounts/:id/snapshot`（消费者）返回该账户已经保存的最新事实：`availableBalanceMinor`、`currentBalanceMinor`、`outstandingMinor`、`creditLimitMinor`、`asOf`、`coveredThroughAt`、`capturedAt`、`factStatus`、`source`。信用额度只作展示，不能成为可安排金额；未知数值返回 `null`。可执行规划必须使用已授权借记账户的 `observed` 快照，并具备可用余额和覆盖截止时间；估算、自报或未知余额只能进入条件说明。账户撤回后仍可读取本人已经保存的历史快照，但该读取不得触发提供方刷新、导入新事实或恢复授权。

账户关联由银行宿主或受控 Demo 配置完成，M1 不开放通用 `POST /finance/accounts` 让客户端伪造账户。用户通过以下确定接口撤回行止对账户的使用范围：

`POST /api/finance/accounts/:id/revocations`（消费者，拟新增）必须携带 `Idempotency-Key`，请求体为 `{ "expectedStatus": "linked" }`。仅账户所有者可以调用；首次成功时把账户改为 `revoked`、记录 `revokedAt`，并将使用该账户的资金规划版本各递增一次。响应返回账户当前状态、`revokedAt` 和受影响的 `cashflowPlanIds`。相同幂等键和参数重复提交返回原结果；账户已撤回后使用新的幂等键再次提交，返回当前撤回状态，不重复推进规划版本。账户不存在或不属于当前消费者时按对象不可见处理。

撤回只停止后续使用，不删除账户、历史快照、流水、规划、订单、确认或退款事实。撤回后禁止刷新新的账户事实、创建或重新关联资金规划；报价、商品选定后的购买预览、购买确认、建单和首次付款交接统一返回 `FINANCE_SCOPE_REVOKED`。既有规划保留历史基准并标记为“账户授权已撤回、当前结果不可继续执行”。已经受理的订单仍可读取，关单、取消、退款、渠道查询和恢复继续按原善后或查询授权处理。M2 页面显示撤回状态、撤回时间和最后一次历史快照时间，不再把该账户列为可选主账户。

### 3.2 轻量流水和还款安排

`GET /api/finance/ledger?accountId=&from=&to=&cursor=`（消费者）返回本人账户已经保存的流水，字段包括 `id`、`accountId`、`direction`、`amountMinor`、`occurredAt`、`postedAt`、`status`、`category`、`merchantName`、`source`、`sourceRef`、`orderId` 和 `dedupeKey`。读取按账户归属和时间范围过滤，不能读取别人的账户；账户撤回后只允许读取本地历史记录，不触发外部同步。

`PATCH /api/finance/ledger/:id/category`（消费者，拟新增）请求 `{ "category": "food" }`，带幂等键。只修改本人仍在授权范围内流水的分类，返回更新后的记录；金额、账户、来源、时间、入账状态和订单关联均不可修改。分类不影响资金计算，无需使购买确认失效。

首版不开放手工新增已入账流水接口。用户报告“新增 400 元必要支出”时，保存为资金规划中的必要支出安排，并标为用户输入；如果确实已由测试账户扣款，使用受控 Demo 数据入口产生带来源的流水并关联原安排，不能同时保留同一笔未履行支出。真实银行流水导入不由普通客户端或模型完成。

`GET /api/finance/obligations?accountId=&from=&to=`（消费者）返回信用卡当期账单、贷款当期还款和分期安排，字段包括 `id`、`liabilityAccountId`、`repaymentAccountId`、`obligationType`、`label`、`dueOn`、`amountDueMinor`、`outstandingMinor`、`status`、`includedInObligationId`、`source` 和 `sourceRef`。`includedInObligationId` 指向已包含某个分期子项的账单；子项可以展示，但不再次加入现金流。

`POST /api/finance/obligations`（消费者）只补充用户明确提供的近期必要还款，写入 `source=user_input`，不能把信用额度或全部贷款本金伪装成当期应还。请求字段为 `repaymentAccountId`、可空 `liabilityAccountId`、`obligationType`、`label`、`dueOn`、`amountDueMinor`；首版仅补充尚未支付的当期义务，服务端设 `outstandingMinor=amountDueMinor`、`status=upcoming`、`source=user_input`，生成来源引用。关联账户必须归本人所有且有效。银行账单不能由此接口覆盖；账单包含分期的关联只由受控数据导入设置。新增成功使受影响资金规划版本递增。来自银行的同步待真实接口可用后另行实现。

### 3.3 30 天资金规划

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

### 3.4 目标草稿、候选和关联

新空状态可以继续使用现有 `POST /api/plans` 建立目标草稿。M1 对现有请求做向后兼容扩展：`itemIds` 可为空但仅允许生成 `cashflowState=draft`；`purpose` 作为目标标题，增加可空 `targetDate` 和 `targetBudgetMinor`（正整数分），并允许返回 `cashflowPlanId=null`。草稿可由用户和 Agent 补充，不能创建购买授权、订单或付款交接。未知目标预算保持 null，不能继承 `purchase_limit_minor` 的旧默认值。目标日期或资金范围不足时可行性为 unknown。

`POST /api/plans/:id/cashflow-link`（消费者，拟新增）请求 `{ "cashflowPlanId": "uuid", "expectedVersion": 1 }`。仅允许 `cashflowState=draft` 的新计划关联当前用户的 active 资金规划；旧 `cashflowState=legacy` 的 NULL 计划不得改绑，原订单和善后继续按原授权完成。关联成功后计划状态变为 `active`，服务端返回新的计划版本和资金规划版本。

`POST /api/cashflow-plans/:id/catalog-candidates`（消费者，拟新增）只读筛选已登记目录，最小请求为：

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

`PATCH /api/plans/:id/goal`（消费者，拟新增）请求 `expectedVersion` 以及待修改的 `purpose`、`targetDate`、`targetBudgetMinor`。用户主动改目标金额不等于提高购买授权上限；更新计划版本并使旧购买草稿失效，已关联资金规划同步递增版本。已付款项不随目标编辑被删除。Agent 仅可通过受控草稿工具，把用户当前消息中明确表达的字段写入 `cashflowState=draft` 的计划；计划进入 active 后，Agent 只能生成修改建议，由用户通过结构化界面调用本接口。

`PUT /api/plans/:id/selections`（消费者，拟新增）提交用户在结构化界面明确确认的完整选定集合；Agent 没有调用权限：

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

购买闭环保持原路径，M1 只增加资金规划版本和目标字段：

1. 空状态先通过 `POST /api/plans` 创建 `cashflowState=draft`，可没有计划项。Agent 只能保存用户当前消息明确给出的目标、日期、初始预算和需求条件，不自行补值；该非执行草稿不需要逐字段二次确认。
2. 读取 `/api/finance/accounts` 和快照，创建或关联 `cashflow_plan`；同一主账户的多个 `plans` 共享该规划版本。
3. Agent 或界面调用 `POST /api/cashflow-plans/:id/catalog-candidates`，未选候选只读；Agent 只解释和提出待选择方案，用户在结构化界面确认后由消费者会话调用 `PUT /api/plans/:id/selections`；后续购买接口的 `itemIds` 使用返回的计划项 ID，不使用目录商品 ID。
4. `POST /api/plans/:id/purchase-proposals` 继续生成唯一可执行草稿，响应增加 `cashflowPlanId`、`cashflowVersion`、`basisSnapshotId`、`status`、`impactDate` 和 `reasonCodes`。
5. `POST /api/purchase-proposals/:id/confirm` 在现有 `expectedVersion` 外，M1 对 active 规划要求 `cashflowVersion` 和 `basisSnapshotId` 与草稿一致；服务端保存于 confirmation snapshot，并创建原有购买授权。
6. `POST /api/orders` 仍只接受 `confirmationId` 与 `planItemId`。服务端先锁定 active 资金规划，检查同账户下其他关联 `plans` 的已支付、待付／未知订单和本次影响，再进入原有计划预算占用；资金规划没有成功准入时返回 `CASHFLOW_PLAN_REQUIRED` 或 `CASHFLOW_INSUFFICIENT`。
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

Agent 运行继续绑定已有 `planId`，可以绑定 `cashflowState=draft` 的新目标草稿，因此不需要新建全能会话表。建议 M1 增加一个只读 `get_cashflow_snapshot` 工具，输入只接受当前计划或当前规划引用；`search_catalog` 增加类别、位置、日期和价格过滤。它们只能返回已持久化数据和计算结果。

Agent 可以根据用户当前消息中明确表达的内容保存非执行目标草稿，并生成 `propose_purchase`、`propose_change` 或待选择建议；不得推断缺失金额、降低保留目标或替用户决定优先级。Agent 不能调用商品选定、目标 active 修改、购买／变更确认接口，不能写财务流水、改变账户快照、执行商户退款或取得支付凭据。结构化界面是商品选定、active 目标变化和交易确认的唯一入口；用户取消 Agent 运行不撤销已受理订单操作。模型输出和商户目录文本都是输入资料，不能覆盖金额、授权、订单和退款事实。

支付环境继续沿用现有适配：

- `simulation` 只调用本地模拟 worker，默认日常开发使用；模拟付款、关单和退款结果是测试事实。
- `sandbox` 使用支付宝沙箱的固定业务号、收银台交接、主动查单和可选通知；只有渠道查询或验签后的结果才能写入沙箱订单事实。
- 支付宝沙箱成功不代表工行账户已扣款，退款成功不代表主账户已到账；两者不能自动写成 `bank_api` 流水。
- 任何登录密码、支付密码、应用密钥和证书都不进入请求体、Agent 上下文、日志或导出。

## 六、迁移、兼容和阶段门槛

M1 预计按数据文档中的 013 起的增量结构迁移及独立 seed 顺序增加财务表、计划关联字段、目录属性和 Demo 夹具；本文件不把拟新增路由写成当前已实现。已有 `/api/catalog`、`/api/plans`、购买、变更和支付路径继续保留，新增字段采用可选或服务端按 `cashflowState` 分流。

迁移后，旧 `plans` 回填 `cashflowState=legacy` 且 `cashflowPlanId=NULL`；它们只能完成迁移前已受理的订单、关单、退款和核验。新空状态计划明确写 `cashflowState=draft`，可以没有账户规划但只能编辑；关联 active 规划后才允许新购买确认和建单。旧订单不得搬到新规划，不能通过旧路径绕过资金准入。

| 阶段 | API 工作 | 状态 |
| --- | --- | --- |
| M1 后端 | 实现账户、快照、轻量流水、还款安排、30 天规划、目录筛选、版本确认和新闭环扩展 | 设计完成，尚未实现 |
| M2 前端 | 基于已有快照和新规划响应统一空状态、记账、规划、候选、确认、支付与变化调整 | 未开始 |
| M3 集中验收 | 一次性核对权限、余额基准、快照覆盖、去重、跨计划、模拟／沙箱隔离和完整演示 | 未开始 |

M1 的 API 验收必须能从“空状态目标草稿”走到“账户关联、候选比较、用户确认、建单、支付、突发支出、变更确认、订单／退款结果和规划复算”。只读候选、可行性卡和结束复盘不独立形成账本。现有交易、授权、幂等和支付表及路径继续作为执行基础，新增财务接口只提供解释和现金流准入所需的最小事实。

[数据与事件设计](data-and-events.md) · [开发计划](development-plan.md) · [领域规则](../02-domain/rules-and-state.md) · [运行与保护](../04-quality/operations.md)
