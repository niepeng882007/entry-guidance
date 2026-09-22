<script setup lang="ts">
import { onMounted, onUpdated, onUnmounted, ref } from 'vue';
import { enhanceSelects } from '../../public/select.js';

const root = ref<HTMLElement>();
const events = new AbortController();
let sync = () => {};
onMounted(() => {
  if (root.value) sync = enhanceSelects(root.value, events.signal);
});
onUpdated(() => sync());
onUnmounted(() => events.abort());
</script>

<template>
  <div ref="root"><slot /></div>
</template>
