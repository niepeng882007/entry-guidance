import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const output = new URL('../web/generated/public-security.json', import.meta.url);
await mkdir(new URL('../web/generated/', import.meta.url), { recursive: true });
if (process.argv.includes('--prepare')) {
  await writeFile(output, JSON.stringify({ scripts: [], styles: [] }));
} else {
  const html = await readFile(
    new URL('../web/.next/server/app/index.html', import.meta.url),
    'utf8',
  );
  const hash = (value: string) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((match) => !/\bsrc=/.test(match[1]!))
    .map((match) => hash(match[2]!));
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) =>
    hash(match[1]!),
  );
  if (!scripts.length) throw new Error('官网静态 HTML 未生成脚本 hash。');
  await writeFile(
    output,
    JSON.stringify({ scripts: [...new Set(scripts)], styles: [...new Set(styles)] }),
  );
}
