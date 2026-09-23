import Taro from '@tarojs/taro';

export type AiEntry = { periodId: string; itemId?: string; on?: string; ledgerMonth?: string; question: string };
const key = 'xingzhi_ai_pending_question';

export function openAiWithQuestion(entry: AiEntry) {
  Taro.setStorageSync(key, { ...entry, createdAt: Date.now() });
  return Taro.switchTab({ url: '/pages/ai/index' });
}

export function takeAiQuestion(): AiEntry | null {
  const value = Taro.getStorageSync(key) as (AiEntry & { createdAt: number }) | undefined;
  Taro.removeStorageSync(key);
  return value?.periodId && value.question && Date.now() - value.createdAt < 10 * 60_000 ? value : null;
}

export function clearAiQuestion() { Taro.removeStorageSync(key); }
