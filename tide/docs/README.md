# 潮汐文档中心

| 元信息 | 内容 |
| --- | --- |
| 项目 | 潮汐：面向供应链小微企业经营周转的回款—周转保障双时钟证据协同服务 |
| 文档版本 | 0.2.0 |
| 文档状态 | 现行总入口 |
| 负责人 | 项目负责人、产品负责人 |
| 更新时间 | 2026-09-02 |
| 关联文档 | [竞赛方案](01-contest/competition-solution.md)、[PRD](02-product/prd.md)、[领域规则](03-domain/dual-clock-rules.md)、[系统架构](04-architecture/system-architecture.md)、[Demo 规格](05-delivery/demo-spec.md)、[测试策略](05-delivery/test-strategy.md) |

## 1. 项目定义

潮汐在业务警戒线前回答两个问题：关键回款何时具备可核验依据，备用周转保障何时具备人工确认条件。系统把交易承诺、履约验收、结算可用、保障准备和人工复核组织为证据护照，再用确定性日期规则计算双时钟状态，把缺口转化为可执行、可复核、可审计、可撤回授权的协同任务。

潮汐不判断“该不该贷”，不输出信用分、违约概率或审批结论。当前 0.2.0 是离线领域基线：共享契约、规则引擎、沙盘、种子案例和离线材料提取器已实现；前端、服务层、数据库和真实外部接口尚未建设。

## 2. 十分钟阅读路径

1. 用 2 分钟阅读[竞赛方案](01-contest/competition-solution.md)，理解问题、差异化和合规边界。
2. 用 2 分钟阅读[PRD](02-product/prd.md)，确认用户、范围和成功标准。
3. 用 3 分钟阅读[双时钟规则](03-domain/dual-clock-rules.md)与[证据护照](03-domain/evidence-passport.md)，理解状态、置信度和证据门槛。
4. 用 2 分钟阅读[接口契约](04-architecture/api-contract.md)与[系统架构](04-architecture/system-architecture.md)，找到对象和模块边界。
5. 用 1 分钟阅读[Demo 规格](05-delivery/demo-spec.md)与[测试策略](05-delivery/test-strategy.md)，确认主链路和验收方式。

## 3. 文档地图

| 目录 | 解决的问题 | 入口 |
| --- | --- | --- |
| `00-governance` | 术语如何统一、决策如何追溯？ | [文档规范](00-governance/document-conventions.md)、[术语表](00-governance/glossary.md)、[决策日志](00-governance/decision-log.md) |
| `01-contest` | 为什么值得参赛、如何路演、证据可靠吗？ | [竞赛方案](01-contest/competition-solution.md)、[路演叙事](01-contest/pitch-narrative.md)、[证据台账](01-contest/evidence-register.md) |
| `02-product` | 谁使用、做什么、不做什么？ | [PRD](02-product/prd.md)、[角色与场景](02-product/personas-and-scenarios.md)、[用户流程](02-product/user-flows.md) |
| `03-domain` | 双时钟、证据和状态如何计算？ | [领域模型](03-domain/domain-model.md)、[规则](03-domain/dual-clock-rules.md)、[证据护照](03-domain/evidence-passport.md)、[沙盘](03-domain/scenario-simulation.md)、[状态机](03-domain/state-machine.md) |
| `04-architecture` | 如何实现、存什么、怎么保护？ | [系统架构](04-architecture/system-architecture.md)、[数据模型](04-architecture/data-model.md)、[接口契约](04-architecture/api-contract.md)、[隐私安全](04-architecture/privacy-security.md)、[ADR](04-architecture/adr/0001-typescript-web-local-demo.md) |
| `05-delivery` | 怎么演示、验证和推进？ | [Demo 规格](05-delivery/demo-spec.md)、[测试策略](05-delivery/test-strategy.md)、[开发路线](05-delivery/development-roadmap.md) |
| `appendix` | 如何安全收集案例和反馈？ | [案例模板](appendix/anonymized-case-template.md)、[访谈提纲](appendix/interview-guide.md)、[评估问卷](appendix/evaluation-questionnaire.md) |

## 4. 当前实现与证据状态

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 共享契约与领域规则 | 已实现 | `packages/contracts`、`packages/domain`，版本 0.2.0。 |
| 双时钟沙盘 | 已实现 | 纯函数运行，不修改正式快照和审计记录。 |
| 离线材料提取 | 已实现 | `packages/extraction`，仅从固定脱敏模拟文本生成待复核候选。 |
| 种子案例 | 已实现 | `CASE-DEMO-001`，行业中性的供应链模拟案例。 |
| 页面、服务与数据库 | 待开发 | 进入下一阶段前以本文档基线为验收依据。 |
| 访谈与真实案例 | 待收集 | 未达到最低门槛前，所有效果陈述均为原型假设。 |

## 5. 唯一口径与边界

- 现行产品名为“回款—周转保障双时钟证据协同服务”。
- 置信等级只表示证据完整度和来源质量，不表示违约概率。
- 沙盘结果是“假设情景”，不得直接写入正式案例。
- 候选材料被接受后只形成 `PENDING` 证据，必须人工核验才能成为 `VERIFIED`。
- 不接入真实银行核心系统、征信数据或第三方生产系统，不自动授信、续贷、处置或保证融资与回款结果。

历史材料只保存在 `archive/`，不参与现行术语、链接和版本门禁，也不得作为实现依据。
