<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import EntryWorkbench from './EntryWorkbench.vue';
import AccountPage from './AccountPage.vue';
import ReviewPage from './ReviewPage.vue';
import HomePage from './HomePage.vue';
import SideNavigation from './components/SideNavigation.vue';
import type { AppPage } from './navigation';

defineProps<{
  page: AppPage;
  source: string;
  expectedSource: 'binance' | 'demo';
}>();
const menu = ref<HTMLDialogElement | null>(null);
const menuButton = ref<HTMLButtonElement | null>(null);
const menuOpen = ref(false);
const desktop = window.matchMedia('(min-width: 961px)');

function openMenu() {
  menu.value?.showModal();
  menuOpen.value = true;
}
function closeMenu() {
  menuOpen.value = false;
  menu.value?.close();
}
function menuClosed() {
  menuOpen.value = false;
  if (!desktop.matches) menuButton.value?.focus();
}
function cycleFocus(event: KeyboardEvent) {
  const controls = menu.value?.querySelectorAll<HTMLElement>('button, a');
  if (!controls?.length) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
function breakpointChanged() {
  if (desktop.matches) closeMenu();
}
onMounted(() => desktop.addEventListener('change', breakpointChanged));
onUnmounted(() => desktop.removeEventListener('change', breakpointChanged));
</script>

<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <div class="workspace">
    <aside class="workspace__sidebar"><SideNavigation :current="page" /></aside>
    <div class="workspace__main">
      <header class="workspace__header">
        <button
          ref="menuButton"
          class="button button--secondary workspace__menu"
          type="button"
          aria-controls="app-menu"
          :aria-expanded="menuOpen"
          @click="openMenu"
        >
          菜单
        </button>
        <p class="workspace__context">个人工作台</p>
        <form action="/logout" method="post">
          <button class="button button--text" type="submit">退出登录</button>
        </form>
      </header>
      <main id="main-content" class="workspace__content" tabindex="-1">
        <HomePage v-if="page === 'home'" :source="source" />
        <EntryWorkbench v-else-if="page === 'entry'" :source="source" />
        <ReviewPage
          v-else-if="page === 'review'"
          :source="source"
          :expected-source="expectedSource"
        />
        <AccountPage v-else :source="source" :expected-source="expectedSource" />
      </main>
    </div>
  </div>
  <dialog
    id="app-menu"
    ref="menu"
    class="app-menu"
    aria-label="功能菜单"
    @close="menuClosed"
    @keydown.tab="cycleFocus"
    @click="$event.target === menu && closeMenu()"
  >
    <button class="button button--text app-menu__close" type="button" @click="closeMenu">
      关闭菜单
    </button>
    <SideNavigation :current="page" @navigate="closeMenu" />
  </dialog>
</template>
