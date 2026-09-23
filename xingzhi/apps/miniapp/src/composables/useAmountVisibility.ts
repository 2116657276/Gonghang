import { ref } from 'vue';

// 首页和“我的”共用同一会话内的金额显示选择。
const balanceVisible = ref(true);

export function useAmountVisibility() {
  return {
    balanceVisible,
    toggleBalanceVisibility: () => { balanceVisible.value = !balanceVisible.value; },
    resetBalanceVisibility: () => { balanceVisible.value = true; },
  };
}
