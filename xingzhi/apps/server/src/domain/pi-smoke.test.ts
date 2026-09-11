import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, type AgentEvent, type StreamFn } from '@earendil-works/pi-agent-core';
import { Type, createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';

// This model never reaches a provider: the stream below is a deterministic local fixture.
const model: Model<'openai-completions'> = {
  id:'deepseek-v4-flash',name:'Local smoke fixture',api:'openai-completions',provider:'deepseek',
  baseUrl:'https://api.deepseek.com',reasoning:false,input:['text'],contextWindow:8192,maxTokens:512,
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
};
function message(content: AssistantMessage['content'],stopReason:AssistantMessage['stopReason']):AssistantMessage {
  return {role:'assistant',content,api:model.api,provider:model.provider,model:model.id,stopReason,timestamp:Date.now(),
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
}
function stream(messages:AssistantMessage[]):StreamFn {
  let index=0;
  return ()=>{
    const result=messages[index++];assert.ok(result,'工具循环必须有界');
    const events=createAssistantMessageEventStream();
    events.push({type:'done',reason:result.stopReason as 'stop'|'length'|'toolUse',message:result});
    return events;
  };
}

test('Pi 0.85.1 本地工具循环、生命周期事件与无确认工具边界',async()=>{
  let reads=0;const events:AgentEvent['type'][]=[];
  const agent=new Agent({initialState:{model,systemPrompt:'只读烟测',tools:[{
    name:'get_plan_orders',label:'读取计划',description:'只读固定测试事实',parameters:Type.Object({}),
    async execute(){reads++;return {content:[{type:'text',text:'已付款，尚未退款'}],details:{source:'local_fixture'}};},
  }]},streamFn:stream([
    message([{type:'toolCall',id:'read_1',name:'get_plan_orders',arguments:{}}],'toolUse'),
    message([{type:'text',text:'读取完毕'}],'stop'),
  ])});
  agent.subscribe(event=>{events.push(event.type);});await agent.prompt('读取测试计划');await agent.waitForIdle();
  assert.equal(reads,1);assert.ok(events.includes('tool_execution_end'));assert.ok(events.includes('agent_end'));
  assert.equal(agent.state.isStreaming,false);
  assert.deepEqual(agent.state.tools.map(tool=>tool.name),['get_plan_orders']);
});

test('Pi 未注册的确认工具不能执行',async()=>{
  const agent=new Agent({initialState:{model,tools:[]},streamFn:stream([
    message([{type:'toolCall',id:'forbidden',name:'confirm_purchase',arguments:{}}],'toolUse'),
    message([{type:'text',text:'需要用户确认'}],'stop'),
  ])});
  await agent.prompt('尝试越权确认');
  const result=agent.state.messages.find(m=>m.role==='toolResult');
  assert.ok(result && result.role==='toolResult' && result.isError);
});
