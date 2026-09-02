# 接口契约

| 元信息 | 内容 |
| --- | --- |
| 文档版本 | 0.2.0 |
| 文档状态 | 共享类型已实现，HTTP 接口待开发 |
| 负责人 | 架构负责人、接口负责人 |
| 更新时间 | 2026-09-02 |
| 关联文档 | [系统架构](system-architecture.md)、[数据模型](data-model.md)、[领域模型](../03-domain/domain-model.md)、[沙盘](../03-domain/scenario-simulation.md) |

## 1. 通用约定

未来本地 API 前缀为 `/api/v1`，JSON 字段使用 `camelCase`，日期使用 `YYYY-MM-DD`，时间戳使用 UTC ISO 8601。所有响应带 `requestId`；错误响应为 `{ error: { code, message, field?, details? }, requestId }`。接口只处理模拟或完全脱敏数据。

共享类型以 `@tide/contracts` 为机器可读源；本文说明未来传输语义，不另建兼容别名。

## 2. 核心对象

### 2.1 `CashflowNode`

`nodeId`、`label`、`expectedAvailableDateRange`、`coveragePercentRange { minPercent, maxPercent }`、`verificationStatus`、`isPrimary`。比例必须为有限数、范围 0–100 且下界不大于上界。

### 2.2 `SafeguardNode`

`nodeId`、`safeguardType`、`label`、`expectedReadyDateRange`、`verificationStatus`、`isPrimary`。类型固定为四种 `SafeguardType`。

### 2.3 `EvidenceItem`

`evidenceId`、`sourceType`、`stage`、`status`、`purpose`、`summary`、可选 `sourceExcerpt`、可选 `validFrom`、可选 `expiresAt`、`visibilityRoles`。源类型、阶段、状态、用途和角色均来自共享枚举。

### 2.4 `RiskCase`

`caseId`、`scenarioProfile`、`industry`、`purposeCategory`、`referenceDate`、`guardDate`、`ruleStatus`、`effectiveStatus`、`confidenceLevel`，读取详情时同时包含节点、证据和关联。

### 2.5 `RiskExplanation`

`calculatedStatus`、`deltaCashDays`、`deltaSafeguardDays`、两个差值区间、两个日期区间、两个证据准备度、`confidenceLevel`、`reasons`、`evidenceGaps`、`prohibitedActions`、`suggestedTasks`。置信等级不是概率。

### 2.6 `VerificationTask`

`taskId`、`caseId`、`taskType`、`title`、`assigneeRole`、`priority`、`basis`、`status`、时间字段。任务完成不隐式调用重算。

### 2.7 `AuditEvent`

`eventId`、`caseId`、`eventType`、`actorRole`、`targetType`、`targetId`、最小化前后摘要、原因码和时间。接口不返回材料全文或隐藏角色字段。

## 3. 五类必备接口

### 3.1 案例读取

`GET /api/v1/cases/{caseId}` 返回案例快照、最新规则解释、有效状态、任务、授权摘要和调用者可见证据。找不到返回 `CASE_NOT_FOUND`；角色无权查看返回 `FORBIDDEN`。

### 3.2 证据提交

`POST /api/v1/cases/{caseId}/evidence` 接收证据护照与节点关联，新证据默认 `PENDING`。即使来源于已接受提取候选，也不得传入 `VERIFIED`。成功返回 201 和证据对象，不自动修改正式状态。

### 3.3 双时钟重新计算

`POST /api/v1/cases/{caseId}/recalculate` 读取一致快照，调用确定性规则，追加解释版本和审计事件。请求可带 `expectedCaseVersion` 防止并发覆盖。返回完整 `RiskExplanation`。

### 3.4 人工确认/覆盖

`POST /api/v1/cases/{caseId}/reviews` 用于证据核验或规则状态覆盖。覆盖请求必须含 `explanationId`、`effectiveStatus`、`reason` 和预期版本；响应同时返回原规则状态、有效状态和覆盖记录。理由为空返回 `OVERRIDE_REASON_REQUIRED`。

### 3.5 协同摘要导出

`POST /api/v1/cases/{caseId}/collaboration-summaries` 接收授权标识和用途，服务端实时校验状态、期限、范围和角色，返回最小化摘要。授权撤回或过期返回 `AUTHORIZATION_INACTIVE`，不得生成内容，失败尝试仍记录审计。

## 4. 支撑接口

| 方法与路径 | 用途 | 持久化 |
| --- | --- | --- |
| `POST /cases/{id}/simulations` | 运行双时钟沙盘。 | 否 |
| `POST /extraction/candidates` | 从固定脱敏模拟材料产生候选。 | 可选保存候选，不创建证据。 |
| `POST /extraction/candidates/{id}/accept` | 接受候选并创建 `PENDING` 证据草稿。 | 是 |
| `POST /cases/{id}/authorizations` | 创建企业授权。 | 是 |
| `POST /cases/{id}/authorizations/{id}/revoke` | 撤回授权。 | 是 |
| `GET /cases/{id}/audit-events` | 查询调用者可见审计事件。 | 只读 |

## 5. 错误码

| HTTP | 代码 | 场景 |
| --- | --- | --- |
| 400 | `INVALID_DATE`、`INVALID_DATE_RANGE`、`INVALID_COVERAGE_RANGE` | 格式、区间或比例非法。 |
| 403 | `FORBIDDEN`、`AUTHORIZATION_INACTIVE` | 角色或授权不允许。 |
| 404 | `CASE_NOT_FOUND`、`EVIDENCE_NOT_FOUND` | 资源不存在。 |
| 409 | `VERSION_CONFLICT`、`MULTIPLE_PRIMARY_NODES` | 版本或唯一主节点冲突。 |
| 422 | `CALCULATION_PENDING`、`OVERRIDE_REASON_REQUIRED` | 信息不足或业务规则未满足。 |
| 500 | `INTERNAL_ERROR` | 未知错误；响应不暴露堆栈和敏感数据。 |

领域函数当前使用 `INVALID_REFERENCE_DATE`、`INVALID_GUARD_DATE`、`INVALID_COVERAGE_RANGE`、`INVALID_SCENARIO_PATCH` 和 `EVIDENCE_NOT_FOUND`；服务层映射时保留可追溯的 `details.domainCode`。

## 6. 幂等、审计与安全

创建、重算、复核、授权和导出接口接受 `Idempotency-Key`。所有写操作鉴权、校验输入并追加审计。输出按角色裁剪证据摘录；日志只记 `requestId`、案例匿名标识、角色、结果和错误码。无任何真实银行或第三方生产接口设计。
