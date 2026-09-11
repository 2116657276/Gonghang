# 行止：平台与支付研究摘要

> 本文件只保留外部资料、研究判断和限制，不是实施基线。现行需求、规则、阶段和验收分别以[产品需求](../01-product/prd.md)、[领域规则](../02-domain/rules-and-state.md)、[分阶段开发计划](../03-engineering/development-plan.md)和[验证策略](../04-quality/verification.md)为准。

| 文档字段 | 内容 |
| --- | --- |
| 更新日期 | 2026-09-11（研究资料主要于 2026-09-07 核对） |
| 文档性质 | 外部平台、支付接口和接入限制的研究摘要 |
| 当前主线 | TypeScript 全栈网页、官方沙箱支付、Pi 单 Agent、受控计划变更与交易善后 |
| 已定模型 | Pi v0.85.1；DeepSeek `deepseek-v4-flash`；累计模型费用上限 ¥100；常规服务端令牌桶限流 |
| 实施状态 | 恢复开发前最近一次可引用证据覆盖 S1 本地业务基础与 S3 服务端善后基础；S2 仅完成沙箱只读查单连通性核验；Pi 0.85.1 已安装并通过本地确定性工具循环，真实 DeepSeek 只读／方案联调已通过；2026-09-11 已恢复开发，交易执行工具与事件恢复已接入并作局部行为核对，本轮实现与检查结果以开发计划 1.8 为准，S4／S5 未放行 |

## 一、结论

首版继续采用“网页先行、官方沙箱优先、模型只做受控决策循环”的路线。支付宝普通网页支付是当前 P0 的验证入口；支付宝 Agent 支付、微信小程序、微信 AI 支付和真实资金属于后续评估，不改变首版业务账本和授权边界。

行止不是接管用户手机或第三方 App 的万能助手。它在自建测试商户和受控支付适配器之上，解释计划变化、停止新购买、生成善后方案并跟踪可核验事实。模型不能确认授权、修改金额、读取密钥、直接退款或绕过服务端权限。

Pi 的上游核心提供 Agent 状态、工具循环和事件能力，但不提供本项目需要的交易账本、支付一致性或权限隔离。首版只嵌入 `@earendil-works/pi-agent-core@0.85.1` 与 `@earendil-works/pi-ai@0.85.1`，不引入完整编程助手 CLI，也不暴露 shell、任意 HTTP、任意文件写入或支付密钥工具。

DeepSeek 通过 `https://api.deepseek.com` 的 OpenAI 兼容接口提供 `deepseek-v4-flash`。公开资料列出的当前模型版本为 `DeepSeek-V4-Flash-0731`；价格按 token 和时段计费且可能调整，因此本地 ¥100 是项目保护阈值，不是把美元单价换算成固定承诺。实际接入必须记录响应 usage、人民币费率版本、账本余额及 429 处理。

## 二、平台事实与适用范围

| 方向 | 可以采用的有限结论 | 当前不作的承诺 |
| --- | --- | --- |
| 支付宝网页支付 | 公开文档提供下单、查单、关单、退款、退款查询和可选通知路径；本机可先用主动查单，不以 `notify_url` 阻断本地演示 | 公开接口不等于当前账号已获批；本项目尚未完成付款、退款、关单或通知交易 |
| 支付宝 Agent 支付 | 可作为普通网页支付之上的增强交接路径，继续使用同一订单账本和受控业务接口 | 不默认拥有沙箱兼容性、用户授权隔离或退款回传能力；不列为 P0 前置 |
| 微信小程序／普通支付 | 可作为后续手机入口，商户、主体和支付资质需单独核实；微信 APIv3 的测试条件不能套用旧教程 | 不把个人小程序、旧沙箱教程或 web-view 限制写成可直接落地的 P0 路线 |
| 微信 AI 支付 | 已有公开产品与商户准入说明，可作为后续比较 | 不因“已有产品”推导本项目已经接入；企业主体和商户条件未具备时不启动 |

首版所有环境必须分开：本地模拟只证明业务状态和恢复；官方沙箱只证明测试渠道事实；正式交易另行取得主体、产品、额度和用户授权。一个沙箱卖家可以承接多个逻辑服务订单，但演示只能称为“同一测试卖家下的多订单协同”，不能冒充已经接入多家真实商户。

## 三、不可省略的支付边界

1. 生成付款表单或交接链接不等于付款成功；必须通过验签通知或主动查单核对应用、卖家、订单、金额和状态。
2. `TRADE_CLOSED` 必须结合历史付款和退款解释，不能统一翻译为“从未付款”；`TRADE_FINISHED` 不能作为继续普通退款的依据。
3. 同一次退款重试保持原单、金额和固定业务退款号；不以新的业务号绕过未知结果，也不以返回金额字段单独认定成功。
4. 渠道结果未知时保留占用，先查原单；页面关闭、模型停止或暂停新购买都不撤销已经发出的外部请求。
5. 用户接受取消不等于拥有商户退款权；退款只由受权商户入口按原单和规则执行。任何支付密码、验证码、私钥或完整付款会话都不进入模型上下文、工具返回或导出。

## 四、研究依据

- [支付宝网页支付产品与接入索引](https://aipay.alipay.com/products/ai-web-app.md) 与[接口文档](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/llms.txt)：付款、查询、退款、退款查询和关单的公开入口。
- [支付宝 Agent 支付指南](https://aipay.alipay.com/docs/skillpay.md)：增强路径的公开接入说明；不作为 P0 兼容性证据。
- [Pi 官方仓库](https://github.com/earendil-works/pi)、[v0.85.1 发布页](https://github.com/earendil-works/pi/releases/tag/v0.85.1)、[核心包说明](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)：包能力、版本、Node 要求、许可证和上游权限边界。
- [DeepSeek API 总览](https://api-docs.deepseek.com/)、[模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)、[限流与隔离](https://api-docs.deepseek.com/quick_start/rate_limit/)：基地址、模型标识、价格、并发与 429 语义。
- [ACT 委托授权域](https://www.act-protocol.com/documentation/delegation.md)、[AP2](https://ap2-protocol.org/ap2/agent_authorization/)、[A2A](https://a2a-protocol.org/latest/specification/)、[UCP](https://ucp.dev/specification/shopping/order/)：概念参照，不代表行止已通过协议认证或互操作验证。

## 五、仍需实测的事项

账号适用产品、付款设备、通知可达性、同一订单的付款—退款—关单闭环、Pi 工具事件／取消／恢复、完整业务交易调用、usage 计费和用户理解效果都未由本文件证明。若公开资料与账号实际条件冲突，先把受影响能力标为阻塞，再修改[决策台账](../00-governance/decision-log.md)和[评审议题](../00-governance/review-agenda.md)，不得用模拟结果替代外部证据。

[返回证据登记](evidence-register.md) · [返回文档中心](../README.md)
