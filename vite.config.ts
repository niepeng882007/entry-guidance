import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { h } from 'vue';
import {
  Button,
  ConfigProvider,
  DatePicker,
  Empty,
  Pagination,
  Select,
  Spin,
  Table,
  Tag,
} from 'ant-design-vue';
import { extractStyle } from 'ant-design-vue/lib/_util/static-style-extract/index.js';
import { reviewTheme } from './frontend/review-theme.ts';

const directory = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  root: directory('./frontend'),
  publicDir: false,
  plugins: [
    vue(),
    {
      name: 'review-antd-css',
      resolveId: (id) => (id === 'virtual:review-antd.css' ? '\0review-antd.css' : undefined),
      load(id) {
        if (id !== '\0review-antd.css') return;
        // The extracted cache map prevents runtime style injection under the production CSP.
        return extractStyle(() =>
          h(
            ConfigProvider,
            { theme: reviewTheme },
            {
              default: () => [
                h(Button),
                h(DatePicker),
                h(Empty),
                h(Pagination),
                h(Select),
                h(Spin),
                h(Table),
                h(Tag),
              ],
            },
          ),
        );
      },
    },
  ],
  appType: 'custom',
  server: {
    host: '127.0.0.1',
    fs: { allow: [directory('./frontend'), directory('./public'), directory('./node_modules')] },
  },
  build: { outDir: directory('./dist'), emptyOutDir: true, target: 'es2023' },
});
