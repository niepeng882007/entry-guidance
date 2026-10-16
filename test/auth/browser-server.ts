import { startAuthRuntime } from './runtime.ts';
import { entryTransport } from './entry-fixture.ts';
import { modelTransport } from './model-fixture.ts';
await startAuthRuntime({
  web: 4180,
  business: 4181,
  mail: 4182,
  transport: entryTransport,
  modelTransport,
  simulation: true,
  reviewFixtures: true,
});
