// Registers the PNG stub loader (./test-png-stub.mjs) so the brand
// component tests can import modules that bring in .png assets. Passed
// to `node --import` ahead of tsx, so it's active before any test file
// is resolved.
import { register } from 'node:module';

register('./test-png-stub.mjs', import.meta.url);
