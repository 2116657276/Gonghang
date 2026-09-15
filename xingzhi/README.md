# 行止本地运行说明

更新日期：2026-09-15。本文描述现有程序，不表示新资金规划功能已经实现。新产品文档见[文档中心](docs/README.md)，SQL 与种子改造见[开发计划](docs/03-engineering/development-plan.md)。当前开发契约已经收口但仍暂停开发；代码保持原实现，新财务接口、SQL、种子、主演示数据和候选尚未实施。现有 seed 仍是旧 A/B/C/D 数据，不能用来加载新场景。

| 项目 | 当前事实 |
| --- | --- |
| 运行组成 | Vue／Vite、Fastify API、worker、PostgreSQL |
| 本地地址 | 网页 `http://localhost:5173`，API `http://127.0.0.1:8787` |
| 支付 | 当前日常 simulation，历史沙箱订单保留原环境；正式演示才按授权使用 sandbox |
| 数据 | 当前 `xingzhi_dev` 保留原交易资料；现有种子仍为 A/B/C/D，新账户与消费样本未写入 |
| 凭据 | 仅本机被 Git 忽略的环境与秘密文件，不复制到文档或模型 |

以下命令是已有程序的操作说明，不是要求立即执行。新迁移完成前，运行当前种子不会得到新方案的账户或还款数据。

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

本阶段还提供 `pnpm typecheck` 和 `pnpm test:targeted`。`pnpm build` 留给首次交付构建或构建路径变更时执行，不作为日常文档／业务检查。

## 测试账号

种子数据使用两个消费者、一个测试商户管理员和一个只读审核者。邮箱分别是 `consumer-a@xingzhi.local`、`consumer-b@xingzhi.local`、`merchant@xingzhi.local`、`reviewer@xingzhi.local`；密码只取自本机 `.env` 的 `SEED_DEMO_PASSWORD`，不写入 Git。

消费者工作台可建立 A/B/C/D 计划，生成和确认购买预览、建单、观察模拟结果、暂停购买、生成变更预览、提交模拟善后，并查看授权、退款批次和当前人工责任。商户工作台可管理命名规则预设、查看取消队列、处理延迟申请、安排固定退款批次及记录人工复核；审核者只显示服务端分配的计划范围。所有写操作由服务端会话、请求来源、幂等键和计划版本共同约束。

## 现有证据与新缺口

原交易基础的 55 项检查及首批沙箱核心链见[历史验收](docs/archive/transaction-verification.md)。新账户、轻量账目、日期规划、空状态 Agent、多候选与统一页面仍待开发；历史类型或行为通过不能覆盖新增实现。

本地运行约束、环境切换及数据清理见[运行边界](docs/04-quality/operations.md)。不得用清库或重写已应用迁移代替新 SQL 迁移，也不得为了新样本删除沙箱交易和模型费用。
