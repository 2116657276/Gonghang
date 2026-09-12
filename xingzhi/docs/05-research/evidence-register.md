# 外部能力与证据登记

| 字段 | 内容 |
| --- | --- |
| 文档编号 | XZ-EVIDENCE |
| 更新日期 | 2026-09-12 |
| 状态 | 已核对 Pi 官方发行版、核心包与 DeepSeek v4 flash 的公开资料并锁定 S4 选型；两个 Pi 包已安装，类型检查、本地确定性工具循环、真实只读／方案联调、局部执行评测和费用账本有证据，429 退避另有本地受控切片记录；交易执行工具、事件恢复、T10 复核和变更善后连续链已作本地受控核对，本轮实现与检查结果以开发计划 1.8—1.10 为准，S4／S5 未放行 |

## 一、证据台账

| 编号 | 来源 | 支持的有限结论 | 核对与限制 |
| --- | --- | --- | --- |
| EV-01 | [Pi v0.85.1 发布页](https://github.com/earendil-works/pi/releases/tag/v0.85.1)、[核心包清单](https://github.com/earendil-works/pi/blob/main/packages/agent/package.json)、[核心包说明](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md) | 官方最新发行版为 v0.85.1；`@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 可作为嵌入式 Agent 核心，核心包要求 Node `>=22.19.0`，许可证为 MIT | 2026-09-08 按官方 releases、package.json 与 README 核对；两个包已精确安装，Node、类型检查、本地确定性循环和真实只读／方案联调通过；交易执行工具、事件恢复、T10 复核和变更善后连续链已有局部行为证据，完整真实模型／官方取消与恢复仍未验证 |
| EV-09 | [DeepSeek API 总览](https://api-docs.deepseek.com/)、[模型与价格](https://api-docs.deepseek.com/quick_start/pricing/) | 使用 OpenAI 兼容基地址 `https://api.deepseek.com` 和模型标识 `deepseek-v4-flash`；当前文档列出的模型版本为 `DeepSeek-V4-Flash-0731`，支持工具调用 | 2026-09-08 重新核对公开文档；本项目现已配置本机密钥，真实只读烟测通过；完整业务 Agent 仍待验收 |
| EV-10 | [DeepSeek 价格表](https://api-docs.deepseek.com/quick_start/pricing/) | 价格按输入／输出 token 和高峰／低峰时段计费，官方明确提示价格可能调整；项目费用上限以本地人民币账本为准，不把美元单价直接写成固定人民币额度 | 价格只用于估算和账本核对；接入时必须记录实际响应 usage、人民币费率版本和账本余额，预算不足时拒绝新调用 |
| EV-11 | [DeepSeek 限流与隔离](https://api-docs.deepseek.com/quick_start/rate_limit/)、[错误码](https://api-docs.deepseek.com/quick_start/error_codes/) | 官方说明并发上限按账号及模型计算，超限返回 429；`user_id` 可用于业务侧隔离；429 不能被当成业务成功 | 项目采用更保守的服务端令牌桶和单计划并发 1；如响应带 `Retry-After` 则遵守，否则使用本地退避；本地限流不是 DeepSeek 账号额度承诺 |
| EV-02 | [退款接口](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/alipay-trade-refund.md) | 商户按原单退款；重复请求保持退款号，调用成功不单独证明退款成功 | 本轮核对接口说明与关键字段；账号及沙箱未实测 |
| EV-03 | [退款查询](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/alipay-trade-fastpay-refund-query.md) | 同请求查询退款状态；明确退款成功字段及查询等待建议 | 本轮核对说明与关键字段；未实测 |
| EV-04 | [交易查询](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/alipay-trade-query.md) | 交易状态查询；关闭状态需结合付款退款历史解释 | 2026-09-06 使用脱敏临时订单号调用本项目沙箱网关，返回 `ACQ.TRADE_NOT_EXIST`；未核验真实订单状态 |
| EV-05 | [网页付款接口](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/alipay-trade-page-pay.html) | 服务端通过 SDK 生成付款表单或跳转链接；返回交接信息不等于交易成功 | S2 本机适配已生成沙箱跳转链接并确认不携带可选通知地址；尚未进入付款页 |
| EV-08 | [异步通知说明](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/async-notify-verify.html) | 通知须验签，并核对应用、卖家、订单、金额和交易状态；通知未达时还须查询订单事实 | S2 本机适配前复核。渠道可访问通知地址及真实签名、重试行为未实测 |
| EV-06 | [支付宝传统供给 Skill 指南](https://aipay.alipay.com/docs/skillpay.md) | 官方 Agent 支付交接的研究入口 | 沿用旧研究；自建 Pi 宿主及沙箱兼容性未确认，不作 P0 前提 |
| EV-07 | [历届样本分析](../../../工行杯_三项目总览.md) | 样本主题描述与有限统计解释 | 同级工作簿已存在；本轮按项目明细复核关键计数，不能用于获奖概率 |

原平台对比中的其他来源仍保存在[历史研究](platform-and-payment-research.md)，不自动升级为本轮重新验证的证据。发布前引用平台准入、赛事规则或产品限制时重新核查。

## 二、项目尚缺的证据

| 项目 | 当前状态 | 补齐要求 |
| --- | --- | --- |
| 沙箱账号、应用、买卖家与产品权限 | 已填入本机配置，未完成完整权限核验 | 继续按沙箱后台确认适用产品，不公开秘密值 |
| 网页及设备付款体验、通知可达性 | 未验证 | 记录环境、设备、流程与结果 |
| 同一订单付款退款闭环 | 未验证 | 原单、退款请求、金额、时间与渠道证据 |
| Pi 依赖与模型兼容 | 两个 0.85.1 包已安装；Node、类型检查、本地确定性工具循环和真实只读／方案联调通过；交易执行工具与恢复已有局部行为证据 | 继续验证完整交易执行、取消与恢复语义；不把方案联调扩大为完整交易验收 |
| DeepSeek API key、模型调用与费用 | 本机密钥已配置，真实只读／方案联调和人民币 usage 结算已通过；完整业务交易调用未验证 | 仅由服务端读取 `DEEPSEEK_API_KEY`；继续记录响应 usage、费用估算、429 处理和预算拒绝 |
| Agent 任务理解与恢复效果 | 未验证 | 固定案例集、模型条件、Pi 版本、提示词修订、失败与复测记录 |
| 用户需求与竞赛差异化 | 待访谈和实测 | 匿名需求证据、对照案例和自主贡献说明 |

## 三、登记规则

来源链接、核对日期、支持结论、适用环境、核实等级和限制同时记录。联调记录须追加执行者角色、实际版本、环境、用例与脱敏证据位置。文档存在接口不表示用户账号有权调用，不表示运行成功，更不表示真实资金已经发生。

本机 S2 适配使用 `alipay-sdk@4.14.0`，具体版本由项目锁文件固定；它用于生成交接、验签、查询、关单和受控退款调用。网关地址不在代码中推定，本机已用沙箱参数完成一次只读查单连通性核验；这不代表付款、退款、关单或通知联调完成。S4 的两个 Pi 包已安装并通过本地无资金确定性循环，真实 DeepSeek 只读烟测现已通过；直接按官方人民币费率计入预算，无需汇率。


## 2026-09-08 实施补证

已重新读取支付宝官方[退款接口](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/alipay-trade-refund.md)、[退款查询](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/alipay-trade-fastpay-refund-query.md)及[关单接口](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/alipay-trade-close.md)。退款响应的 `refund_fee` 为累计金额，不能作为分批退款的本批金额判据；实现按原单与固定退款号查询，核对本批 `refund_amount` 与 `REFUND_SUCCESS`。同单退款间隔至少 3 秒，退款查询采用 15 秒起步，满足官方建议的 10 秒以上等待。以上是公开契约及本地适配实现，尚无官方交易实测。

已安装 Pi 两个 0.85.1 包，按实际类型声明接入 ESM 的 Agent 与流接口，本地确定性工具循环通过。DeepSeek [模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)于本日重新核对：烟测以 V4 Flash 高峰输入未命中 $0.44／百万 token、输出 $1.32／百万 token 作为保守估算，缓存输入也按未命中上界估计；价格仍可能变动，后续真实调用前复核。以上为此前美元换算方案的历史记录，现已废止并改为直接人民币计费，见下方本轮记录。

### 人民币费率与真实烟测更新（2026-09-08）

重新核对 [DeepSeek 官方中文价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)：V4 Flash 每百万 token 高峰价为缓存命中 0.10 元、未命中 3 元、输出 9 元，闲时减半；高峰为北京时间工作日 9—12 时、14—18 时。后端直接用人民币高峰价保护预算，取消美元换算及汇率配置；单价与核验日期保存在 `model-pricing.ts`，实际 usage 与人民币价格版本一起入账。真实两轮只读烟测通过，预算估算 0.002286 元，具体证据见验证记录第九节。平台账单为实际扣费依据，后续费率变化须重新核对。
