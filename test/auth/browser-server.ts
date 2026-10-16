import { startAuthRuntime } from './runtime.ts';
import { modelTransport } from './model-fixture.ts';
import { entryScenarios } from './entry-fixture.ts';
const entry = entryScenarios();
await startAuthRuntime({
  web: 4180,
  business: 4181,
  mail: 4182,
  transport: entry.transport,
  entryScenario: entry.select,
  modelTransport,
  simulation: true,
  reviewFixtures: true,
});
