import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import hooks from 'eslint-plugin-react-hooks';
import next from '@next/eslint-plugin-next';

export default ts.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.pnpm-store/**',
      'test-results/**',
      'web/.next/**',
      'web/next-env.d.ts',
      'src/generated/**',
      'playwright-report/**',
      '.local/**',
      '.husky/_/**',
      '.scratch/**',
      '.agents/skills/**',
      'docs/archive/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    // Rest siblings deliberately omit private or unnecessary fields from the returned object.
    rules: { '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }] },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ignores: ['public/**'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['public/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.{ts,tsx,vue}', 'public/*.js'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.frontend.json', './web/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: ts.parser } },
    // TypeScript checks unknown names, including browser globals, inside SFC scripts.
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks, '@next/next': next },
    settings: { next: { rootDir: 'web/' } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      ...next.configs.recommended.rules,
      ...next.configs['core-web-vitals'].rules,
    },
  },
);
