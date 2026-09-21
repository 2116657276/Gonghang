<template><view class="section-card"><slot /></view></template>
<style lang="scss">
@use '../styles/tokens' as *;
.section-card { padding: 28px; background: $card; border: 1px solid rgba(216,226,220,.82); border-radius: 20px; box-shadow: $shadow-card; }
@media screen and (max-width:360px){.section-card{padding:22px;border-radius:18px}}
</style>
