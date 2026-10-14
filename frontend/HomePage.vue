<script setup lang="ts">
import { navigation } from './navigation';
defineProps<{ source: string }>();
const descriptions = {
  entry: '确定本单预算与绝对止损，生成开仓方案；执行后返回核验。',
  review: '查看归档交易、盈亏和逐笔成交，展开订单与资金费证据。',
  account: '查看账户权益、可用余额、当前持仓和活跃委托。',
};
const features = navigation.filter((page) => page.id !== 'home');
</script>

<template>
  <div class="home-page">
    <header class="home-page__heading">
      <h1 class="page-title">首页</h1>
      <p class="workspace__intro">规划开仓、复盘交易，或查看账户状况。</p>
    </header>
    <p class="source">{{ source }}</p>
    <nav class="home-page__features" aria-label="功能入口">
      <a
        v-for="feature in features"
        :key="feature.id"
        class="home-page__feature"
        :href="feature.href"
        :aria-labelledby="`home-${feature.id}`"
      >
        <div>
          <h2 :id="`home-${feature.id}`" class="module-title">{{ feature.title }}</h2>
          <p class="home-page__description">{{ descriptions[feature.id] }}</p>
        </div>
        <span class="home-page__arrow" aria-hidden="true">→</span>
      </a>
    </nav>
    <p class="footnote home-page__note">
      交易由你在 Binance 执行。账户快照只代表查询时点，开仓卡需重新查询后核验。
    </p>
  </div>
</template>
