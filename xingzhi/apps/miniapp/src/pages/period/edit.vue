<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useLoad } from '@tarojs/taro';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import { useOverview } from '@/composables/useOverview';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { dateKey, minorFromYuan, yuanInput } from '@/lib/format';
import type { BudgetPeriod } from '@/lib/types';

const overview=useOverview();
const period=ref<BudgetPeriod|null>(null);
const periodId=ref('');
const accountIndex=ref(0);
const monthStart=ref(`${dateKey(new Date().toISOString()).slice(0,7)}-01`);
const target=ref('500');
const reason=ref('调整本月保留目标');
const loading=ref(true);const saving=ref(false);const error=ref('');
const editing=computed(()=>Boolean(periodId.value));
const accounts=computed(()=>overview.accounts.value.filter(item=>item.account.status==='linked'&&item.account.accountType==='debit'));
const valid=computed(()=>minorFromYuan(target.value)!==null&&(!editing.value||reason.value.trim().length>=2));

useLoad(async(options)=>{
  periodId.value=options.id??'';
  try{
    if(periodId.value){period.value=(await api.period(periodId.value)).data;target.value=yuanInput(period.value.basis.savingsTargetMinor);}
    else {
      await overview.load();
      const preferredId=overview.primaryAccount.value?.account.accountId;
      const preferredIndex=accounts.value.findIndex(item=>item.account.accountId===preferredId);
      if(preferredIndex>=0)accountIndex.value=preferredIndex;
    }
  }catch(reason){error.value=errorMessage(reason);}finally{loading.value=false;}
});

async function submit(){
  const minor=minorFromYuan(target.value);if(minor===null||saving.value)return;
  saving.value=true;error.value='';
  try{
    if(period.value){
      await api.changeSavingsTarget(period.value.period.periodId,{newTargetMinor:minor,expectedPeriodVersion:period.value.period.periodVersion,reason:reason.value.trim(),confirmedByUser:true});
      await Taro.navigateBack();
    }else{
      const account=accounts.value[accountIndex.value];if(!account)throw new Error('当前没有可用于预算的借记账户。');
      const created=(await api.createPeriod({accountId:account.account.accountId,monthStart:monthStart.value,savingsTargetMinor:minor,expectedFinancialVersion:account.account.financialVersion})).data;
      await Taro.redirectTo({url:`/pages/period/detail?id=${created.period.periodId}`});
    }
  }catch(reason){error.value=errorMessage(reason);}finally{saving.value=false;}
}
</script>
<template><PageShell :title="editing?'调整保留目标':'新建本月预算'" subtitle="金额只在确认后写入服务端" compact><template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
  <StatePanel v-if="loading" title="正在读取资金依据"/><template v-else><view v-if="error" class="notice notice--error">{{error}}</view>
  <SectionCard><template v-if="!editing"><label class="field"><text>资金账户</text><picker :range="accounts.map(item=>item.account.displayName)" :value="accountIndex" @change="accountIndex=Number(($event.detail as any).value)"><view class="picker-value">{{accounts[accountIndex]?.account.displayName??'没有可用借记账户'}} ›</view></picker></label><label class="field"><text>预算月份</text><picker mode="date" fields="month" :value="monthStart" @change="monthStart=String(($event.detail as any).value)+'-01'"><view class="picker-value">{{monthStart.slice(0,7)}} ›</view></picker></label></template>
    <label class="field"><text>保留目标（元）</text><input v-model="target" type="digit" placeholder="例如 500"/></label>
    <label v-if="editing" class="field"><text>调整原因</text><textarea v-model="reason" maxlength="200" placeholder="说明为什么调整"/></label>
  </SectionCard><view class="notice notice--warning confirm-note">{{editing?'提交后将按最新资金事实重新计算本月影响。':'新周期先保存为草稿，确认必要支出后才能激活。'}}</view>
  <button class="primary-button submit" :disabled="saving||!valid||(!editing&&!accounts.length)" @tap="submit">{{saving?'正在保存…':editing?'确认调整':'创建草稿预算'}}</button></template>
</PageShell></template>
<style lang="scss">@use '../../styles/tokens' as *;.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.7);border-radius:50%;font-size:44px}.field{display:block}.field+.field{margin-top:26px}.field>text{display:block;margin-bottom:10px;color:$text-secondary;font-size:22px}.field input,.field textarea,.picker-value{width:100%;padding:0 22px;background:$soft-surface;border:1px solid $border;border-radius:16px;font-size:25px}.field input,.picker-value{height:82px;line-height:82px}.field textarea{min-height:130px;padding-block:18px}.confirm-note{margin-top:18px}.submit{width:100%;margin-top:22px}</style>
