import { transaction, closePool } from './client.js';
import { seedConsumerCatalog } from './consumer-catalog.js';
const plannedOn = process.argv[2];
try {
  if (!plannedOn) throw new Error('请传入固定 Demo 服务日期 YYYY-MM-DD。');
  await transaction((client) => seedConsumerCatalog(client, plannedOn));
  console.log(`消费者 Demo 目录与 ${plannedOn} 报价初始化完成；重复初始化不覆盖原记录。`);
} finally {
  await closePool();
}
