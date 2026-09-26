import { createHash, randomUUID } from 'node:crypto';
import { closePool, transaction } from './client.js';
import { hashPassword } from '../auth/password.js';

const password = process.env.SEED_DEMO_PASSWORD;
if (!password || password === 'change-this-local-demo-password') {
  throw new Error('请先在 .env 设置不等于示例值的 SEED_DEMO_PASSWORD，再运行 db:seed。');
}

const accounts = [
  { email: 'consumer-a@xingzhi.local', name: '林知行', role: 'consumer' },
  { email: 'consumer-b@xingzhi.local', name: '周远', role: 'consumer' },
  { email: 'merchant@xingzhi.local', name: '行止测试商户', role: 'merchant_admin' },
  { email: 'reviewer@xingzhi.local', name: '项目审核者', role: 'reviewer' },
] as const;

try {
  await transaction(async (client) => {
    const users = new Map<string, string>();
    for (const account of accounts) {
      const existing = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [account.email]);
      if (existing.rows[0]) {
        if (account.role === 'merchant_admin' || account.role === 'reviewer') {
          await client.query(
            'UPDATE users SET password_hash = $1 WHERE id = $2',
            [await hashPassword(password), existing.rows[0].id],
          );
          const identityDigest = createHash('sha256').update(account.email).digest('hex');
          await client.query('DELETE FROM login_attempt_limits WHERE identity_digest = $1', [identityDigest]);
        }
        users.set(account.role, existing.rows[0].id);
        continue;
      }
      const id = randomUUID();
      await client.query(
        'INSERT INTO users (id, email, display_name, role, password_hash) VALUES ($1, $2, $3, $4, $5)',
        [id, account.email, account.name, account.role, await hashPassword(password)],
      );
      users.set(account.role, id);
    }
    const merchantId = users.get('merchant_admin')!;
    const catalog = [
      ['A-RAIL', 'A 去程交通服务', 'transport', '去程交通服务，购买后可保留为原计划的一部分。', 42_000, '可按原单取消，默认全额模拟退款', 0, 'full_refund', 'SUCCESS', 'SUCCESS', 'SUCCESS'],
      ['B-STAY', 'B 住宿预订', 'stay', '两晚住宿，示例中取消可能产生 80 元费用。', 88_000, '示例取消费用 80 元；退款须由商户处理', 8_000, 'fee_80', 'SUCCESS', 'SUCCESS', 'SUCCESS'],
      ['C-ACTIVITY', 'C 景点服务', 'activity', '待付款景点服务，用于展示关单与未知状态。', 18_000, '未付款可申请关闭；模拟状态可能待核对', 0, 'full_refund', 'PENDING', 'SUCCESS', 'SUCCESS'],
      ['D-PLAN', 'D 到站接驳', 'unbooked', '仅保留在计划中，不创建订单或占用预算。', 12_000, '无订单计划项只能保留或停止', 0, 'full_refund', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
    ];
    for (const [code, name, kind, description, price, ruleLabel, fee, rule, paymentMode, closeMode, refundMode] of catalog) {
      await client.query(`
        INSERT INTO catalog_items (id, merchant_id, code, name, kind, description, price_minor, rule_label, cancellation_fee_minor,
          cancellation_rule, simulation_mode, close_simulation_mode, refund_simulation_mode)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (code) DO UPDATE SET
          name = EXCLUDED.name, description = EXCLUDED.description, price_minor = EXCLUDED.price_minor,
          rule_label = EXCLUDED.rule_label, cancellation_fee_minor = EXCLUDED.cancellation_fee_minor,
          cancellation_rule = EXCLUDED.cancellation_rule, simulation_mode = EXCLUDED.simulation_mode,
          close_simulation_mode = EXCLUDED.close_simulation_mode, refund_simulation_mode = EXCLUDED.refund_simulation_mode,
          active = true
      `, [randomUUID(), merchantId, code, name, kind, description, price, ruleLabel, fee, rule, paymentMode, closeMode, refundMode]);
    }
  });
  console.log('已写入行止 S1 本地测试账号与 A/B/C/D 目录。');
} finally {
  await closePool();
}
