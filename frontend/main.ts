import { createApp } from 'vue';
import Workbench from './EntryWorkbench.vue';
import '../public/style.css';

const root = document.getElementById('app');
if (!root) throw new Error('页面入口缺失');
createApp(Workbench, { source: root.dataset.source ?? '' }).mount(root);
