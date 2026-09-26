<script setup lang="ts">
import Taro, { useDidShow } from '@tarojs/taro';
import FactRow from '@/components/FactRow.vue';
import IpAvatar from '@/components/IpAvatar.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useOverview } from '@/composables/useOverview';

const overview = useOverview();
useDidShow(() => void overview.load());
</script>

<template>
  <PageShell title="个人资料" subtitle="当前登录身份与数据范围" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="overview.loading.value" title="正在读取个人资料" />
    <StatePanel v-else-if="overview.error.value" title="个人资料暂时不可用" :detail="overview.error.value" tone="error"><button class="secondary-button retry" @tap="overview.load">重新加载</button></StatePanel>
    <template v-else-if="overview.user.value">
      <SectionCard class="identity"><IpAvatar size="large"/><text class="name">{{ overview.user.value.displayName }}</text><StatusBadge label="行止消费者" tone="info"/></SectionCard>
      <SectionCard class="details">
        <FactRow label="登录邮箱" :value="overview.user.value.email" />
        <FactRow label="账户数量" :value="`${overview.accounts.value.length} 个`" />
        <FactRow label="预算周期" :value="`${overview.periods.value.length} 个`" />
        <FactRow label="当前身份" value="行止消费者" />
      </SectionCard>
      <view class="notice notice--info note">姓名和邮箱来自当前登录账户。为避免身份信息与业务记录不一致，本版本暂不支持在前端直接修改。</view>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.78);border-radius:50%;font-size:44px}.retry{margin-top:24px}.identity{display:flex;flex-direction:column;align-items:center;gap:20px;padding-top:40px;padding-bottom:40px;text-align:center;background:linear-gradient(145deg,$surface-tint,#fff)}.identity :deep(.ip-avatar--large){width:144px;height:144px}.name{font-size:40px;font-weight:760;line-height:1.25}.details,.note{margin-top:24px}.note{padding:28px 30px;font-size:28px;line-height:1.65}
</style>
