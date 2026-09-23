import { computed, ref } from 'vue';
import { api, ApiError, goLogin } from '@/lib/api';
import { dateKey } from '@/lib/format';
import { errorMessage } from '@/lib/errors';
import type { BudgetPeriod, ConsumerPreferences, FinanceAccountFacts, User } from '@/lib/types';

export function useOverview() {
  let loadSequence = 0;
  const loading = ref(true);
  const currentMonth = ref(dateKey(new Date().toISOString()).slice(0, 7));
  const error = ref('');
  const user = ref<User | null>(null);
  const accounts = ref<FinanceAccountFacts[]>([]);
  const periods = ref<BudgetPeriod[]>([]);
  const preferences = ref<ConsumerPreferences | null>(null);
  const primaryAccount = computed(() => accounts.value.find(item => item.account.accountId === preferences.value?.defaultAccountId && item.account.accountType === 'debit' && item.account.status === 'linked')
    ?? accounts.value.find(item => item.account.accountType === 'debit' && item.account.status === 'linked') ?? null);
  const currentPeriod = computed(() => periods.value.find(item =>
    item.period.accountId === primaryAccount.value?.account.accountId
    && item.period.monthStart === `${currentMonth.value}-01`) ?? null);

  async function load() {
    const sequence = ++loadSequence;
    currentMonth.value = dateKey(new Date().toISOString()).slice(0, 7);
    loading.value = true; error.value = '';
    try {
      const [session, accountResult, periodResult, preferenceResult] = await Promise.all([api.session(), api.accounts(), api.periods(), api.preferences()]);
      if (sequence !== loadSequence) return;
      user.value = session.user;
      if (session.user.role !== 'consumer') { error.value = '当前账号不是消费者账号。'; return; }
      accounts.value = accountResult.data.accounts;
      periods.value = periodResult.data.periods;
      preferences.value = preferenceResult.data;
    } catch (reason) {
      if (sequence !== loadSequence) return;
      if (reason instanceof ApiError && reason.status === 401) return goLogin();
      error.value = errorMessage(reason);
    } finally { if (sequence === loadSequence) loading.value = false; }
  }
  return { loading, error, user, accounts, periods, preferences, primaryAccount, currentPeriod, currentMonth, load };
}
