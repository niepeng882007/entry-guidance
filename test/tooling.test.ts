import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

void test(
  'code quality gates protect staged changes and reject correctness errors',
  { timeout: 120_000 },
  async (t) => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), 'entry-tooling-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      HUSKY: '1',
      CI: 'true',
      pnpm_config_verify_deps_before_run: 'false',
    };
    function run(command: string, args: string[]) {
      return spawnSync(command, args, { cwd: directory, env, encoding: 'utf8', timeout: 60_000 });
    }
    function success(command: string, args: string[]) {
      const result = run(command, args);
      assert.equal(
        result.status,
        0,
        `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
      );
      return result.stdout;
    }
    const git = (...args: string[]) => success('git', args);
    for (const path of ['.husky', 'src', 'web/app', 'public'])
      mkdirSync(join(directory, path), { recursive: true });
    for (const path of [
      'package.json',
      '.gitignore',
      '.prettierrc.json',
      '.prettierignore',
      'eslint.config.js',
      'lint-staged.config.js',
      'tsconfig.json',
      'tsconfig.frontend.json',
      'web/tsconfig.json',
      '.husky/pre-commit',
    ]) {
      copyFileSync(join(root, path), join(directory, path));
    }
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const path = 'src/file with spaces.ts';
    const baseline = 'export const selected = 1;\nexport const local = 1;\n';
    const write = (content: string) => writeFileSync(join(directory, path), content);
    write(baseline);
    git('init', '-q', '--initial-branch=main');
    git('config', 'user.name', 'Tooling Test');
    git('config', 'user.email', 'tooling@example.test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', '.git/hooks');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    success(process.execPath, [join(root, 'node_modules/husky/bin.js')]);
    assert.equal(git('config', 'core.hooksPath').trim(), '.husky/_');

    await t.test('the real commit hook formats staged content and preserves unstaged edits', () => {
      const staged = 'export const selected={value:2};\nexport const local = 1;\n';
      write(staged);
      git('add', path);
      write(staged.replace('local = 1', 'local = 2'));
      git('commit', '-qm', 'formatted change');
      const committed = git('show', `HEAD:${path}`);
      assert.match(committed, /selected = \{ value: 2 \};/);
      assert.match(committed, /local = 1/);
      assert.match(readFileSync(join(directory, path), 'utf8'), /local = 2/);
      assert.equal(git('diff', '--cached'), '');
      success('pnpm', ['exec', 'prettier', '--check', path]);
    });

    await t.test('lint errors abort commits and restore both staged and unstaged content', () => {
      const staged = `${baseline}if (!!selected) console.log(selected);\nexport const rejected: any = 1;\n`;
      write(staged);
      git('add', path);
      const working = staged.replace('local = 1', 'local = 3');
      write(working);
      const head = git('rev-parse', 'HEAD');
      const index = git('diff', '--cached');
      const result = run('git', ['commit', '-qm', 'must fail']);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /no-explicit-any/);
      assert.equal(git('rev-parse', 'HEAD'), head);
      assert.equal(git('diff', '--cached'), index);
      assert.equal(readFileSync(join(directory, path), 'utf8'), working);
      assert.equal(git('stash', 'list'), '');
    });

    await t.test('warnings also block commits', () => {
      write(`/* eslint no-console: warn */\n${baseline}console.log(selected);\n`);
      git('add', path);
      const head = git('rev-parse', 'HEAD');
      const result = run('git', ['commit', '-qm', 'warning must fail']);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /too many warnings/);
      assert.equal(git('rev-parse', 'HEAD'), head);
    });

    await t.test('typed Promise and framework rules detect invalid source files', () => {
      const cases = [
        ['src/promise.ts', 'Promise.resolve(1);\n', 'no-floating-promises'],
        [
          'src/callback.ts',
          'setTimeout(async () => { await Promise.resolve(); }, 1);\n',
          'no-misused-promises',
        ],
        [
          'web/app/hooks.tsx',
          "import { useState } from 'react';\nexport default function Example({ enabled }: { enabled: boolean }) { if (enabled) { useState(0); } return null; }\n",
          'react-hooks/rules-of-hooks',
        ],
        ['public/globals.js', 'missingBrowserGlobal();\n', 'no-undef'],
        ['public/server-only.js', 'process.exit(0);\n', 'no-undef'],
      ] as const;
      for (const [file, content, rule] of cases) {
        writeFileSync(join(directory, file), content);
        const result = run('pnpm', ['exec', 'eslint', '--max-warnings=0', file]);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + result.stderr, new RegExp(rule));
      }
      writeFileSync(join(directory, 'public/valid.js'), "document.title = 'fixture';\n");
      success('pnpm', ['exec', 'eslint', '--max-warnings=0', 'public/valid.js']);
    });
  },
);
