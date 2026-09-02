# 回款—周转保障双时钟规则

| 元信息 | 内容 |
| --- | --- |
| 文档版本 | 0.2.0 |
| 文档状态 | 已实现规则基线 |
| 负责人 | 领域负责人、风险规则负责人 |
| 更新时间 | 2026-09-02 |
| 关联文档 | [领域模型](domain-model.md)、[证据护照](evidence-passport.md)、[状态机](state-machine.md)、[测试策略](../05-delivery/test-strategy.md) |

## 1. 规则原则

风险状态由主日期区间相对业务警戒线确定；证据决定能否计算和结论置信度，不能替代日期规则。规则完全离线、确定性、无随机参数。置信等级描述证据质量，不表示企业违约概率。

## 2. 输入有效性

1. `referenceDate` 必须是合法 ISO 日期。
2. `guardDate` 必须合法且不早于参考日。
3. 所有回款覆盖比例必须在 0–100，且 `minPercent <= maxPercent`。
4. 回款和周转保障各有且仅有一个 `isPrimary=true` 节点。
5. 两个主日期区间必须合法且起日不晚于止日。
6. 每条证据链至少有一条当前证据：状态不是拒绝或过期、已经生效且尚未超过有效期。

前三项失败返回契约错误；主节点、日期区间或当前证据不满足时输出 `PENDING_VERIFICATION` 和具体原因。

## 3. 日期差与区间分类

```text
deltaCashRange.minDays = cash.start - guardDate
deltaCashRange.maxDays = cash.end   - guardDate
deltaSafeguardRange.minDays = safeguard.start - guardDate
deltaSafeguardRange.maxDays = safeguard.end   - guardDate
```

日期差按 UTC 自然日计算。若 `maxDays <= 0`，区间不晚于警戒线；若 `minDays > 0`，区间晚于警戒线；若 `minDays <= 0 < maxDays`，区间跨线，进入待核验。显示用的 `deltaCashDays` 与 `deltaSafeguardDays` 取对应区间的最晚边界，同时必须返回完整区间。

## 4. 四象限

| 回款区间 | 周转保障区间 | 状态 | 处理重点 |
| --- | --- | --- | --- |
| 不晚于警戒线 | 不晚于警戒线 | `STEADY` | 巡检证据时效，仍不作审批结论。 |
| 晚于警戒线 | 不晚于警戒线 | `CASH_PRESSURE` | 核验履约、结算与到账可用性。 |
| 不晚于警戒线 | 晚于警戒线 | `SAFEGUARD_PRESSURE` | 补齐保障准备与人工确认。 |
| 晚于警戒线 | 晚于警戒线 | `DUAL_PRESSURE` | 同时处理两链并提交高优先级人工复核。 |

任何一个区间跨线、主节点不唯一或每条链没有当前证据，都覆盖为 `PENDING_VERIFICATION`。

## 5. 证据链与准备度

回款所需阶段为交易承诺、履约验收、结算可用；周转保障所需阶段为保障准备、人工复核确认。

| 准备度 | 规则 |
| --- | --- |
| `MISSING` | 所需阶段没有任何当前证据。 |
| `PARTIAL` | 至少一个所需阶段有当前证据，但不是所有所需阶段均已核验。 |
| `COMPLETE` | 所有所需阶段至少有一条当前且已核验证据。 |

缺失阶段、仅有待核验证据、悬空关联、证据全部失效都会形成具体 `evidenceGaps`。

## 6. 置信等级

| 等级 | 条件 |
| --- | --- |
| `LOW` | 存在计算资格缺口；或交易承诺与履约验收尚未都核验；或保障准备没有已核验证据；或证据仍待核验。 |
| `MEDIUM` | 回款承诺与履约已核验，结算仍待确认，且保障至少一项有效证据已核验；或两条链完整但至少一个所需阶段只来自模拟来源。 |
| `HIGH` | 两条链所有所需阶段均已核验、未过期，且每个阶段均有经同意脱敏事实或人工复核记录支撑。 |

当中等级规则同时满足高等级条件时取高。演示种子含模拟来源，默认不产生高置信度。

## 7. 任务生成

任务先由实际证据缺口生成：回款链不完整时生成 `VERIFY_CASHFLOW`，周转保障链不完整时生成 `VERIFY_SAFEGUARD`。再按状态增加对应核验或 `REQUEST_REVIEW`。同一任务类型和标题只保留一项，每项含 `basis`。

`PENDING_VERIFICATION` 不再固定生成所有任务；若只有回款链缺失，只生成回款补证和人工复核。任务标记完成不触发状态切换，必须有新的结构化证据或日期并显式重算。

## 8. 伪代码

```text
validate(referenceDate, guardDate, coveragePercentRange)
cash = selectExactlyOnePrimary(cashflowNodes)
safeguard = selectExactlyOnePrimary(safeguardNodes)
cashEvidence = inspectRequiredStages(cash, threeCashStages)
safeguardEvidence = inspectRequiredStages(safeguard, twoSafeguardStages)

if node/date/currentEvidence missing or either range crosses guardDate:
  status = PENDING_VERIFICATION
else:
  status = classifyByDateRanges(cash.range, safeguard.range, guardDate)

confidence = classifyEvidenceCompletenessAndSource()
tasks = deduplicate(tasksFromEvidenceGaps + tasksFromStatus)
return explanation(status, ranges, readiness, confidence, gaps, tasks)
```

## 9. 固定验收案例

初始案例：警戒线 2026-10-01；回款区间 2026-10-13 至 2026-10-19；周转保障区间 2026-10-26 至 2026-11-30；结果 `DUAL_PRESSURE + LOW`，差值分别为 `+12..+18` 与 `+25..+60` 天。

假设情景：核验履约与结算证据，回款区间改为 2026-09-26 至 2026-09-29；结果 `SAFEGUARD_PRESSURE + MEDIUM`，回款差值为 `-5..-2` 天，不能显示“已解决”。
