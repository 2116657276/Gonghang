# 行止本地运行说明

更新日期：2026-09-16。本文描述当前代码和本地运行边界。新产品文档见[文档中心](docs/README.md)，SQL 与种子改造见[开发计划](docs/03-engineering/development-plan.md)；现有程序与新方向的总体进度以文档中心和验证策略为准。001—029、A00—A06、B00—B07 及 M1 后端补充收口已进入当前代码基线；隔离数据库的类型检查与 74/74 目标套件、消费者 HTTP 连续链、Worker、真实模型有账户/无账户代表性检查均已通过，M1 后端契约已冻结，可以进入 M2 前端联调。新流程支付宝沙箱连续演示、真实银行和 M2 页面验收仍未完成。现有通用 seed 仍是旧 A/B/C/D 数据，新资金样例使用独立初始化入口。

| 项目 | 当前事实 |
| --- | --- |
| 运行组成 | Vue／Vite、Fastify API、worker、PostgreSQL |
| 本地地址 | 网页 `http://localhost:5173`，API `http://127.0.0.1:8787` |
| 支付 | 当前日常 simulation，历史沙箱订单保留原环境；正式演示才按授权使用 sandbox |
| 数据 | 本机 `xingzhi_dev` 保留原交易资料并已应用 001—028（代码基线含 029 收口迁移，本库执行 `pnpm db:migrate` 补齐）；当前有 24 条历史订单和 2 条 Demo 报价，A00 资金账户、快照、预算及项目样例尚未加载，尚无真实银行事实 |
| 凭据 | 仅本机被 Git 忽略的环境与秘密文件，不复制到文档或模型 |

以下命令是已有程序的操作说明，不是要求立即执行。空库执行 `pnpm db:migrate` 会按顺序应用 001—029；本机 `xingzhi_dev` 已完成 001—028，再次执行即补齐 029。运行通用 `pnpm db:seed` 仍只会得到旧 A/B/C/D 目录和测试账号；A00 资金样例须单独初始化，不含真实银行流水或还款样本。

## 首次运行

在行止项目根目录 `xingzhi/` 使用 `.env.example` 创建本地 `.env`，设置独立的 `SEED_DEMO_PASSWORD`，并确认 `DATABASE_URL` 指向 `xingzhi_dev`，不要连接其他项目的数据库。若该库尚未创建，先执行 `createdb xingzhi_dev`；可从仓库根目录执行：

```sh
cp xingzhi/.env.example xingzhi/.env
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`pnpm dev` 同时启动网页、API 与 worker。`pnpm db:migrate` 只应用未执行的顺序 SQL 迁移；`pnpm db:seed` 可重复执行，用于补齐本地测试账号和 A/B/C/D 目录，不写入真实数据。M1 隔离验收场景使用 `pnpm --filter @xingzhi/server db:seed:consumer-scenario <scenario-key> <上海当前日期>`，显式创建新消费者、账户、自然月预算和当日报价；相同场景只返回原记录，不覆盖状态、延长报价或恢复撤回账户。

历史真实模型只读烟测和 T04／T08 方案联调已通过，API-24 提供查询与方案助手入口；Pi 依赖已安装。服务端只从本机 `.env` 读取 `DEEPSEEK_API_KEY`，固定 `DEEPSEEK_BASE_URL=https://api.deepseek.com`，当前配置为 `DEEPSEEK_MODEL=deepseek-flash`（DeepSeek V4.1 Flash，用户简称“ds4.1flash”）；累计模型费用上限为人民币 100 元，采用每分钟 10 次、突发 2、同计划并发 1 的常规服务端限流。[历史验收归档](docs/archive/transaction-verification.md)第十八至二十二节记录原模型、进程恢复、授权连续性及交易核验；现行[新版验证策略](docs/04-quality/verification.md)不沿用这些章节编号。未配置密钥或人民币预算账本时不会发起外部模型调用。

本阶段还提供 `pnpm typecheck` 和 `pnpm test:targeted`。2026-09-16 的 M1 集中验收在独立数据库完成 74/74：除原有 simulation 闭环外，新增覆盖过期/放弃意图、确认竞争、本人原单善后、退款事实分层、Agent 产物恢复、展示分类隔离和可重复场景。真实应用另完成登录会话、Origin、幂等键、报价评估、意图确认、模拟付款、400 元意外支出（缺口 219 元）、可行调整、复盘及原单退款连续链。该结论只放行 M1 后端进入 M2，不证明支付宝沙箱、真实银行或前端 N 案例。公共契约和构建路径变化时仍执行 `pnpm build`。

## 测试账号

种子数据使用两个消费者、一个测试商户管理员和一个只读审核者。邮箱分别是 `consumer-a@xingzhi.local`、`consumer-b@xingzhi.local`、`merchant@xingzhi.local`、`reviewer@xingzhi.local`；密码只取自本机 `.env` 的 `SEED_DEMO_PASSWORD`，不写入 Git。

旧消费者工作台仍保留 A/B/C/D 计划、订单读取及善后等功能；已建立 active 新资金规划周期的消费者不再能走旧计划预算的新建单入口，以免绕过 A05 的账户级准入。新流程已支持 B03 意图、B04 本人确认和付款交接、B05 结果回传、B06 调整善后及 B07 证据读取，但现有前端尚未接入这些入口。商户工作台继续处理旧订单；新消费者订单的自动规则与人工待办由后端责任字段区分。

## 现有证据与新缺口

原交易基础的 55 项检查及首批沙箱核心链见[历史验收](docs/archive/transaction-verification.md)。A00—A06 已提供 Demo 资金样例的独立初始化入口、账户与预算、确定性评估、最终准入、资金事件与复盘；B00—B07 已提供登记目录、预算项目、需求／预算草稿、受限 Agent、购买确认、支付/退款 Worker、意外调整及证据读取。当前本机 `xingzhi_dev` 尚未加载 A00 资金样例，完整演示使用隔离场景入口（`db:seed:consumer-scenario`）；真实银行账户接入、统一页面和新消费者流程的支付宝沙箱连续演示仍待开发，历史类型或行为通过不能覆盖新增实现。

本地运行约束、环境切换及数据清理见[运行边界](docs/04-quality/operations.md)。不得用清库或重写已应用迁移代替新 SQL 迁移，也不得为了新样本删除沙箱交易和模型费用。

### A00 Demo 资金事实与 A01 账户读取

先准备本地测试账号并完成数据库迁移，再从仓库根目录执行 `pnpm --filter @xingzhi/server db:seed:consumer-finance`。入口只给 `consumer-a@xingzhi.local` 初始化稳定的 Demo 借记账户、完整 observed ¥2,000 快照、本月 ¥500 储蓄目标、¥900 必要项目和 ¥400 可调项目；¥80 晚餐包含在 ¥400 内。脚本输出不含密码的固定 UUID/JSON 样例，重复运行不覆盖旧目录、订单或已存在的资金事实；账户被撤回或样例金额被用户改动时会拒绝重置。初始化不会产生真实银行流水、信用负债或可下单授权。

消费者会话可调用 `GET /api/finance/accounts` 读取本人脱敏账户、最后快照、流水状态、还款与展示用预计收入/待核退款/信用信息。执行用现金仅来自本人未撤回借记账户的最新完整 observed 快照，以及快照覆盖截止后已 posted 的同来源流水；晚到旧快照、pending、信用额度、预计收入与待核退款不增加执行现金。当前执行基准要求快照不超过 24 小时；缺失、无覆盖截止或过期时返回 unknown，不把未知填 0。

本人撤回授权调用 `POST /api/finance/accounts/:id/revocations`，正文固定 `{ "expectedStatus": "linked" }`，并携带同源请求与 `Idempotency-Key`。首次撤回在一个事务中使账户资金版本和关联周期版本各推进一次；再次撤回不加版本。已撤回账户仍能看本地历史摘要；A02 新预算写入、A03 新评估、B03 购买意图和 B04 首次付款交接均执行撤回门禁，既有订单查询及善后继续保留。

### A03 只读逐日现金流

服务端内部 `forecastBudgetCashflow` 从 A01 的本人借记现金基准出发，按天合并同账户的未兑现必要/自定义支出、还款及新订单承诺；订单已经由已核验账户流水扣款时不再扣第二次，未到账退款、预计收入与信用额度只列作说明。每日给出现金、储蓄保留线、缺口和受影响日期；同账户多个目标共用同一余额。月底够钱但月中曾透支，仍是 `blocked`。滚动 30 日读相邻月份，缺周期或事实时给 `unknown`，不把空记录视为零开支。当前周期既没有必要／required 项目又没有用户明确确认“必要支出为零”时给 `unknown`；026 增加确认时间字段，A02 激活入口要求本人确认。

B02 关联预算周期的结构化草稿现在由 A03 只读评估端口计算摘要；草稿缺日期、金额或优先级时返回 `unknown`，不拿模型建议补用户输入。评估不写 `budget_items`、`funding_assessments` 或订单；固定样例已验算 ¥200 → ¥181 → ¥219 储蓄缺口。A03 的 `allowed` 不能用于直接下单。

### A04 购买预览与 A05 内部最终准入

消费者会话调用 `POST /api/finance/assessments`，正文固定 `{ periodId, budgetItemId, quoteId, expectedFinancialVersion, expectedPeriodVersion, expectedQuoteVersion, mode: "preview" }`，请求需同源并带 `Idempotency-Key`。服务端重读本人项目和有效、可下单的报价，以真实报价替换用户估价，按购买当日预留全价而非只在未来计划日期扣差额；返回 `FundingAssessment` 并保存不可改写、最长五分钟的证据。¥80 估价／¥99 报价返回估价 8000 分、报价 9900 分、增量 1900 分。`unknown` 的现行共享结构将 `shortfallMinor` 固定为 0，仅表示“缺口不可量化”，**不表示资金足够**；必须结合 `status`/`reasonCodes` 判断。

内部 `assessUnexpectedSpend` 与 `assessAdjustmentOption` 也复用逐日引擎，可在内存中比较意外支出与“取消／改期／调低尚未承诺的可调项目”选项，不改数据库；已承诺订单、必要支出和有开放购买意图的项目不能借预览释放资金。

`commitPurchaseAssessment(client, input, confirmAndCreateOrder)` 是 A05 给 B04 的内部同事务函数，不是 HTTP 付款入口。B04 把本人会话、明确确认金额与版本绑定到请求，并在同一 `PoolClient` 上由回调完成 `proposed → confirmed`、插入一笔 `pending` 订单、再把意图置为 `ordered`；A05 在账户优先锁下重读本人授权、所有同账户预算承诺、报价、意图和最新逐日结果，验证 B 只写出一笔范围正确的订单后才把预算项目置为 `committed`。外部支付交接只在数据库事务提交后发起。旧计划新建单对 active 新资金规划用户返回 `LEGACY_PURCHASE_DISABLED`，旧订单读取及善后不受此门禁影响。A04 `allowed` 或 B03 意图仍不等于已下单，必须经过 B04 本人确认。

### A06 受控到账事件与月度复盘

`applyVerifiedMoneyEvent(client, ownerId, event, { appliedLedgerEntryId })` 仅供 B 的受信渠道/Worker 适配器在数据库事务中调用，不开放消费者写路由。B 先核验原始渠道来源和提供方稳定事件编号；A 再重读本人新订单、支付环境、借记账户来源与金额。`payment_pending`、`result_unknown`、`refund_requested`、`refund_verified` 只留证据，不增加确认现金；`payment_posted`/`refund_posted` 必须关联同订单、同金额、同来源和正确方向的 posted 账户流水。模拟订单只能写 Demo 来源；沙盒收银台回执不能直接写 Demo 或 `bank_api` 到账，沙盒真正到账须另有工行来源账户流水。重复事件返回原事件，改参重用事件编号或重复引用同一到账流水会拒绝。024 锁定已引用流水和新订单成交价；随后追加的 025 让直接写资金事件表也必须通过订单与账户范围校验，不改写已应用的 024。

消费者 `GET /api/budget-periods/:id/review` 返回本人原/当前储蓄目标、已确认周期收支、订单付款、退款申请/渠道确认/实际到账、尚未到账差额和未知事项。目标变更记录与当前目标若不连贯，显示 `TARGET_AUDIT_MISMATCH`/unknown。关闭周期后晚到的账户退款仍归回原订单；只有精确覆盖上海时区月末的 observed 账户快照，才给出“月末剩余现金”和目标缺口，否则保持 null/unknown。B05/B06 已接入受信事件端口并通过 Demo simulation 连续检查；支付宝渠道事实仍不等于真实银行资金同步。

### B00 消费者目录与报价

使用现有消费者会话调用 `GET /api/offers?plannedOn=2026-09-20&categoryCode=food`，再以返回的商品 id 调用 `GET /api/offers/:id/quote?plannedOn=2026-09-20`。成功响应为 `{ data, meta }`，无有效报价返回 409／QUOTE_STALE，展示价格不等同于可执行报价。

在仓库根目录执行 `pnpm --filter @xingzhi/server db:seed:consumer-catalog 2026-09-20` 可初始化该日 Demo 目录报价；日期必须尚未结束。本入口复用已有测试商户账号，不调用旧 A/B/C/D 覆盖种子；不要为初始化新目录重新运行旧 db:seed。重复执行保留既有报价状态与期限，更换日期创建新报价。此入口不写资金账户或预算，不表示购买接口已完成。完整隔离演示场景（独立消费者、账户、周期、快照与匹配日期的报价）使用 `pnpm --filter @xingzhi/server db:seed:consumer-scenario <场景标识> <服务日期 YYYY-MM-DD>`；同标识重复执行不覆盖状态、不延长报价。

### B01 消费者预算项目入口

新增项目使用 `POST /api/budget-periods/:id/items`，编辑使用 `PATCH /api/budget-periods/:id/items/:itemId`，取消尚未执行项目使用 `POST /api/budget-periods/:id/items/:itemId/cancellations`。三者均要求消费者会话、同源请求、`Idempotency-Key`，并校验路径中的周期／项目与正文一致。成功响应包含 A 返回的项目、月度资金依据及当日同分类有效候选报价；候选只供后续选择，不自动关联项目或取得购买资格。

B01 的 HTTP、事务、幂等和响应组装已完成；日常 `buildApp` 现默认接入 A02 的真实项目写函数，接口会落入本人自然月 `budget_items`，返回新周期版本。测试仍可注入固定桩核对 B 入口。消费者自定义估价只参与规划，候选目录报价不写回项目，更不能以估价直接生成订单。

### A02 月度预算与目标

`POST /api/budget-periods` 创建本人借记账户的自然月 `draft`，账户资金版本必须匹配；同账户同月只允许一个周期。`GET /api/budget-periods` 和 `GET /api/budget-periods/:id` 返回本人周期、项目、`BudgetBasis` 和逐日状态。草稿可先添加收入、必要和任意自定义支出，即使余额快照缺失也不伪装可执行。当前月资金快照/还款事实完整后，本人通过 `POST /api/budget-periods/:id/activations` 明确确认必要开支，才转 `active`；确认为零记录 `necessities_confirmed_at`，资金事实不足仍拒绝激活。`PATCH /api/budget-periods/:id/savings-target` 必须由本人确认并给出理由，前后值留在 `budget_target_changes` 和预算事件中。所有写入口需要同源和幂等键，项目/目标更改需要当前周期版本；closed 周期、已进入购买意图或已承诺项目不能直接改写或取消。未来月份可以保留草稿，但不能用本月余额提前激活未来月。

### B02 需求草稿与预算草稿

`POST /api/ai/planning-drafts` 保存严格结构化的待确认草稿，`GET /api/ai/planning-drafts/:id` 仅允许本人读取。未选账户／周期时，`periodId`、`expectedFinancialVersion`、`expectedPeriodVersion` 必须同时为 null；这类需求草稿保留用户明确给出的标题、日期、估价、必要／可调属性和约束，缺失字段由服务端列出，模型建议存放在独立 `suggestion` 对象中。关联预算周期时三个字段必须同时提供，并先调用 A03 的只读评估端口。

草稿引用的目录商品必须仍为 active 且适用于对应日期。响应只包含草稿、缺失字段和可空评估摘要，不提供确认、执行或状态修改入口。新消费者 Agent 的独立工具目录只有读取预算依据、查询登记商品和保存草稿三项，不包含建单、付款、暂停购买或提交变更。当前无账户需求草稿可以使用；关联周期的预算草稿由 A03 评估，事实不足显示 `unknown`，授权撤回明确拒绝。

B02 的结构化 API、共享 schema、023 迁移和工具白名单已经通过 B07 的 `/api/ai/agent-runs` 接入实际 Pi 运行。`model_source=validated_structured_v1` 仍只表示草稿保存前完成结构校验；结构化草稿 API 可以由用户界面直接调用，因此不能仅凭该字段断言某条草稿一定来自模型。
