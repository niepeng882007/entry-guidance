import { createApp } from 'vue';
import AppShell from './AppShell.vue';
import { navigation } from './navigation';
import '../public/style.css';

const root = document.getElementById('app');
if (!root) throw new Error('页面入口缺失');
const page = navigation.find((page) => page.id === root.dataset.page)?.id;
if (!page) throw new Error('页面类型无效');
createApp(AppShell, {
  page,
  source: root.dataset.source ?? '',
  expectedSource: root.dataset.mode === 'demo' ? 'demo' : 'binance',
}).mount(root);
