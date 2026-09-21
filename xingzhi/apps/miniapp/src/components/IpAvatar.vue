<script setup lang="ts">import ipBoard from '@/assets/xingzhi-ip-board.webp'; withDefaults(defineProps<{ size?:'small'|'medium'|'large' }>(),{size:'medium'});</script>
<template><view class="ip-avatar" :class="`ip-avatar--${size}`"><image class="ip-avatar__board" :src="ipBoard" mode="scaleToFill" /></view></template>
<style lang="scss">
.ip-avatar { position:relative; flex:0 0 auto; overflow:hidden; border-radius:50%; background:#E8F0EC; }
.ip-avatar--small { width:72px; height:72px; }.ip-avatar--medium { width:100px; height:100px; }.ip-avatar--large { width:160px; height:160px; }
.ip-avatar__board { position:absolute; width:285%; height:285%; max-width:none; left:-94%; top:-1%; }
</style>
