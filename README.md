# 行止项目

行止拟作为银行青年消费规划微应用，连接轻量记账、近期资金规划、登记商品推荐选购及计划变化后的订单调整。当前代码基线已包含 001—028 迁移、A00—A06 与 B00—B07 后端接口、共享契约和受控 simulation 验证；统一前端、新消费者流程的支付宝沙箱连续演示、真实银行接入和产品上线仍未完成。

| 阅读目的 | 入口 |
| --- | --- |
| 看书面方案 | [行止项目方案](xingzhi/docs/06-contest/project-narrative.md) |
| 查完整文档 | [文档中心](xingzhi/docs/README.md) |
| 看 SQL、种子与实施顺序 | [开发计划](xingzhi/docs/03-engineering/development-plan.md)、[数据迁移设计](xingzhi/docs/03-engineering/data-and-events.md) |
| 运行已有程序 | [本地说明](xingzhi/README.md) |
| 核对验证与证据 | [新版验证策略](xingzhi/docs/04-quality/verification.md) |
| 历史项目和获奖样本研究 | [历史比较](工行杯_三项目总览.md) |

当前交付包含 A00—A06 与 B00—B07 的后端接口、共享契约、001—028 增量迁移、受控 simulation 定向测试及配套文档。B02 的无账户需求草稿可以保存，B03—B07 已接入购买意图、本人确认、订单/Worker、意外调整、退款恢复和证据读取；新消费者 Agent 仍只保存非执行草稿。仓库总体进度、阶段状态与验收结论以[文档中心](xingzhi/docs/README.md)、[开发计划](xingzhi/docs/03-engineering/development-plan.md)和[验证策略](xingzhi/docs/04-quality/verification.md)为准；下一步先完成 M1 后端补充收口和 HTTP 集中验收，通过后进入 M2 前端联调，M3 再做新流程沙箱连续演示和交付验收。
