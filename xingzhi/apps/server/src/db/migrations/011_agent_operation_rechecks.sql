ALTER TABLE agent_tool_calls DROP CONSTRAINT agent_tool_calls_tool_name_check;
ALTER TABLE agent_tool_calls ADD CONSTRAINT agent_tool_calls_tool_name_check
  CHECK (tool_name IN ('create_order','request_payment','pause_purchases','submit_change','get_operation_status'));
