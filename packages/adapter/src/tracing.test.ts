import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import adapter from './index';
import { defaultTracingWasInjected, injectDefaultTracing } from './tracing';

const INJECT_ENTRY = './.vercel/otel/node_modules/instrumentation.mjs';

type TracingConfig = {
  pageExtensions: string[];
  outputFileTracingRoot?: string;
  instrumentationInject?: string[];
};

describe('injectDefaultTracing', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  async function writePackage(
    dir: string,
    name: string,
    version: string
  ): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version, main: 'index.js' })
    );
    await fs.writeFile(path.join(dir, 'index.js'), 'module.exports = {}\n');
  }

  function otelRoot(projectDir: string): string {
    return path.join(projectDir, '.vercel', 'otel');
  }

  // Lays out .vercel/otel/ the way the Vercel builder prepares it before
  // `next build`.
  async function prepareTree(projectDir: string): Promise<void> {
    const modules = path.join(otelRoot(projectDir), 'node_modules');
    await writePackage(
      path.join(modules, '@vercel', 'otel'),
      '@vercel/otel',
      '2.2.0'
    );
    await writePackage(
      path.join(modules, '@opentelemetry', 'api-logs'),
      '@opentelemetry/api-logs',
      '0.218.0'
    );
    await writePackage(
      path.join(modules, '@opentelemetry', 'api'),
      '@opentelemetry/api',
      '1.9.0'
    );
    await fs.writeFile(
      path.join(modules, 'instrumentation.mjs'),
      'export async function register() {}\n'
    );
  }

  async function readyProject(): Promise<string> {
    const projectDir = await tempDir('adapter-tracing-app-');
    await writePackage(
      path.join(projectDir, 'node_modules', '@opentelemetry', 'api'),
      '@opentelemetry/api',
      '1.9.0'
    );
    await prepareTree(projectDir);
    return projectDir;
  }

  // pnpm's isolated layout: `next` is a symlink into node_modules/.pnpm, and a
  // dependency's @opentelemetry/api is hoisted to node_modules/.pnpm/node_modules,
  // which Next.js can resolve but the project root can't.
  async function hiddenOtelApi(
    projectDir: string,
    version: string
  ): Promise<void> {
    const modules = path.join(projectDir, 'node_modules');
    await fs.rm(path.join(modules, '@opentelemetry'), {
      recursive: true,
      force: true,
    });
    const nextReal = path.join(
      modules,
      '.pnpm',
      'next@16.5.0',
      'node_modules',
      'next'
    );
    await writePackage(nextReal, 'next', '16.5.0');
    await fs.symlink(nextReal, path.join(modules, 'next'));
    await writePackage(
      path.join(modules, '.pnpm', 'node_modules', '@opentelemetry', 'api'),
      '@opentelemetry/api',
      version
    );
  }

  function config(): TracingConfig {
    return { pageExtensions: ['ts', 'tsx', 'js', 'jsx'] };
  }

  async function inject(
    projectDir: string,
    tracingConfig: TracingConfig = config()
  ): Promise<TracingConfig> {
    tracingConfig.outputFileTracingRoot ??= projectDir;
    await injectDefaultTracing(
      tracingConfig as Required<Pick<TracingConfig, 'outputFileTracingRoot'>> &
        TracingConfig,
      projectDir
    );
    return tracingConfig;
  }

  // Runs the adapter's real modifyConfig, which decides whether to inject.
  async function modifyConfig(
    projectDir: string,
    enabled: string | undefined,
    phase: string = PHASE_PRODUCTION_BUILD
  ): Promise<TracingConfig> {
    vi.stubEnv('VERCEL_DEFAULT_TRACING_ENABLED', enabled);
    const nextConfig = {
      ...config(),
      outputFileTracingRoot: projectDir,
      experimental: {},
    };
    await adapter.modifyConfig?.(
      nextConfig as unknown as Parameters<
        NonNullable<typeof adapter.modifyConfig>
      >[0],
      { phase, projectDir, nextVersion: '16.5.0' }
    );
    return nextConfig;
  }

  it('injects the prepared wrapper once', async () => {
    const projectDir = await readyProject();

    const tracingConfig = await inject(projectDir);

    expect(tracingConfig.instrumentationInject).toEqual([INJECT_ENTRY]);
  });

  it('does not change the prepared tree', async () => {
    const projectDir = await readyProject();
    const modules = path.join(otelRoot(projectDir), 'node_modules');
    const wrapper = path.join(modules, 'instrumentation.mjs');
    const before = await fs.readFile(wrapper, 'utf8');

    await inject(projectDir);

    expect(await fs.readFile(wrapper, 'utf8')).toBe(before);
    expect(await fs.readdir(otelRoot(projectDir))).toEqual(['node_modules']);
    expect((await fs.readdir(modules)).sort()).toEqual([
      '@opentelemetry',
      '@vercel',
      'instrumentation.mjs',
    ]);
  });

  it('does not inject when the builder did not prepare .vercel/otel', async () => {
    const projectDir = await readyProject();
    await fs.rm(otelRoot(projectDir), { recursive: true });

    const tracingConfig = await inject(projectDir);

    expect(tracingConfig.instrumentationInject).toBeUndefined();
  });

  it.each(['@vercel/otel', '@opentelemetry/api-logs', '@opentelemetry/api'])(
    'does not inject when .vercel/otel is missing %s',
    async (name) => {
      const projectDir = await readyProject();
      await fs.rm(path.join(otelRoot(projectDir), 'node_modules', name), {
        recursive: true,
      });

      const tracingConfig = await inject(projectDir);

      expect(tracingConfig.instrumentationInject).toBeUndefined();
    }
  );

  it('does not inject when the project has an instrumentation file', async () => {
    const projectDir = await readyProject();
    await fs.writeFile(
      path.join(projectDir, 'instrumentation.ts'),
      'export function register() {}\n'
    );

    const tracingConfig = await inject(projectDir);

    expect(tracingConfig.instrumentationInject).toBeUndefined();
  });

  it('does not inject when a parent folder inside the tracing root has an instrumentation file', async () => {
    const root = await tempDir('adapter-tracing-root-');
    const app = path.join(root, 'apps', 'web');
    await prepareTree(app);
    await fs.writeFile(
      path.join(root, 'instrumentation.ts'),
      'export function register() {}\n'
    );

    const tracingConfig = await inject(app, {
      ...config(),
      outputFileTracingRoot: root,
    });

    expect(tracingConfig.instrumentationInject).toBeUndefined();
  });

  it('ignores an instrumentation file above the tracing root', async () => {
    const root = await tempDir('adapter-tracing-root-');
    const app = path.join(root, 'apps', 'web');
    await prepareTree(app);
    await fs.writeFile(
      path.join(root, 'instrumentation.ts'),
      'export function register() {}\n'
    );

    const tracingConfig = await inject(app, {
      ...config(),
      outputFileTracingRoot: app,
    });

    expect(tracingConfig.instrumentationInject).toEqual([INJECT_ENTRY]);
  });

  it('does not inject when src/ has an instrumentation file', async () => {
    const projectDir = await readyProject();
    await fs.mkdir(path.join(projectDir, 'src'));
    await fs.writeFile(
      path.join(projectDir, 'src', 'instrumentation.js'),
      'export function register() {}\n'
    );

    const tracingConfig = await inject(projectDir);

    expect(tracingConfig.instrumentationInject).toBeUndefined();
  });

  it('injects through modifyConfig when default tracing is enabled', async () => {
    const projectDir = await readyProject();

    const tracingConfig = await modifyConfig(projectDir, '1');

    expect(tracingConfig.instrumentationInject).toEqual([INJECT_ENTRY]);
  });

  it.each([
    ['unset', undefined],
    ['0', '0'],
    ['true', 'true'],
  ])('does not inject when default tracing is %s', async (_label, enabled) => {
    const projectDir = await readyProject();

    const tracingConfig = await modifyConfig(projectDir, enabled);

    expect(tracingConfig.instrumentationInject).toBeUndefined();
  });

  it('does not inject outside the production build', async () => {
    const projectDir = await readyProject();

    const tracingConfig = await modifyConfig(
      projectDir,
      '1',
      'phase-development-server'
    );

    expect(tracingConfig.instrumentationInject).toBeUndefined();
  });

  it('injects when the app has no @opentelemetry/api', async () => {
    const projectDir = await readyProject();
    await fs.rm(path.join(projectDir, 'node_modules', '@opentelemetry'), {
      recursive: true,
    });

    const tracingConfig = await inject(projectDir);

    expect(tracingConfig.instrumentationInject).toEqual([INJECT_ENTRY]);
  });

  it.each(['1.10.0', '2.0.0', '1.9.0-rc.0'])(
    'does not inject when @opentelemetry/api is %s',
    async (version) => {
      const projectDir = await readyProject();
      await writePackage(
        path.join(projectDir, 'node_modules', '@opentelemetry', 'api'),
        '@opentelemetry/api',
        version
      );

      const tracingConfig = await inject(projectDir);

      expect(tracingConfig.instrumentationInject).toBeUndefined();
    }
  );

  it.each(['1.4.1', '1.6.0', '1.9.1'])(
    'injects when @opentelemetry/api is %s',
    async (version) => {
      const projectDir = await readyProject();
      await writePackage(
        path.join(projectDir, 'node_modules', '@opentelemetry', 'api'),
        '@opentelemetry/api',
        version
      );

      const tracingConfig = await inject(projectDir);

      expect(tracingConfig.instrumentationInject).toEqual([INJECT_ENTRY]);
    }
  );

  it('does not inject when only Next.js resolves @opentelemetry/api 1.10.0', async () => {
    const projectDir = await readyProject();
    await hiddenOtelApi(projectDir, '1.10.0');

    const tracingConfig = await inject(projectDir);

    expect(tracingConfig.instrumentationInject).toBeUndefined();
  });

  it('injects when only Next.js resolves @opentelemetry/api 1.9.0', async () => {
    const projectDir = await readyProject();
    await hiddenOtelApi(projectDir, '1.9.0');

    const tracingConfig = await inject(projectDir);

    expect(tracingConfig.instrumentationInject).toEqual([INJECT_ENTRY]);
  });

  it('does not inject when instrumentationInject already has other entries', async () => {
    const projectDir = await readyProject();
    const tracingConfig = config();
    tracingConfig.instrumentationInject = ['./custom.js'];

    await inject(projectDir, tracingConfig);

    expect(tracingConfig.instrumentationInject).toEqual(['./custom.js']);
  });

  it('injects once when the entry is already there', async () => {
    const projectDir = await readyProject();
    const tracingConfig = config();
    tracingConfig.instrumentationInject = [INJECT_ENTRY];

    await inject(projectDir, tracingConfig);

    expect(tracingConfig.instrumentationInject).toEqual([INJECT_ENTRY]);
  });

  it('does not add a second entry when called again', async () => {
    const projectDir = await readyProject();
    const tracingConfig = await inject(projectDir);
    await inject(projectDir, tracingConfig);

    expect(tracingConfig.instrumentationInject).toEqual([INJECT_ENTRY]);
  });

  it('does not log a skip unless builder debug is on', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const projectDir = await readyProject();
      await fs.writeFile(
        path.join(projectDir, 'instrumentation.ts'),
        'export function register() {}\n'
      );

      vi.stubEnv('VERCEL_BUILDER_DEBUG', undefined);
      await inject(projectDir);
      expect([...log.mock.calls, ...info.mock.calls].flat()).not.toContain(
        'Skipping Vercel tracing inject: project has an instrumentation file'
      );

      vi.stubEnv('VERCEL_BUILDER_DEBUG', '1');
      await inject(projectDir);
      expect(log).toHaveBeenCalledWith(
        'Skipping Vercel tracing inject: project has an instrumentation file'
      );
    } finally {
      log.mockRestore();
      info.mockRestore();
    }
  });
});

describe('defaultTracingWasInjected', () => {
  async function distDirWith(instrumentation: boolean): Promise<string> {
    const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-dist-'));
    await fs.mkdir(path.join(distDir, 'server'), { recursive: true });
    if (instrumentation) {
      await fs.writeFile(
        path.join(distDir, 'server', 'instrumentation.js'),
        'module.exports = {}\n'
      );
    }
    return distDir;
  }

  it('is true when the entry is set and Next.js compiled it', async () => {
    const distDir = await distDirWith(true);
    await expect(
      defaultTracingWasInjected(
        { instrumentationInject: [INJECT_ENTRY] },
        distDir
      )
    ).resolves.toBe(true);
    await fs.rm(distDir, { recursive: true, force: true });
  });

  it('is false when Next.js ignored the entry and compiled no instrumentation', async () => {
    const distDir = await distDirWith(false);
    await expect(
      defaultTracingWasInjected(
        { instrumentationInject: [INJECT_ENTRY] },
        distDir
      )
    ).resolves.toBe(false);
    await fs.rm(distDir, { recursive: true, force: true });
  });

  it('is false when the adapter did not inject', async () => {
    const distDir = await distDirWith(true);
    await expect(
      defaultTracingWasInjected({ instrumentationInject: [] }, distDir)
    ).resolves.toBe(false);
    await expect(defaultTracingWasInjected({}, distDir)).resolves.toBe(false);
    await fs.rm(distDir, { recursive: true, force: true });
  });
});
