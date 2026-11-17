import { createRequire } from 'node:module';
import type { NextAdapter } from 'next';

const require = createRequire(import.meta.url);
export const loadReferenceAdapter: () => NextAdapter =
  require('./reference-adapter.cjs').loadReferenceAdapter;
