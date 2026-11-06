import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { defaultConfig } = require('next/dist/server/config-shared');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(['config', 'complete'])(
  'prefetches only production builds, respecting the %s stage control',
  async (stage) => {
    const binary = `/repo/prefetch-${stage}`;
    vi.stubEnv('NEXT_ADAPTER_GO_BINARY', binary);
    vi.stubEnv('NEXT_ADAPTER_GO_PREFETCH', '1');
    vi.stubEnv('NEXT_ADAPTER_GO_PREFETCH_STAGE', stage);
    vi.stubEnv('NEXT_NATIVE_BUILD_TIMINGS', '0');
    const read = vi
      .spyOn(fs, 'readFile')
      .mockResolvedValue(Buffer.from('binary'));
    const entry = require.resolve('../dist/native-adapter.js');
    delete require.cache[entry];
    const adapter = require(entry);
    const config = () => ({
      ...defaultConfig,
      experimental: { ...defaultConfig.experimental },
    });
    await adapter.modifyConfig(config(), { phase: 'phase-development-server' });
    expect(read).not.toHaveBeenCalled();
    await adapter.modifyConfig(config(), { phase: 'phase-production-build' });
    await adapter.modifyConfig(config(), { phase: 'phase-production-build' });
    expect(read).toHaveBeenCalledTimes(stage === 'config' ? 1 : 0);
    if (stage === 'config') expect(read).toHaveBeenCalledWith(binary);
  }
);
