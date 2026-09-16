import { closePool, transaction } from './client.js';
import { seedConsumerDemoScenario } from './consumer-demo-scenario.js';

const scenarioKey = process.argv[2];
const serviceOn = process.argv[3];
const password = process.env.SEED_DEMO_PASSWORD;
try {
  if (!scenarioKey || !serviceOn) throw new Error('请传入场景标识和当前服务日期 YYYY-MM-DD。');
  if (!password || password === 'change-this-local-demo-password') throw new Error('请配置本地 Demo 密码。');
  const result = await transaction((client) => seedConsumerDemoScenario(client,
    { scenarioKey, serviceOn, password }));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closePool();
}
