<script setup lang="ts">
import { navigation, type AppPage } from '../navigation';
defineProps<{ current: AppPage }>();
const emit = defineEmits<{ navigate: [] }>();
</script>

<template>
  <nav class="app-nav" aria-label="主导航">
    <a class="app-nav__brand" href="/" @click="emit('navigate')">
      开仓前<span class="app-nav__caption">ENTRY GUIDANCE</span>
    </a>
    <div class="app-nav__links">
      <a
        v-for="page in navigation"
        :key="page.id"
        class="app-nav__link"
        :href="page.href"
        @click="emit('navigate')"
        :aria-current="page.id === current ? 'page' : undefined"
        >{{ page.title }}</a
      >
    </div>
    <p class="app-nav__note">只读接入<br />交易由你在 Binance 执行</p>
  </nav>
</template>
