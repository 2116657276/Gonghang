import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { offerSearchInput } from '@xingzhi/contracts';

// Independent definitions: never run the historical A/B/C/D upsert here.
export async function seedConsumerCatalog(client: PoolClient, plannedOn: string) {
  offerSearchInput.parse({ plannedOn });
  const validUntil = new Date(`${plannedOn}T23:59:59+08:00`);
  if (validUntil.getTime() <= Date.now()) throw new Error('Demo 服务日期必须尚未结束。');
  const merchant = await client.query<{ id: string }>("SELECT id FROM users WHERE role='merchant_admin' ORDER BY created_at,id LIMIT 1");
  if (!merchant.rows[0]) throw new Error('请先准备本地测试商户账号。');
  const definitions = [
    { code: 'CONSUMER-DINNER-99', name: 'Demo 双人晚餐', price: 9900, mode: 'orderable' },
    { code: 'CONSUMER-DINNER-69', name: 'Demo 简餐', price: 6900, mode: 'orderable' },
    { code: 'CONSUMER-FOOD-LISTING', name: 'Demo 饮食灵感', price: 0, mode: 'listing' },
  ];
  for (const item of definitions) {
    await client.query<{ id: string }>(`INSERT INTO catalog_items
      (id,merchant_id,code,name,kind,description,price_minor,rule_label,cancellation_fee_minor,
       cancellation_rule,simulation_mode,close_simulation_mode,refund_simulation_mode,
       category_code,location_label,tags,purchase_mode)
      VALUES ($1,$2,$3,$4,'food','预先登记的本地测试商品，不代表真实商户供给。',$5,
        '受控模拟全额退款；申请不代表到账',0,'full_refund','SUCCESS','SUCCESS','SUCCESS',
        'food','测试商圈',ARRAY['demo'],$6)
      ON CONFLICT (code) DO NOTHING RETURNING id`, [randomUUID(),merchant.rows[0].id,item.code,item.name,item.price,item.mode]);
    if (item.mode === 'listing') continue;
    const catalog = await client.query(`SELECT * FROM catalog_items WHERE code=$1 FOR UPDATE`, [item.code]);
    const row = catalog.rows[0];
    // Do not reactivate withdrawn data or silently replace an existing date's evidence.
    if (!row.active || row.purchase_mode !== 'orderable') continue;
    const existing = await client.query('SELECT 1 FROM offer_quotes WHERE catalog_item_id=$1 AND service_on=$2::date', [row.id,plannedOn]);
    if (existing.rowCount) continue;
    await client.query(`INSERT INTO offer_quotes
      (id,catalog_item_id,provider,quote_source,provider_quote_ref,quote_version,price_minor,
       service_on,rule_version,rule_snapshot,valid_until)
      SELECT $1,$2,'simulation','demo',$3,COALESCE(MAX(quote_version),0)+1,$4,$5::date,$6,$7::jsonb,$8
      FROM offer_quotes WHERE catalog_item_id=$2`,
    [randomUUID(),row.id,`${item.code}:${plannedOn}`,row.price_minor,plannedOn,row.rule_version,
      JSON.stringify({ cancellationRule: row.cancellation_rule, cancellationFeeMinor: row.cancellation_fee_minor, label: row.rule_label }),validUntil]);
  }
}
