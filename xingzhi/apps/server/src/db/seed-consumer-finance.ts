import { closePool, transaction } from './client.js';
import { seedConsumerFinanceDemo } from './consumer-finance-demo.js';

try {
  const fixture = await transaction((client) => seedConsumerFinanceDemo(client));
  console.log(JSON.stringify(fixture, null, 2));
} finally {
  await closePool();
}
