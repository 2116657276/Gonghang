import { closePool, query } from './db/client.js';
import { claimAgentWakeup } from './domain/agent-recovery.js';
import { executeAgentRun, modelReady } from './domain/agent-runtime.js';
import { tick } from './domain/worker-runtime.js';

const agentTasks=new Map<string,{controller:AbortController;done:Promise<void>}>();
let stopping=false;
let working = false;
async function run() {
  if (working) return;
  working = true;
  try {
    await tick();
    await query(`INSERT INTO runtime_heartbeats(component,last_seen_at) VALUES('worker',now())
      ON CONFLICT(component) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at`);
    if(!stopping && modelReady() && agentTasks.size<2){
      const wakeup=await claimAgentWakeup();
      if(wakeup){
        const controller=new AbortController();
        const done=executeAgentRun(wakeup.runId,wakeup.planId,wakeup.user,wakeup.input,controller.signal)
          .catch(()=>console.error('Agent 事件恢复暂未完成，已保留运行记录。'))
          .finally(()=>agentTasks.delete(wakeup.runId));
        agentTasks.set(wakeup.runId,{controller,done});
      }
    }
  } catch (error) {
    console.error('worker 处理任务失败：', error);
  } finally {
    working = false;
  }
}

await run();
const timer = setInterval(run, 1_000);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    stopping=true;
    clearInterval(timer);
    for(const task of agentTasks.values())task.controller.abort();
    await Promise.allSettled([...agentTasks.values()].map(task=>task.done));
    await closePool();
    process.exit(0);
  });
}
