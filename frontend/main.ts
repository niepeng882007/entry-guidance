import { createApp } from 'vue';
import Workbench from './EntryWorkbench.vue';
import AccountPage from './AccountPage.vue';
import '../public/style.css';

const root = document.getElementById('app');
if (!root) throw new Error('页面入口缺失');
if (root.dataset.page === 'account') {
  createApp(AccountPage, {
    source: root.dataset.source ?? '',
    expectedSource: root.dataset.mode === 'demo' ? 'demo' : 'binance',
  }).mount(root);
} else {
  createApp(Workbench, { source: root.dataset.source ?? '' }).mount(root);
}
