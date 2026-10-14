import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/server.ts';
import { simulatedModel } from '../analysis-fixtures.ts';

// Tests never load .env, credentials or the user's persistent ledger.
const directory = mkdtempSync(join(tmpdir(), 'browser-review-'));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
createServer({
  password: 'browser-test-only',
  mode: 'demo',
  llm: simulatedModel(),
  reviewLedgerPath: join(directory, 'demo.sqlite'),
}).listen(4179, '127.0.0.1');
