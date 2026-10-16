import { startAuthRuntime } from './runtime.ts';
import { assetsTransport } from './assets-fixture.ts';
import { modelTransport } from './model-fixture.ts';
await startAuthRuntime({
  web: 4180,
  business: 4181,
  mail: 4182,
  transport: assetsTransport,
  modelTransport,
  simulation: true,
  reviewFixtures: true,
});
