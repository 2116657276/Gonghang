# 行止：架构、数据与接口导航

> 本文是接手和定位代码的导航，不复制完整 API 手册或所有数据库字段。实际请求/响应以路由实现和 `xingzhi/packages/contracts` 为准；实际数据是否已迁移以目标数据库的 `schema_migrations` 为准。

## 1. 总体结构

```text
Taro + Vue 3 消费者端（H5 / 微信小程序）
        │ Bearer 会话或 H5 Cookie
        ▼
Fastify Server ── 领域规则、权限、幂等、版本校验、事实读取
        │                         │
        ▼                         ▼
PostgreSQL                    Worker / 支付适配
        │                         ├─ Simulation
        │                         └─ 支付宝 Sandbox
        ▼
商户/审核网页 ── 同一订单、预算周期和脱敏证据

消费者 AI 运行层 ── 受控读取工具 ── 规划草稿/建议，不直接执行交易
```

当前架构服务于本地联调和受控竞赛 Demo。银行真实适配器、银行 App 宿主和 Production 渠道不是当前代码已经具备的运行环境。

## 2. 模块职责与入口

| 模块 | 目录 | 主要职责 |
| --- | --- | --- |
| 消费者端 | `xingzhi/apps/miniapp/src` | 登录、资金与账目、自然月预算、需求草稿、候选/报价、购买确认、订单、变化调整、售后、AI 入口和运行状态展示 |
| 消费者请求层 | `xingzhi/apps/miniapp/src/lib` | Taro 请求、Bearer/Cookie 会话、幂等键、API 地址、错误转换和本地恢复 |
| 商户/审核网页 | `xingzhi/apps/web/src` | 历史计划查看、商户目录与订单处理、人工取消和退款批次、审核范围与证据导出 |
| Server 入口 | `xingzhi/apps/server/src/app.ts` | Fastify、Cookie/CORS、会话钩子、错误边界、所有路由注册 |
| Server 路由 | `xingzhi/apps/server/src/routes` | 输入解析、身份/角色边界、调用领域服务、统一响应和幂等写入 |
| 领域层 | `xingzhi/apps/server/src/domain` | 资金核算、预算、报价、意图、订单、善后、Agent、操作恢复、商户和审核事实 |
| 数据库 | `xingzhi/apps/server/src/db` | PostgreSQL 客户端、迁移执行、Demo 目录/资金/场景种子、持久化事实 |
| 支付与异步 | `xingzhi/apps/server/src/payment`、`src/domain/worker-runtime.ts` | Simulation、支付宝 Sandbox、付款/退款操作、通知、复核、Worker 任务和未知结果恢复 |
| 共享契约 | `xingzhi/packages/contracts/src` | 前后端共用的输入 schema、响应视图、状态枚举和 UI 相关类型 |

## 3. 当前消费者主链

新消费者流程使用以下事实顺序，不要把旧 `plans/plan_items` 页面路径当作新主模型：

1. `finance_accounts` 和快照提供当前授权范围、余额/负债和来源时间。
2. `budget_periods` / `budget_items` 保存自然月周期、必要支出、当期安排、保留目标和可调项目。
3. `finance-assessments.ts` 根据账户事实、周期版本、项目和报价计算可行性及缺口。
4. `offers.ts` 提供登记目录、商品详情和报价；`purchase-intents.ts` 保存待确认意图、确认和退出。
5. 订单、支付尝试、操作和退款批次保存消费执行事实；`consumer-aftercare.ts` 负责取消/关单预览、确认和退款复核。
6. `budget-adjustments.ts` 处理新增必要支出后的方案评估与用户确认；退款预计值不会直接成为当前现金。
7. `agent.ts`、`planning-drafts.ts` 和相关领域工具只保存需求/规划草稿或解释结果，不能代替用户确认。

主入口文件：

| 业务模块 | 路由文件 | 代表性路径 |
| --- | --- | --- |
| 会话与目录 | `routes/api.ts` | `/api/sessions`、`/api/miniapp/sessions`、`/api/session`、`/api/catalog`、`/api/payment-readiness` |
| 账户与流水 | `routes/finance-accounts.ts` | `/api/finance/accounts`、账户撤回/重新授权、流水分类纠正 |
| 周期与项目 | `routes/budget-periods.ts`、`budget-items.ts` | `/api/budget-periods`、本人只读 30 天预测 `/api/budget-periods/:id/rolling-cashflow`、只读项目变更预览 `/api/budget-periods/:id/items/change-preview`、激活、目标变更、项目新增/修改/取消 |
| 报价与购买 | `routes/offers.ts`、`finance-assessments.ts`、`purchase-intents.ts` | `/api/offers`、`/api/finance/assessments`、`/api/purchase-intents`、`/api/orders` |
| 支付与善后 | `routes/api.ts`、`consumer-aftercare.ts` | 付款交接/主动查单、取消预览/确认、操作和退款复核 |
| 变化与复盘 | `budget-adjustments.ts`、`budget-period-review.ts` | `/api/emergencies/assess`、调整确认、周期事件和复盘 |
| AI | `agent.ts`、`planning-drafts.ts` | `/api/ai/agent-runs`、`/api/ai/planning-drafts` |
| 运行状态 | `runtime-status.ts`、`consumer-preferences.ts` | Worker、支付配置、数据来源和消费者偏好 |

## 4. 跨角色路径

迁移 `033_cross_role_consumer_scope.sql` 在新订单创建时从购买意图→报价→登记商品固化商户归属，并拒绝对无法关联的商品建新订单；它不根据 `provider` 猜商户，也不回填历史订单的未知归属。

| 角色 | 路由文件 | 当前职责 |
| --- | --- | --- |
| 商户 | `routes/merchant-consumer.ts` | 读取本人商品的新订单和详情；处理取消决定、固定退款批次、人工任务和原操作复核 |
| 审核者 | `routes/budget-review.ts` | 读取本人获配预算周期和详情，生成/下载限时脱敏 JSON/HTML 证据 |
| 历史计划角色 | `routes/api.ts` 等旧路径 | 保留旧计划、历史商户和审核入口；不替换新消费者的预算周期和意图模型 |

商户和审核页面分别位于 `MerchantDashboard.vue`、`ReviewerDashboard.vue` 及其组件；页面显示不能代替服务端角色校验和数据库归属。

## 5. 关键数据实体

| 事实类别 | 当前实体/位置 | 说明 |
| --- | --- | --- |
| 身份 | `users`、`sessions` | 消费者、`merchant_admin`、`reviewer`；服务端会话是权限来源 |
| 账户与账目 | `finance_accounts`、`finance_account_snapshots`、`finance_ledger_entries`、`finance_obligations` | 账户快照、流水、账单/还款安排；分类覆盖不改原始流水 |
| 规划 | `budget_periods`、`budget_items`、`budget_events` | 自然月周期、项目、版本和事件；未来 30 日由事实派生 |
| 商品与报价 | `catalog_items`、`offer_quotes`、`funding_assessments` | 登记商品、报价版本、可执行方式和购买前资金评估 |
| 购买与支付 | `purchase_intents`、`orders`、`payment_attempts`、`operations`、`jobs` | 用户意图、订单、支付尝试、异步操作和恢复；固定业务号与幂等键 |
| 变化与退款 | `budget_adjustment_proposals`、`cancellation_requests`、`refund_batches`、资金事件表 | 计划变化、取消申请、固定退款批次、渠道事实和到账事实分层保存 |
| AI | `planning_drafts`、`agent_runs` 及工具/产物关联 | 需求草稿、运行、结构化产物和恢复；新消费者工具不含交易执行 |
| 跨角色 | `consumer_order_merchants`、`budget_review_scopes`、`budget_evidence_exports` | 新订单商户归属、审核者周期范围和限时证据导出 |
| 兼容/历史 | `plans`、`plan_items`、旧 proposals/confirmations/authorizations | 保留旧计划和历史善后，不能作为新消费者主模型的依据 |

## 6. 共享契约与支付边界

- `packages/contracts/src/consumer-backend.ts`：账户、预算、报价、资金评估、购买意图、订单、调整、草稿、事件和错误结构。
- `packages/contracts/src/merchant-backend.ts`：商户订单、取消、退款批次和人工任务视图/输入。
- `packages/contracts/src/budget-review-evidence.ts`：审核预算范围、证据导出和下载相关结构。
- `packages/contracts/src/consumer-ui.ts`：消费者页面所需的 UI 状态和展示类型；`src/index.ts` 统一导出。

Simulation 由本地 Worker/受控结果完成；Sandbox 付款可能返回官方收银台地址，用户必须在渠道完成操作后回到行止主动查单，打开地址本身不算成功。微信小程序不能直接跳转支付宝网页：它复制地址到系统浏览器；H5 则尝试在新标签页打开，被浏览器阻止时再复制同一地址。这两种平台操作不能混写。

## 7. 数据库迁移与接手核对

当前本地工作区包含 `001_s1_base.sql` 至 `035_budget_ledger_links.sql`，最新编号为 035；`034`、`035` 仍是未提交的工作区迁移文件。迁移脚本按文件名顺序读取，并在目标数据库的 `schema_migrations` 中记录已经应用的文件。

这只说明仓库有这些迁移，不说明当前机器或目标数据库已经执行。接手时应单独核对目标数据库的迁移登记，再决定是否运行迁移；不能为了让文档数字一致而手工改表，也不能重写已经应用的 SQL。新变更只追加更大的编号。

## 8. 运行与代码导航

- macOS/Windows 一键启动：根目录 `start-xingzhi.zsh`、`start-xingzhi.ps1`。
- 消费者小程序导入目录：`xingzhi/apps/miniapp`；项目配置的产物根目录为 `dist/weapp`。
- Server/Worker 启动与数据库配置：`xingzhi/apps/server/src/config.ts`、`worker.ts`、`db`。
- 视觉草图 `前端设计草图/` 和未纳入交付契约的设计参考稿不改变当前业务规则或验收边界。

## 9. UI 差距补齐的改动导航

| 任务 | 优先复用的实现 | 需要补齐的最小边界 |
| --- | --- | --- |
| F1.1 上下文（已实施） | miniapp `composables/useOverview.ts`、`pages/ai/index.vue`、账户/周期读取 | 客户端选择与标签一致性优先修复，月份以 Asia/Shanghai 为准；不建立新的全局状态框架 |
| F1.2 逐日与单项影响（已实施） | server `domain/budget-cashflow.ts`、`cashflow-engine.ts`、`budget-periods.ts`，共享 consumer 契约 | 共享响应公开 daily、缓冲和事件引用；只读 `GET /api/budget-periods/:id/items/:itemId/impact` 复用同一引擎比较包含/移除未承诺项目，不在前端复制公式 |
| F1.3 账目语义（已实施） | server `domain/finance-facts.ts`、`routes/finance-accounts.ts`、`routes/consumer-preferences.ts` | DTO 复用订单名、商户名或备注摘要；退款身份来自原始事实，展示分类不改退款统计；应用内偏好只过滤首页摘要。未新增迁移 |
| F2 主页面 | miniapp `pages/home`、`plan`、`ledger`、`profile`、`impact`、`item`、`settings` | 复用 BottomSheet/FactRow/PlanItemCard 等组件；图表使用 Taro 支持的轻量呈现并配日期列表，不默认增加图表依赖 |
| F3.1/F3.2 AI（代码已实现） | server `domain/consumer-planning-tools.ts`、`consumer-agent-runtime.ts`、`planning-drafts`；miniapp AI 与 draft 页面 | 具体问题先由用户核对再发送；账目工具仅按本人绑定账户和本次选中月份返回 posted 汇总。草稿字段显示用户输入与建议来源，单项影响走只读预算预览，不增加交易执行工具或直接保存正式计划 |
| F3.3 实际关联（代码已实现） | `budget_ledger_links`、budget_periods/items、finance_ledger_entries、资金评估与周期复盘 | 迁移 `035` 保留关联及解除历史，一笔流水至多一条有效关联；写入锁定账户和周期并核对版本。服务端统一计算已覆盖与剩余计划，页面只展示结果 |

F3.1/F3.2 沿用已有 `/api/ai/agent-runs`、规划草稿和预算预览接口，新增只读月度汇总 Agent 工具及迁移 `034` 的选中月份字段；登录失败限制也由该迁移持久化。F3.3 使用 `GET/POST /api/budget-periods/:id/ledger-links` 查询/确认关联，使用 `POST /api/budget-periods/:id/ledger-links/:linkId/unlinks` 解除；写入要求本人消费者会话、幂等键、明确确认和最新周期版本，关联还要求最新财务版本。金额只能覆盖同月、同账户 posted 非订单支出与未承诺的支出项目，不能超过流水金额或项目剩余；订单流水与已结算还款事实不参与。`finance-facts` 只返回本人有效关联摘要，预算预测只计算剩余计划，复盘同时列出已覆盖、未发生与未覆盖支出。解除不删原行，也不改变原流水或退款事实。旧计划兼容及已有订单/退款证据保留。
