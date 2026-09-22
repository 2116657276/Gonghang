import { closePool, transaction } from './client.js';
import { seedConsumerDemoScenario } from './consumer-demo-scenario.js';

const scenarioKey = process.argv[2];
const serviceOn = process.argv[3];
const mode = process.argv[4] ?? 'complete';
const aftercareMode = process.argv[5] ?? 'automatic';
const password = process.env.SEED_DEMO_PASSWORD;
try {
  if (!scenarioKey || !serviceOn) throw new Error('请传入场景标识和当前服务日期 YYYY-MM-DD。');
  if (mode !== 'complete' && mode !== 'account-only') {
    throw new Error('场景模式只能是 complete 或 account-only。');
  }
  if (aftercareMode !== 'automatic' && aftercareMode !== 'merchant-review') {
    throw new Error('售后分支只能是 automatic 或 merchant-review。');
  }
  if (!password || password === 'change-this-local-demo-password') throw new Error('请配置本地 Demo 密码。');
  const result = await transaction((client) => seedConsumerDemoScenario(client,
    { scenarioKey, serviceOn, password, mode, aftercareMode }));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closePool();
}
