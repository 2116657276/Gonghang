<template><view class="section-card"><slot /></view></template>
<style lang="scss">
@use '../styles/tokens' as *;
.section-card { padding:32px; background:$card; border:1px solid $border; border-radius:$radius-card; }
@media screen and (max-width:360px){.section-card{padding:28px}}
</style>
