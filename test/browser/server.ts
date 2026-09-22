import { createServer } from '../../src/server.ts';

// Tests never load .env or Binance credentials.
createServer({ password: 'browser-test-only', mode: 'demo' }).listen(4179, '127.0.0.1');
