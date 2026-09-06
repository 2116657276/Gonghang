# 潮汐·创证状态机

> 文档状态：历史研究分支。本文状态仅适用于科创双证据研究对象，不能直接作为当前小微借贷周期的状态机。

## 一、事实状态机

`CANDIDATE → PENDING_REVIEW → VERIFIED`

候选事实在规则冲突时进入 `CONFLICT`，在人工否定时进入 `REJECTED`，在来源或授权失效时进入 `EXPIRED`。`CONFLICT` 只能经补充来源或人工复核转为 `PENDING_REVIEW/VERIFIED/REJECTED`，不得由模型自动消除。

| 当前状态 | 允许转入 | 必要条件 |
| --- | --- | --- |
| `CANDIDATE` | `PENDING_REVIEW/CONFLICT/REJECTED` | 完成来源定位及规则校验 |
| `CONFLICT` | `PENDING_REVIEW/REJECTED` | 保留冲突双方来源并提交处理意见 |
| `PENDING_REVIEW` | `VERIFIED/CONFLICT/REJECTED` | 具名复核者提交依据 |
| `VERIFIED` | `EXPIRED/CONFLICT` | 来源失效或新证据形成冲突 |
| `REJECTED` | `CANDIDATE` | 出现新版本材料并重新提取 |
| `EXPIRED` | `CANDIDATE` | 更新授权或来源后重新核验 |

## 二、项目窗口状态机

项目窗口状态为 `PENDING_VERIFICATION`、`STEADY`、`CASH_PRESSURE`、`READINESS_PRESSURE` 或 `DUAL_PRESSURE`。状态仅由双时钟依据和保护日比较产生，不允许人工直接选择“稳态”。

### 状态优先级

1. 缺少关键依据时优先进入 `PENDING_VERIFICATION`。
2. 依据完整后分别判断资金基准区间和就绪基准区间是否晚于保护日。
3. 任一区间跨越保护日时，必须增加不确定性提示，即使基准日期未越界。

## 三、事件与幂等

每次材料上传、字段纠正、规则校验、人工复核、授权变化和时钟重算均形成事件。事件至少包含 `eventId`、`aggregateId`、`eventType`、`actorRole`、`occurredAt`、`inputVersion`、`ruleVersion` 和 `idempotencyKey`。重复事件不能造成重复节点、重复复核或护照版本跳跃。

## 四、失败状态

外部服务超时、文件损坏、来源定位失败和权限不足不得转换为业务已完成状态。界面应显示具体失败、保留已成功步骤，并允许重试或转人工。
