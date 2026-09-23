import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';

export const consumerPlanningToolNames = [
  'read_budget_basis',
  'read_month_ledger_summary',
  'search_offers',
  'save_planning_draft',
] as const;

type ToolName = typeof consumerPlanningToolNames[number];
type ToolHandler = (args: unknown) => Promise<Record<string, unknown>>;

// This is a separate allowlist for the new consumer workflow. The historical
// plan Agent keeps its own confirmed-order aftercare tools.
export function consumerPlanningAgentTools(handlers: Record<ToolName, ToolHandler>): AgentTool[] {
  const nullableDate = Type.Union([Type.String({ format: 'date' }), Type.Null()]);
  const nullableAmount = Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]);
  const nullablePriority = Type.Union([Type.Literal('required'), Type.Literal('adjustable'), Type.Null()]);
  const nullableUuid = Type.Union([Type.String({ format: 'uuid' }), Type.Null()]);
  const suggestion = Type.Union([Type.Object({
    title: Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()]),
    plannedOn: nullableDate,
    estimatedAmountMinor: nullableAmount,
    priority: nullablePriority,
    catalogItemId: nullableUuid,
    reason: Type.String({ minLength: 2, maxLength: 300 }),
  }, { additionalProperties: false }), Type.Null()]);
  const draftItem = Type.Object({
    title: Type.String({ minLength: 1, maxLength: 120 }),
    plannedOn: nullableDate,
    userEstimatedAmountMinor: nullableAmount,
    priority: nullablePriority,
    requirements: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 }),
    catalogItemId: nullableUuid,
    suggestion,
  }, { additionalProperties: false });
  const definitions: Array<{
    name: ToolName;
    label: string;
    description: string;
    parameters: ReturnType<typeof Type.Object>;
  }> = [
    {
      name: 'read_budget_basis' as const,
      label: '读取预算依据',
      description: '读取本人已授权周期的资金依据，只返回解释规划所需字段。',
      parameters: Type.Object({}, { additionalProperties: false }),
    },
    {
      name: 'read_month_ledger_summary' as const,
      label: '读取月度账目汇总',
      description: '按本次绑定的本人预算账户读取指定上海自然月的已入账收支、退款和分类汇总，不返回逐笔流水。',
      parameters: Type.Object({
        month: Type.String({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }),
      }, { additionalProperties: false }),
    },
    {
      name: 'search_offers' as const,
      label: '查询登记商品',
      description: '按日期和可选分类读取银行平台已登记候选，不创建选择或交易。',
      parameters: Type.Object({
        plannedOn: Type.String({ format: 'date' }),
        categoryCode: Type.Optional(Type.String()),
      }, { additionalProperties: false }),
    },
    {
      name: 'save_planning_draft' as const,
      label: '保存规划草稿',
      description: '保存严格校验的待确认草稿，不写预算项目、储蓄目标、订单、支付或退款。',
      parameters: Type.Object({
        items: Type.Array(draftItem, { minItems: 1, maxItems: 20 }),
      }, { additionalProperties: false }),
    },
  ];
  return definitions.map((definition) => ({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    async execute(_callId: string, args: unknown) {
      const result = await handlers[definition.name](args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        details: {
          source: definition.name === 'save_planning_draft'
            ? 'validated_planning_draft'
            : definition.name === 'read_month_ledger_summary' ? 'posted_ledger_month_summary'
              : 'local_planning_snapshot',
        },
      };
    },
  }));
}
