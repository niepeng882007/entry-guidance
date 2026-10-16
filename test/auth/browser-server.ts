import { startAuthRuntime } from './runtime.ts';
import { bindingTransport } from './binding-fixture.ts';
await startAuthRuntime({ web: 4180, business: 4181, transport: bindingTransport });
