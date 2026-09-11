import type { PoolClient } from 'pg';
import { AppError } from './errors.js';

// One micro-CNY = 1/1,000,000 yuan. The database enforces the shared ¥100 ceiling.
export async function reserveModelCost(client:PoolClient,id:string,purpose:string,maxMicros:number) {
  if(!Number.isSafeInteger(maxMicros) || maxMicros<=0) throw new AppError(422,'MODEL_COST_INVALID','模型费用预占无效。');
  await client.query('SELECT id FROM model_budget WHERE id=1 FOR UPDATE');
  const existing=await client.query('SELECT id FROM model_usage WHERE id=$1',[id]);
  if(existing.rowCount) throw new AppError(409,'MODEL_CALL_ALREADY_RESERVED','模型调用已有费用记录，不能再次发送。');
  const result=await client.query(`UPDATE model_budget SET reserved_micros=reserved_micros+$1
    WHERE id=1 AND spent_micros+reserved_micros+$1<=100000000 RETURNING id`,[maxMicros]);
  if(!result.rowCount) throw new AppError(429,'MODEL_BUDGET_EXHAUSTED','累计模型预算不足或账本不可用。');
  await client.query('INSERT INTO model_usage(id,purpose,reserved_micros) VALUES($1,$2,$3)',[id,purpose,maxMicros]);
}

export async function settleModelCost(client:PoolClient,id:string,actualMicros:number,usage:Record<string,unknown>) {
  if(!Number.isSafeInteger(actualMicros) || actualMicros<0) throw new AppError(422,'MODEL_COST_INVALID','模型结算费用无效。');
  await client.query('SELECT id FROM model_budget WHERE id=1 FOR UPDATE');
  const result=await client.query<{reserved_micros:string;state:string}>('SELECT reserved_micros,state FROM model_usage WHERE id=$1 FOR UPDATE',[id]);
  const record=result.rows[0];if(!record) throw new Error('模型费用预占不存在。');
  if(record.state==='settled')return;
  if(actualMicros>Number(record.reserved_micros)) throw new Error('模型费用超过预占，保留原预占并停止后续调用以供核对。');
  await client.query('UPDATE model_budget SET reserved_micros=reserved_micros-$1,spent_micros=spent_micros+$2 WHERE id=1',[record.reserved_micros,actualMicros]);
  await client.query("UPDATE model_usage SET state='settled',settled_micros=$2,usage=$3,settled_at=now() WHERE id=$1",[id,actualMicros,usage]);
}
