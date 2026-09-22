import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refundQueryConfirmed, yuanToMinor } from './alipay-sandbox.js';
import { config } from '../config.js';
import { AppError } from '../domain/errors.js';
import { createAlipayHandoff, sandboxReadiness } from './alipay-sandbox.js';

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

test('沙箱配置未就绪或网关不在白名单时，不创建付款交接',()=>{
  const previousMode=config.paymentMode;
  const previous={...config.alipaySandbox};
  try {
    config.paymentMode='sandbox';
    Object.assign(config.alipaySandbox,{appId:undefined,privateKey:undefined,publicKey:undefined,
      sellerId:undefined,gateway:undefined,returnUrl:undefined});
    const missing=sandboxReadiness();
    assert.equal(missing.ready,false);
    assert.deepEqual(missing.missing.sort(),[
      'ALIPAY_SANDBOX_APP_ID','ALIPAY_SANDBOX_GATEWAY','ALIPAY_SANDBOX_PRIVATE_KEY',
      'ALIPAY_SANDBOX_PUBLIC_KEY','ALIPAY_SANDBOX_RETURN_URL','ALIPAY_SANDBOX_SELLER_ID',
    ]);
    assert.throws(()=>createAlipayHandoff({businessNumber:'ORDER',amountMinor:100,subject:'测试'}),
      (error:unknown)=>error instanceof AppError && error.code==='PAYMENT_SANDBOX_NOT_READY');

    Object.assign(config.alipaySandbox,{appId:'app',privateKey:'private',publicKey:'public',sellerId:'seller',
      gateway:'https://example.invalid/gateway.do',returnUrl:'http://localhost:5173/payment-return'});
    assert.equal(sandboxReadiness().ready,true);
    assert.throws(()=>createAlipayHandoff({businessNumber:'ORDER',amountMinor:100,subject:'测试'}),
      (error:unknown)=>error instanceof AppError && error.code==='PAYMENT_GATEWAY_REJECTED');
  } finally {
    config.paymentMode=previousMode;
    Object.assign(config.alipaySandbox,previous);
  }
});
