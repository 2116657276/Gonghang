# 外部能力与证据登记

| 字段 | 内容 |
| --- | --- |
| 文档编号 | XZ-EVIDENCE |
| 更新日期 | 2026-09-05 |
| 状态 | 公开文档与项目验证分开；无账号核实或联调通过记录 |

## 一、证据台账

| 编号 | 来源 | 支持的有限结论 | 核对与限制 |
| --- | --- | --- | --- |
| EV-01 | [Pi 核心文档](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md) | 有 Agent 工具循环、事件与执行控制，适合作为嵌入候选 | 本轮公开正文核对；旧 badlogic/pi-mono 链接重定向至此；主分支不是已锁定发行版 |
| EV-02 | [退款接口](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/alipay-trade-refund.md) | 商户按原单退款；重复请求保持退款号，调用成功不单独证明退款成功 | 本轮核对接口说明与关键字段；账号及沙箱未实测 |
| EV-03 | [退款查询](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/alipay-trade-fastpay-refund-query.md) | 同请求查询退款状态；明确退款成功字段及查询等待建议 | 本轮核对说明与关键字段；未实测 |
| EV-04 | [交易查询](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/alipay-trade-query.md) | 交易状态查询；关闭状态需结合付款退款历史解释 | 本轮核对说明与状态字段；未实测 |
| EV-05 | [网页支付指南](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/ai-web-app-payment-integration-guide.html) | 网页付款、通知和交易集成的候选依据 | 沿用既有研究，本轮未完整复核；page.pay、close 与通知细节实施前重查 |
| EV-06 | [支付宝传统供给 Skill 指南](https://aipay.alipay.com/docs/skillpay.md) | 官方 Agent 支付交接的研究入口 | 沿用旧研究；自建 Pi 宿主及沙箱兼容性未确认，不作 P0 前提 |
| EV-07 | [历届样本分析](../../../工行杯_三项目总览.md) | 样本主题描述与有限统计解释 | 同级工作簿已存在；本轮按项目明细复核关键计数，不能用于获奖概率 |

原平台对比中的其他来源仍保存在[历史研究](platform-and-payment-research.md)，不自动升级为本轮重新验证的证据。发布前引用平台准入、赛事规则或产品限制时重新核查。

## 二、项目尚缺的证据

| 项目 | 当前状态 | 补齐要求 |
| --- | --- | --- |
| 沙箱账号、应用、买卖家与产品权限 | 未核实 | 经授权核对适用产品，不公开秘密值 |
| 网页及设备付款体验、通知可达性 | 未验证 | 记录环境、设备、流程与结果 |
| 同一订单付款退款闭环 | 未验证 | 原单、退款请求、金额、时间与渠道证据 |
| Pi 依赖与模型兼容 | 未验证 | 固定发行版／提交、许可证、运行时与事件语义 |
| Agent 任务理解与恢复效果 | 未验证 | 固定案例集、模型条件、失败与复测记录 |
| 用户需求与竞赛差异化 | 待访谈和实测 | 匿名需求证据、对照案例和自主贡献说明 |

## 三、登记规则

来源链接、核对日期、支持结论、适用环境、核实等级和限制同时记录。联调记录须追加执行者角色、实际版本、环境、用例与脱敏证据位置。文档存在接口不表示用户账号有权调用，不表示运行成功，更不表示真实资金已经发生。
