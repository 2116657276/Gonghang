# 行止本地运行说明

更新日期：2026-09-15。本文描述当前代码和本地运行边界，不表示新资金规划功能已经完整实现。新产品文档见[文档中心](docs/README.md)，SQL 与种子改造见[开发计划](docs/03-engineering/development-plan.md)；现有程序与新方向的总体进度以文档中心和验证策略为准。001—023、B00 目录报价、B01 消费者项目接口及 B02 规划草稿接口已经进入当前代码基线，B02 的无账户需求草稿可以保存；A 侧账户事实、真实预算写入／逐日评估、消费者 Agent 运行接入及主演示资金数据仍待接入。现有通用 seed 仍是旧 A/B/C/D 数据，不能用来加载新场景。

| 项目 | 当前事实 |
| --- | --- |
| 运行组成 | Vue／Vite、Fastify API、worker、PostgreSQL |
| 本地地址 | 网页 `http://localhost:5173`，API `http://127.0.0.1:8787` |
| 支付 | 当前日常 simulation，历史沙箱订单保留原环境；正式演示才按授权使用 sandbox |
| 数据 | 当前 `xingzhi_dev` 保留原交易资料并已应用 001—023；B00 有 2 条 Demo 报价，账户、预算周期和规划草稿样本仍未写入；现有通用种子仍为 A/B/C/D |
| 凭据 | 仅本机被 Git 忽略的环境与秘密文件，不复制到文档或模型 |

以下命令是已有程序的操作说明，不是要求立即执行。空库执行 `pnpm db:migrate` 会按顺序应用 001—023；当前 `xingzhi_dev` 已完成这些迁移。运行通用 `pnpm db:seed` 仍只会得到旧 A/B/C/D 目录和测试账号，不会得到新方案的账户、预算或还款样本。

## 首次运行

在行止项目根目录 `xingzhi/` 使用 `.env.example` 创建本地 `.env`，设置独立的 `SEED_DEMO_PASSWORD`，并确认 `DATABASE_URL` 指向 `xingzhi_dev`，不要连接其他项目的数据库。若该库尚未创建，先执行 `createdb xingzhi_dev`；可从仓库根目录执行：

```sh
cp xingzhi/.env.example xingzhi/.env
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`pnpm dev` 同时启动网页、API 与 worker。`pnpm db:migrate` 只应用未执行的顺序 SQL 迁移；`pnpm db:seed` 可重复执行，用于补齐本地测试账号和 A/B/C/D 目录，不写入真实数据。

历史真实模型只读烟测和 T04／T08 方案联调已通过，API-24 提供查询与方案助手入口；Pi 依赖已安装。服务端只从本机 `.env` 读取 `DEEPSEEK_API_KEY`，固定 `DEEPSEEK_BASE_URL=https://api.deepseek.com`，当前配置为 `DEEPSEEK_MODEL=deepseek-flash`（DeepSeek V4.1 Flash，用户简称“ds4.1flash”）；累计模型费用上限为人民币 100 元，采用每分钟 10 次、突发 2、同计划并发 1 的常规服务端限流。[历史验收归档](docs/archive/transaction-verification.md)第十八至二十二节记录原模型、进程恢复、授权连续性及交易核验；现行[新版验证策略](docs/04-quality/verification.md)不沿用这些章节编号。未配置密钥或人民币预算账本时不会发起外部模型调用。

本阶段还提供 `pnpm typecheck` 和 `pnpm test:targeted`。当前 B00—B02 已有独立定向测试；这些测试只证明接口边界和桩交接，不证明真实资金服务、模型调用或完整 N 案例。`pnpm build` 留给首次交付构建或构建路径变更时执行，不作为日常文档／业务检查。

## 测试账号

种子数据使用两个消费者、一个测试商户管理员和一个只读审核者。邮箱分别是 `consumer-a@xingzhi.local`、`consumer-b@xingzhi.local`、`merchant@xingzhi.local`、`reviewer@xingzhi.local`；密码只取自本机 `.env` 的 `SEED_DEMO_PASSWORD`，不写入 Git。

消费者工作台可建立 A/B/C/D 计划，生成和确认购买预览、建单、观察模拟结果、暂停购买、生成变更预览、提交模拟善后，并查看授权、退款批次和当前人工责任。商户工作台可管理命名规则预设、查看取消队列、处理延迟申请、安排固定退款批次及记录人工复核；审核者只显示服务端分配的计划范围。所有写操作由服务端会话、请求来源、幂等键和计划版本共同约束。

## 现有证据与新缺口

原交易基础的 55 项检查及首批沙箱核心链见[历史验收](docs/archive/transaction-verification.md)。B00 已提供登记目录和报价读取，B02 已提供需求／预算草稿 API 及独立工具白名单；新账户、轻量账目、日期规划、真实逐日评估、消费者 Agent 运行接入和统一页面仍待开发。历史类型或行为通过不能覆盖新增实现。

本地运行约束、环境切换及数据清理见[运行边界](docs/04-quality/operations.md)。不得用清库或重写已应用迁移代替新 SQL 迁移，也不得为了新样本删除沙箱交易和模型费用。

### B00 消费者目录与报价

使用现有消费者会话调用 `GET /api/offers?plannedOn=2026-09-20&categoryCode=food`，再以返回的商品 id 调用 `GET /api/offers/:id/quote?plannedOn=2026-09-20`。成功响应为 `{ data, meta }`，无有效报价返回 409／QUOTE_STALE，展示价格不等同于可执行报价。

在仓库根目录执行 `pnpm --filter @xingzhi/server db:seed:consumer-catalog 2026-09-20` 可初始化该日 Demo 目录报价；日期必须尚未结束。本入口复用已有测试商户账号，不调用旧 A/B/C/D 覆盖种子；不要为初始化新目录重新运行旧 db:seed。重复执行保留既有报价状态与期限，更换日期创建新报价。此入口不写资金账户或预算，不表示购买接口已完成。

### B01 消费者预算项目入口

新增项目使用 `POST /api/budget-periods/:id/items`，编辑使用 `PATCH /api/budget-periods/:id/items/:itemId`，取消尚未执行项目使用 `POST /api/budget-periods/:id/items/:itemId/cancellations`。三者均要求消费者会话、同源请求、`Idempotency-Key`，并校验路径中的周期／项目与正文一致。成功响应包含 A 返回的项目、月度资金依据及当日同分类有效候选报价；候选只供后续选择，不自动关联项目或取得购买资格。

B01 的 HTTP、事务、幂等和响应组装已经完成，但 A02 的真实项目写函数尚未接入。当前日常服务调用这些写入口会返回 409／`FINANCE_BASIS_UNKNOWN`，不会伪造预算保存成功；定向测试使用固定 A 桩验证接口边界。A02 接入后由 `buildApp` 注入 `BudgetItemPort`，再做真实落库和版本联合验收。

### B02 需求草稿与预算草稿

`POST /api/ai/planning-drafts` 保存严格结构化的待确认草稿，`GET /api/ai/planning-drafts/:id` 仅允许本人读取。未选账户／周期时，`periodId`、`expectedFinancialVersion`、`expectedPeriodVersion` 必须同时为 null；这类需求草稿保留用户明确给出的标题、日期、估价、必要／可调属性和约束，缺失字段由服务端列出，模型建议存放在独立 `suggestion` 对象中。关联预算周期时三个字段必须同时提供，并先调用 A03 的只读评估端口。

草稿引用的目录商品必须仍为 active 且适用于对应日期。响应只包含草稿、缺失字段和可空评估摘要，不提供确认、执行或状态修改入口。新消费者 Agent 的独立工具目录只有读取预算依据、查询登记商品和保存草稿三项，不包含建单、付款、暂停购买或提交变更。当前无账户需求草稿可以使用；关联周期的预算草稿在 A03 未接入时返回 409／`FINANCE_BASIS_UNKNOWN`。

B02 当前完成的是结构化 API、共享 schema、023 迁移、工具白名单和定向边界测试；`consumerPlanningAgentTools` 尚未接入现有 `agent-runtime` 的实际模型运行。因而 `model_source=validated_structured_v1` 只表示服务端保存前完成结构校验，不表示本次请求一定经过真实模型，也不表示新消费者 Agent 已能从自然语言直接调用这些工具。
