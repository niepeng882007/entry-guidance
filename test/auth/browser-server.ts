import { startAuthRuntime } from './runtime.ts';
import { assetsTransport } from './assets-fixture.ts';
await startAuthRuntime({
  web: 4180,
  business: 4181,
  mail: 4182,
  transport: assetsTransport,
  simulation: true,
});
