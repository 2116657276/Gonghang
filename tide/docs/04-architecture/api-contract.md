# 潮汐·创证接口契约

> 文档状态：历史研究分支。本文为科创双证据方案的概念接口契约，不代表当前项目接口已确定或部署。

> 本文为概念接口契约，用于约束后续原型设计，不代表已经部署真实接口。

## 一、通用规则

所有写请求包含 `requestId`、`actorRole`、`authorizationRef` 和 `idempotencyKey`；所有响应包含 `resultVersion`、`occurredAt`、`status` 和可机器读取的 `errors`。失败响应不能返回伪造的业务完成状态。

## 二、核心接口

| 方法与路径 | 用途 | 关键输入 | 关键输出 |
| --- | --- | --- | --- |
| `POST /projects` | 建立项目空间 | 主体、产品、授权、保护日 | 项目标识、授权状态 |
| `POST /projects/{id}/evidence` | 上传材料 | 文件、材料类型、用途 | 材料标识、处理状态 |
| `GET /projects/{id}/facts` | 查询事实账本 | 状态、类型筛选 | 候选事实、来源、版本 |
| `POST /facts/{id}/review` | 提交复核 | 结论、理由、来源补充 | 新状态、审计事件 |
| `GET /projects/{id}/graph` | 查询双证据图 | 图谱版本 | 节点、关系、冲突、缺口 |
| `POST /projects/{id}/clocks/recalculate` | 重算双时钟 | 输入版本、规则版本 | 两个区间、依据、窗口状态 |
| `POST /projects/{id}/passports` | 生成护照 | 接收方、字段、用途、有效期 | 护照版本、脱敏摘要 |

## 三、错误码

| 错误码 | 含义 | 客户端行为 |
| --- | --- | --- |
| `SOURCE_NOT_LOCATED` | 候选字段无法定位来源 | 保持候选状态，提示人工录入 |
| `FACT_CONFLICT` | 多来源字段不一致 | 展示双方来源并进入复核 |
| `INSUFFICIENT_CLOCK_BASIS` | 时钟依据不足 | 显示无法估计，不填默认日期 |
| `AUTHORIZATION_EXPIRED` | 授权过期或用途不匹配 | 停止处理并请求重新授权 |
| `VERSION_CONFLICT` | 用户基于旧版本提交修改 | 刷新后重新确认，不覆盖新版本 |
