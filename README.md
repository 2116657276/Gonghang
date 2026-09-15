# 行止项目

行止拟作为银行青年消费规划微应用，连接轻量记账、近期资金规划、登记商品推荐选购及计划变化后的订单调整。当前代码基线已包含 B00—B02 的接口、共享契约、迁移和定向测试；账户事实、真实资金计算、完整 Agent 运行链和统一选购体验仍在后续开发，不代表银行已接入或产品已上线。

| 阅读目的 | 入口 |
| --- | --- |
| 看书面方案 | [行止项目方案](xingzhi/docs/06-contest/project-narrative.md) |
| 查完整文档 | [文档中心](xingzhi/docs/README.md) |
| 看 SQL、种子与实施顺序 | [开发计划](xingzhi/docs/03-engineering/development-plan.md)、[数据迁移设计](xingzhi/docs/03-engineering/data-and-events.md) |
| 运行已有程序 | [本地说明](xingzhi/README.md) |
| 核对验证与证据 | [新版验证策略](xingzhi/docs/04-quality/verification.md) |
| 历史项目和获奖样本研究 | [历史比较](工行杯_三项目总览.md) |

当前交付包含 B00—B02 的后端接口、共享契约、增量迁移、定向测试及配套文档。B02 的无账户需求草稿可以保存；预算草稿在 A03 逐日评估端口接入前会明确返回 `FINANCE_BASIS_UNKNOWN`。仓库总体进度、阶段状态与验收结论以[文档中心](xingzhi/docs/README.md)、[开发计划](xingzhi/docs/03-engineering/development-plan.md)和[验证策略](xingzhi/docs/04-quality/verification.md)为准；已有交易后端及历史沙箱记录可复用，下一步先做 A02／A03 联合验证，再进入 B03 及后续阶段，前端仍待 M1 后端稳定后联调。
