import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const config: NextConfig = {
  poweredByHeader: false,
  typescript: { tsconfigPath: 'tsconfig.json' },
  turbopack: { root: resolve(import.meta.dirname, '..') },
  outputFileTracingRoot: resolve(import.meta.dirname, '..'),
};
export default config;
