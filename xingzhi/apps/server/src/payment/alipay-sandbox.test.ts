import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refundQueryConfirmed, yuanToMinor } from './alipay-sandbox.js';

test('退款查询必须匹配原单、退款号、金额与明确成功状态', () => {
  const valid={code:'10000',outTradeNo:'ORDER',outRequestNo:'REFUND',refundAmount:'400.00',refundStatus:'REFUND_SUCCESS'};
  assert.equal(refundQueryConfirmed(valid,'ORDER','REFUND',40000),true);
  for(const altered of [{refundStatus:undefined},{refundAmount:'800.00'},{outTradeNo:'OTHER'},{outRequestNo:'OTHER'},{code:'40004'}]) {
    assert.equal(refundQueryConfirmed({...valid,...altered},'ORDER','REFUND',40000),false);
  }
});
test('金额解析拒绝精度丢失、负数与超过两位小数',()=>{
  assert.equal(yuanToMinor('0.29'),29);
  for(const value of ['-1','1.001','1e3','9007199254740992']) assert.equal(yuanToMinor(value),undefined);
});
