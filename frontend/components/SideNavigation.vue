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
  </nav>
</template>
