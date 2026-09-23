# 行止

> 行止是一个依托银行场景的青年近期资金规划应用：帮助用户看懂已发生的收支、整理账目、安排近期资金，并在收入、支出或计划变化后调整安排。当前仓库用于本地联调和竞赛演示，不代表已接入真实银行或正式上线。

详细产品口径、业务规则、架构导航、开发状态和验收步骤统一见 [`xingzhi/doc/`](xingzhi/doc/)。本 README 只作为开发者启动入口，不另建 `xingzhi/README.md` 或平行进度文档。

## 1. 代码结构

| 模块 | 位置 | 技术/职责 |
| --- | --- | --- |
| 消费者端 | `xingzhi/apps/miniapp` | Taro + Vue 3 + TypeScript；同时构建 H5 和微信小程序 |
| 商户/审核网页 | `xingzhi/apps/web` | Vue 3 + Vite；商户处理、审核证据和历史计划入口 |
| 后端与 Worker | `xingzhi/apps/server` | Fastify + PostgreSQL；接口、领域规则、支付/退款异步处理 |
| 共享契约 | `xingzhi/packages/contracts` | 前后端共用的输入 schema、响应视图和状态类型 |
| 启动脚本 | `start-xingzhi.zsh`、`start-xingzhi.ps1` | macOS zsh 和 Windows PowerShell 本地启动 |

消费者主模型使用自然月 `budget_periods/budget_items`、购买意图和新消费者订单；旧 `plans/plan_items` 路径保留历史和兼容用途。产品主线是“看懂收支—安排资金—应对变化”，商品、支付和退款是现有消费场景能力。

## 2. 环境与本地配置

需要：

- macOS（zsh）或 Windows PowerShell；
- Node.js 22；
- pnpm 11（仓库锁定 `pnpm@11.19.0`）；
- PostgreSQL，默认端口 5432；
- 微信开发者工具（仅调试小程序时需要）。

macOS：

```zsh
cp xingzhi/.env.example xingzhi/.env
```

Windows PowerShell：

```powershell
Copy-Item .\xingzhi\.env.example xingzhi\.env
```

编辑 `xingzhi/.env` 时至少确认本地数据库连接、`PORT=8877`、网页来源和 `PAYMENT_MODE=simulation`；设置只供本机使用的 `SEED_DEMO_PASSWORD`。不要提交 `.env`，不要把数据库密码、测试密码、模型密钥或支付密钥写入文档、代码、截图或聊天记录。

## 3. 启动项目

先安装依赖并确保 PostgreSQL 已启动：

```sh
pnpm install
```

macOS：

```zsh
./start-xingzhi.zsh --restart --no-browser
```

Windows PowerShell：

```powershell
.\start-xingzhi.ps1 -Restart -NoBrowser
```

第一次准备全新的隔离演示数据库时，才使用脚本的 `--seed`/`-Seed` 选项。日常启动不要重复 Seed 正在使用的数据库；已有账户、预算和订单受保护时，不要通过删除业务数据绕过保护。

## 4. 地址与微信开发者工具

| 服务/资源 | 地址或目录 |
| --- | --- |
| 消费者 H5 | `http://localhost:5173` |
| 商户/审核工作台 | `http://localhost:5174` |
| 后端 API | `http://localhost:8877` |
| API 健康检查 | `http://localhost:8877/api/health` |
| 微信项目导入目录 | `xingzhi/apps/miniapp` |
| 微信小程序产物根目录 | `xingzhi/apps/miniapp/dist/weapp` |

在微信开发者工具中导入 `xingzhi/apps/miniapp`，不要直接导入 `dist/weapp`。本机开发者工具可以使用 `http://127.0.0.1:8877`；真机不能使用电脑的 `127.0.0.1`，必须使用手机可访问的 HTTPS API 和已配置的微信合法域名。

真机编译前可在启动时保留外部 API 地址：

```zsh
TARO_APP_API_BASE=https://实际域名 ./start-xingzhi.zsh --restart --no-browser
```

更换地址后等待微信监听构建完成，并在开发者工具重新编译。登录小程序后可在“我的 → 应用设置 → 演示环境”核对编入产物的 API 地址。

## 5. 常用命令

均在仓库根目录执行：

```sh
# 全仓类型检查
pnpm typecheck

# 服务端定向回归
pnpm test:targeted

# 消费者 H5 / 微信小程序 / 全仓构建
pnpm build:miniapp:h5
pnpm build:miniapp:weapp
pnpm build

# 按文件名顺序应用尚未登记的数据库迁移
pnpm db:migrate
```

创建新的消费者隔离场景时使用唯一场景键和实际上海日期：

```sh
pnpm --filter @xingzhi/server db:seed:consumer-scenario <unique-key> <YYYY-MM-DD> complete automatic
```

人工商户处理分支将最后一个参数改为 `merchant-review`。场景输出中的账号、周期、商户、审核者、商品和报价标识只用于本地记录，不要记录密码。

## 6. 数据库与运行边界

仓库包含 `001` 至 `035` 的迁移文件；`034` 增加登录失败限制和 AI 账目提问月份，`035` 增加普通流水与预算计划的关联/解除记录。文件存在不等于目标数据库已经执行；接手或换机器时要核对目标库 `schema_migrations`，不要手工改表、回写已执行 SQL 或把 Git 合并当作迁移完成。

Simulation 是本地业务链证据，支付宝 Sandbox 是独立渠道环境，两者不能互相替代。付款、取消和退款都必须保留用户确认、权限、幂等、原业务号和恢复边界；渠道成功不等于银行账户已到账。

## 7. 当前阶段

D1/D2 已交付，F1/F2 与 F3.1—F3.3 已有代码；F3 集中验收、真实模型回答、微信开发者工具、真机和正式录制仍待完成，Sandbox 与商户/审核证据另行验收。唯一详细状态见 [`04-development.md`](xingzhi/doc/04-development.md)，逐图功能对照见 [`01-product.md`](xingzhi/doc/01-product.md#7-ui-设计图功能清单与实现对照)。

## 8. 文档导航

| 文档 | 用途 |
| --- | --- |
| [`01-product.md`](xingzhi/doc/01-product.md) | 产品目标、核心体验、当前功能和明确边界 |
| [`02-business-rules.md`](xingzhi/doc/02-business-rules.md) | 资金、流水、预算、确认、交易、退款、权限和 AI 规则 |
| [`03-architecture.md`](xingzhi/doc/03-architecture.md) | 模块职责、数据实体、代码入口、接口导航和迁移边界 |
| [`04-development.md`](xingzhi/doc/04-development.md) | 唯一的当前进度、验证来源、后续顺序和待确认项 |
| [`05-acceptance-and-demo.md`](xingzhi/doc/05-acceptance-and-demo.md) | Simulation、微信、真机、Sandbox、跨角色核对和 Demo 记录 |
| [开发接力指南](开发接力指南.md) | 同事接手的环境准备、协作边界及每轮开发后的交接摘要 |

文档中的“已实现”“已有记录”“外部待验收”和“后续方向”含义不同；没有实际证据的能力必须继续保留为待验证。
