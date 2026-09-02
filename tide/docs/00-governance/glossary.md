# 术语表

| 元信息 | 内容 |
| --- | --- |
| 文档版本 | 0.2.0 |
| 文档状态 | 现行唯一口径 |
| 负责人 | 产品负责人、领域负责人 |
| 更新时间 | 2026-09-02 |
| 关联文档 | [文档规范](document-conventions.md)、[领域模型](../03-domain/domain-model.md)、[接口契约](../04-architecture/api-contract.md) |

## 1. 核心术语

| 中文术语 | 稳定英文名 | 定义 |
| --- | --- | --- |
| 业务警戒线 | `guardDate` | 企业必须具备可用回款或经人工确认安排的关键日期，不是法定逾期日。 |
| 回款节点 | `CashflowNode` | 描述关键回款预计可用区间、覆盖比例、核验状态和主次关系。 |
| 周转保障节点 | `SafeguardNode` | 描述材料准备、替代经营安排或第三方支持信息何时具备人工确认条件；不表示融资已批准。 |
| 回款时钟 | `cashflowClock` | 主回款预计可用区间相对业务警戒线的天数范围。 |
| 周转保障时钟 | `safeguardClock` | 主周转保障预计就绪区间相对业务警戒线的天数范围。 |
| 双时钟差值 | `deltaCashRange`、`deltaSafeguardRange` | 两个区间与警戒线的差值；正数表示晚于警戒线，负数或零表示不晚于。 |
| 证据护照 | `EvidencePassport` | 证据的来源、阶段、用途、有效期、脱敏摘录、可见角色和核验状态集合。 |
| 证据准备度 | `EvidenceReadiness` | 某条证据链为缺失、部分准备或完整准备。 |
| 置信等级 | `confidenceLevel` | 规则解释所依赖证据的完整度和来源质量，不是风险概率。 |
| 双时钟沙盘 | `simulateRiskCase` | 在不持久化的假设情景中调整日期或证据状态并比较解释差异。 |
| 人工覆盖 | `ManualOverride` | 保留规则状态与原解释，由授权人员带理由设置有效展示状态的操作。 |
| 协同摘要 | `CollaborationSummary` | 企业授权后可导出的最小化案例、时间、缺口和任务摘要。 |

## 2. 风险状态

| 枚举 | 中文名 | 含义 |
| --- | --- | --- |
| `STEADY` | 稳态 | 两个有效日期区间均不晚于警戒线；仍需关注证据时效。 |
| `CASH_PRESSURE` | 回款承压 | 主回款区间晚于警戒线，主周转保障区间不晚于警戒线。 |
| `SAFEGUARD_PRESSURE` | 周转保障承压 | 主回款区间不晚于警戒线，主周转保障区间晚于警戒线。 |
| `DUAL_PRESSURE` | 双重承压 | 两个日期区间均晚于警戒线。 |
| `PENDING_VERIFICATION` | 待核验 | 主节点、日期区间或当前证据不足，或区间跨越警戒线，无法稳定分类。 |

## 3. 证据词汇

| 维度 | 取值 | 解释 |
| --- | --- | --- |
| 阶段 | `TRANSACTION_COMMITMENT` | 订单、合同或交易承诺。 |
| 阶段 | `FULFILLMENT_ACCEPTANCE` | 交付、验收或履约确认。 |
| 阶段 | `SETTLEMENT_AVAILABILITY` | 结算条件及回款实际可用性。 |
| 阶段 | `SAFEGUARD_PREPARATION` | 周转保障材料或安排的准备情况。 |
| 阶段 | `REVIEW_CONFIRMATION` | 人工复核形成的确认记录。 |
| 状态 | `PENDING` / `VERIFIED` | 等待人工核验 / 已完成有效人工核验。 |
| 状态 | `REJECTED` / `EXPIRED` | 已拒绝 / 已超过有效期，不参与当前计算。 |
| 准备度 | `MISSING` / `PARTIAL` / `COMPLETE` | 没有所需阶段 / 已有部分阶段 / 所需阶段均已核验。 |

运行时来源仅允许 `SIMULATED_DOCUMENT`、`SIMULATED_SYSTEM_EVENT`、`CONSENTED_ANONYMIZED_FACT`、`MANUAL_REVIEW_NOTE`。公开政策、行业材料和访谈等级只记录在[证据台账](../01-contest/evidence-register.md)。

## 4. 角色与任务

角色为 `ENTERPRISE_OPERATOR`、`RELATIONSHIP_MANAGER`、`RISK_REVIEWER`、`DEMO_ADMIN`。任务类型为 `VERIFY_CASHFLOW`、`VERIFY_SAFEGUARD`、`REQUEST_REVIEW`、`OTHER`。任务完成只表示动作完成，不自动改变规则状态。
