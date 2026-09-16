# 外部依据与证据边界

更新日期：2026-09-16。状态：整理本会话已核对的公开资料与本地历史记录；本轮文档更新未新增外部实测。

| 来源 | 可以支持的结论 | 不能推导的结论 |
| --- | --- | --- |
| [工行杯第十七届介绍](https://www.gonghangbei.com/dsjs.html)、[赛事指引](https://www.gonghangbei.com/sszy.html) | 青年群体服务、数字金融等方向；国二国三在全国半决赛设置 | 某功能数量对应奖项、获奖概率、报名系统具体截止日已核实 |
| [工行收支查询说明](https://wap.icbc.com.cn/page/721855677772218394.html) | 银行有账户收支查询服务背景 | 团队已获账户数据 API 权限 |
| [工行自动还款协议](https://www.gd.icbc.com.cn/ICBC/%E7%89%A1%E4%B8%B9%E5%8D%A1/%E7%AB%A0%E7%A8%8B%E5%8D%8F%E8%AE%AE/zdhk.htm)、[分期业务须知](https://media.icbc.com.cn/agreement/1199926620895584262.html) | 还款账户与欠款账户、当期还款计划具有独立含义 | 选择一张卡即可读取全部债务，或项目已具备自动还款能力 |
| [工行生活平台介绍](https://www.icbc.com.cn/page/721852515087056916.html) | 银行已有生活消费服务场景 | 平台所有商品已向行止开放下单和售后接口 |
| [千问消费能力公告](https://www.alibabagroup.com/en-US/document-1948497434959151104) | 已有产品公开介绍对话选购及支付；需说明行止应用贡献 | 行止优于现有产品、国内首创或已有用户效果 |
| [Pi 版本资料](https://github.com/earendil-works/pi/releases/tag/v0.85.1) | 现有工程复用来源；具体已安装版本由锁文件体现 | 本轮核查其仍为最新版本，或 Pi 自行保证资金正确性 |
| [DeepSeek API 资料](https://api-docs.deepseek.com/) | 模型服务资料入口；历史调用见本地记录 | 本轮重新核实最新模型价格或新增运行效果 |
| [支付宝退款接口](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/alipay-trade-refund.md)、[退款查询](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/alipay-trade-fastpay-refund-query.md) | 原单退款与查询契约的历史研究依据 | 所有产品权限、特殊交易和银行到账已验证 |
| [原交易验收记录](../archive/transaction-verification.md) | 历史后端 55 项检查及首批沙箱付款／原单退款／待付关单实际记录 | 新账户、规划、候选、前端及完整新 Demo 已通过 |

## 当前尚缺

真实银行接口及授权范围、银行 App 宿主、真实商户接入、用户需求、推荐体验和新连续链均未完成验证。异步通知、特殊渠道中断及复杂退款保留具体未执行范围；首批沙箱核心链已验证，不再同时写为“从未付款退款”。

对外提交前复核当届方向、截止日期和实际引用的产品条件，使用明确来源与日期。不在方案中填入合作机构、用户数量、性能或收益的虚构数字。公开研究和历史测试分别保留范围，不能互相替代。
