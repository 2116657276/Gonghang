# 潮汐·创证数据模型

> 文档状态：历史研究分支。本文为科创双证据方案的概念数据模型，不代表当前项目数据模型已确定或建库。

> 本文为概念数据模型，用于统一文档口径，不代表已经建成生产数据库。

## 一、主要数据表

| 表 | 主键 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| `project_space` | `project_id` | `subject_ref`、`product_ref`、`guard_date` | 项目与经营约束 |
| `authorization` | `authorization_id` | `purpose`、`scope`、`expires_at`、`status` | 处理和共享授权 |
| `evidence_file` | `file_id` | `content_hash`、`category`、`version`、`storage_ref` | 原始材料与版本 |
| `evidence_fact` | `fact_id` | `type`、`value`、`source_ref`、`status`、`confidence` | 候选与核验事实 |
| `evidence_node` | `node_id` | `chain_type`、`stage`、`time_range`、`status` | 双证据节点 |
| `evidence_link` | `link_id` | `from_id`、`to_id`、`relation`、`status` | 链内及跨链关系 |
| `review_record` | `review_id` | `target_id`、`decision`、`reason`、`actor_role` | 人工复核历史 |
| `clock_snapshot` | `snapshot_id` | `cash_range`、`readiness_range`、`basis_refs` | 双时钟版本快照 |
| `passport_snapshot` | `passport_id` | `scope`、`recipient`、`expires_at`、`version` | 脱敏交付快照 |
| `audit_event` | `event_id` | `type`、`actor`、`before`、`after`、`idempotency_key` | 不可静默修改的事件 |

## 二、约束

- `VERIFIED` 事实必须关联来源或有效复核记录。
- 文件按内容摘要去重，但保留用户确认的业务版本。
- `confidence` 只能用于抽取质量，不能驱动授信或事实核验结论。
- 护照快照生成后不可原地更新；任何变化生成新版本。
- 删除请求按适用规则执行，审计记录仅保留最小必要信息和处理依据。
