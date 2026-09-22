import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const directory = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  root: directory('./frontend'),
  publicDir: false,
  plugins: [vue()],
  appType: 'custom',
  server: {
    host: '127.0.0.1',
    fs: { allow: [directory('./frontend'), directory('./public'), directory('./node_modules')] },
  },
  build: { outDir: directory('./dist'), emptyOutDir: true, target: 'es2023' },
});
