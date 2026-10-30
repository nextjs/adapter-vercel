import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import adapter from './index';
import { injectDefaultTracing } from './tracing';

const INJECT_ENTRY = './.vercel/otel/instrumentation.mjs';
const WRAPPER_SOURCE = `export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerOTel } = await import('@vercel/otel')
    registerOTel({ serviceName: process.env.VERCEL_PROJECT_NAME })
  }
}
`;

type TracingConfig = {
  pageExtensions: string[];
  outputFileTracingRoot?: string;
  injectInstrumentation?: string[];
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
    version: string,
    extra = ''
  ): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version, main: 'index.js' })
    );
    await fs.writeFile(
      path.join(dir, 'index.js'),
      `module.exports = { ${extra} }\n`
    );
  }

  async function readyProject(): Promise<{
    projectDir: string;
    packagesDir: string;
  }> {
    const projectDir = await tempDir('adapter-tracing-app-');
    const packagesDir = await tempDir('adapter-tracing-image-');
    await writePackage(
      path.join(projectDir, 'node_modules', '@opentelemetry', 'api'),
      '@opentelemetry/api',
      '1.9.0'
    );

    const otelReal = path.join(packagesDir, 'otel-real');
    await writePackage(otelReal, '@vercel/otel', '2.0.0', 'registerOTel() {}');
    const target = path.join(packagesDir, 'outside-target.js');
    await fs.writeFile(target, 'module.exports = { dereferenced: true }\n');
    await fs.symlink(target, path.join(otelReal, 'extra.js'));
    await fs.mkdir(path.join(packagesDir, '@vercel'), { recursive: true });
    await fs.symlink(otelReal, path.join(packagesDir, '@vercel', 'otel'));
    await writePackage(
      path.join(packagesDir, '@opentelemetry', 'api-logs'),
      '@opentelemetry/api-logs',
      '0.46.0'
    );
    await writePackage(
      path.join(packagesDir, '@opentelemetry', 'api'),
      '@opentelemetry/api',
      '1.9.0'
    );

    return { projectDir, packagesDir };
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
    packagesDir: string,
    tracingConfig: TracingConfig = config()
  ): Promise<TracingConfig> {
    tracingConfig.outputFileTracingRoot ??= projectDir;
    await injectDefaultTracing(
      tracingConfig as Required<Pick<TracingConfig, 'outputFileTracingRoot'>> &
        TracingConfig,
      projectDir,
      packagesDir
    );
    return tracingConfig;
  }

  // Runs the adapter's real modifyConfig, which decides whether to inject.
  async function modifyConfig(
    projectDir: string,
    env: { enabled?: string; packagesDir?: string },
    phase: string = PHASE_PRODUCTION_BUILD
  ): Promise<TracingConfig> {
    vi.stubEnv('VERCEL_DEFAULT_TRACING_ENABLED', env.enabled);
    vi.stubEnv('VERCEL_OTEL_PACKAGES_DIR', env.packagesDir);
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

  function otelRoot(projectDir: string): string {
    return path.join(projectDir, '.vercel', 'otel');
  }

  it('writes the tracing tree and injects one entry', async () => {
    const { projectDir, packagesDir } = await readyProject();
    const tracingConfig = await inject(projectDir, packagesDir);

    expect(tracingConfig.injectInstrumentation).toEqual([INJECT_ENTRY]);

    const wrapper = path.join(otelRoot(projectDir), 'instrumentation.mjs');
    expect(await fs.readFile(wrapper, 'utf8')).toBe(WRAPPER_SOURCE);

    const copiedOtel = path.join(
      otelRoot(projectDir),
      'node_modules',
      '@vercel',
      'otel'
    );
    const copiedStat = await fs.lstat(copiedOtel);
    expect(copiedStat.isSymbolicLink()).toBe(false);
    expect(copiedStat.isDirectory()).toBe(true);

    const extra = path.join(copiedOtel, 'extra.js');
    const extraStat = await fs.lstat(extra);
    expect(extraStat.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(extra, 'utf8')).toBe(
      'module.exports = { dereferenced: true }\n'
    );
    const req = createRequire(wrapper);
    expect(await fs.realpath(req.resolve('@vercel/otel'))).toBe(
      await fs.realpath(path.join(copiedOtel, 'index.js'))
    );
    expect(await fs.realpath(req.resolve('@opentelemetry/api-logs'))).toBe(
      await fs.realpath(
        path.join(
          otelRoot(projectDir),
          'node_modules',
          '@opentelemetry',
          'api-logs',
          'index.js'
        )
      )
    );
    expect(await fs.realpath(req.resolve('@opentelemetry/api'))).toBe(
      await fs.realpath(
        path.join(
          otelRoot(projectDir),
          'node_modules',
          '@opentelemetry',
          'api',
          'index.js'
        )
      )
    );
  });

  it('writes a wrapper that loads as ESM in a "type": "commonjs" app', async () => {
    const { projectDir, packagesDir } = await readyProject();
    await fs.writeFile(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: 'app', type: 'commonjs' })
    );
    const tracingConfig = await inject(projectDir, packagesDir);
    const [entry] = tracingConfig.injectInstrumentation ?? [];

    // Node and webpack both read .js as CommonJS here, so a .js wrapper's
    // import/export would fail to parse.
    const wrapper = pathToFileURL(path.resolve(projectDir, entry)).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(wrapper)}); console.log(typeof m.register)`,
      ],
      { encoding: 'utf8' }
    );
    expect(output.trim()).toBe('function');
  });

  it('does not inject when the project has an instrumentation file', async () => {
    const { projectDir, packagesDir } = await readyProject();
    await fs.writeFile(
      path.join(projectDir, 'instrumentation.ts'),
      'export function register() {}\n'
    );

    const tracingConfig = await inject(projectDir, packagesDir);

    expect(tracingConfig.injectInstrumentation).toBeUndefined();
    await expect(fs.stat(otelRoot(projectDir))).rejects.toThrow();
  });

  it('does not inject when a parent folder inside the tracing root has an instrumentation file', async () => {
    const { projectDir, packagesDir } = await readyProject();
    const app = path.join(projectDir, 'apps', 'web');
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'instrumentation.ts'),
      'export function register() {}\n'
    );

    const tracingConfig = await inject(app, packagesDir, {
      ...config(),
      outputFileTracingRoot: projectDir,
    });

    expect(tracingConfig.injectInstrumentation).toBeUndefined();
    await expect(fs.stat(otelRoot(app))).rejects.toThrow();
  });

  it('ignores an instrumentation file above the tracing root', async () => {
    const { projectDir, packagesDir } = await readyProject();
    const app = path.join(projectDir, 'apps', 'web');
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'instrumentation.ts'),
      'export function register() {}\n'
    );

    const tracingConfig = await inject(app, packagesDir, {
      ...config(),
      outputFileTracingRoot: app,
    });

    expect(tracingConfig.injectInstrumentation).toEqual([INJECT_ENTRY]);
  });

  it('does not inject when src/ has an instrumentation file', async () => {
    const { projectDir, packagesDir } = await readyProject();
    await fs.mkdir(path.join(projectDir, 'src'));
    await fs.writeFile(
      path.join(projectDir, 'src', 'instrumentation.js'),
      'export function register() {}\n'
    );

    const tracingConfig = await inject(projectDir, packagesDir);

    expect(tracingConfig.injectInstrumentation).toBeUndefined();
    await expect(fs.stat(otelRoot(projectDir))).rejects.toThrow();
  });

  it('injects through modifyConfig when default tracing is enabled', async () => {
    const { projectDir, packagesDir } = await readyProject();

    const tracingConfig = await modifyConfig(projectDir, {
      enabled: '1',
      packagesDir,
    });

    expect(tracingConfig.injectInstrumentation).toEqual([INJECT_ENTRY]);
  });

  it.each([
    ['unset', undefined],
    ['0', '0'],
    ['true', 'true'],
  ])('does not inject when default tracing is %s', async (_label, enabled) => {
    const { projectDir, packagesDir } = await readyProject();

    const tracingConfig = await modifyConfig(projectDir, {
      enabled,
      packagesDir,
    });

    expect(tracingConfig.injectInstrumentation).toBeUndefined();
    await expect(fs.stat(otelRoot(projectDir))).rejects.toThrow();
  });

  it.each([
    ['unset', undefined],
    ['blank', '  '],
  ])('does not inject when the packages dir env is %s', async (_label, dir) => {
    const { projectDir } = await readyProject();

    const tracingConfig = await modifyConfig(projectDir, {
      enabled: '1',
      packagesDir: dir,
    });

    expect(tracingConfig.injectInstrumentation).toBeUndefined();
    await expect(fs.stat(otelRoot(projectDir))).rejects.toThrow();
  });

  it('injects when the app has no @opentelemetry/api', async () => {
    const { projectDir, packagesDir } = await readyProject();
    await fs.rm(path.join(projectDir, 'node_modules', '@opentelemetry'), {
      recursive: true,
    });

    const tracingConfig = await inject(projectDir, packagesDir);

    expect(tracingConfig.injectInstrumentation).toEqual([INJECT_ENTRY]);
  });

  it.each(['1.10.0', '2.0.0', '1.9.0-rc.0'])(
    'does not inject when @opentelemetry/api is %s',
    async (version) => {
      const { projectDir, packagesDir } = await readyProject();
      await writePackage(
        path.join(projectDir, 'node_modules', '@opentelemetry', 'api'),
        '@opentelemetry/api',
        version
      );

      const tracingConfig = await inject(projectDir, packagesDir);

      expect(tracingConfig.injectInstrumentation).toBeUndefined();
      await expect(fs.stat(otelRoot(projectDir))).rejects.toThrow();
    }
  );

  it.each(['1.4.1', '1.6.0', '1.9.1'])(
    'injects when @opentelemetry/api is %s',
    async (version) => {
      const { projectDir, packagesDir } = await readyProject();
      await writePackage(
        path.join(projectDir, 'node_modules', '@opentelemetry', 'api'),
        '@opentelemetry/api',
        version
      );

      const tracingConfig = await inject(projectDir, packagesDir);

      expect(tracingConfig.injectInstrumentation).toEqual([INJECT_ENTRY]);
    }
  );

  it('does not inject when only Next.js resolves @opentelemetry/api 1.10.0', async () => {
    const { projectDir, packagesDir } = await readyProject();
    await hiddenOtelApi(projectDir, '1.10.0');

    const tracingConfig = await inject(projectDir, packagesDir);

    expect(tracingConfig.injectInstrumentation).toBeUndefined();
    await expect(fs.stat(otelRoot(projectDir))).rejects.toThrow();
  });

  it('injects when only Next.js resolves @opentelemetry/api 1.9.0', async () => {
    const { projectDir, packagesDir } = await readyProject();
    await hiddenOtelApi(projectDir, '1.9.0');

    const tracingConfig = await inject(projectDir, packagesDir);

    expect(tracingConfig.injectInstrumentation).toEqual([INJECT_ENTRY]);
    const wrapper = path.join(otelRoot(projectDir), 'instrumentation.mjs');
    expect(
      await fs.realpath(createRequire(wrapper).resolve('@opentelemetry/api'))
    ).toBe(
      await fs.realpath(
        path.join(
          otelRoot(projectDir),
          'node_modules',
          '@opentelemetry',
          'api',
          'index.js'
        )
      )
    );
  });

  it.each(['@vercel/otel', '@opentelemetry/api-logs', '@opentelemetry/api'])(
    'does not inject when the build image is missing %s',
    async (name) => {
      const { projectDir, packagesDir } = await readyProject();
      await fs.rm(path.join(packagesDir, name), { recursive: true });

      const tracingConfig = await inject(projectDir, packagesDir);

      expect(tracingConfig.injectInstrumentation).toBeUndefined();
      await expect(fs.stat(otelRoot(projectDir))).rejects.toThrow();
    }
  );

  it('keeps existing injectInstrumentation entries', async () => {
    const { projectDir, packagesDir } = await readyProject();
    const tracingConfig = config();
    tracingConfig.injectInstrumentation = ['./custom.js'];

    await inject(projectDir, packagesDir, tracingConfig);

    expect(tracingConfig.injectInstrumentation).toEqual([
      './custom.js',
      INJECT_ENTRY,
    ]);
  });

  it('does not log a skip unless builder debug is on', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const { projectDir, packagesDir } = await readyProject();
      await fs.writeFile(
        path.join(projectDir, 'instrumentation.ts'),
        'export function register() {}\n'
      );

      vi.stubEnv('VERCEL_BUILDER_DEBUG', undefined);
      await inject(projectDir, packagesDir);
      expect([...log.mock.calls, ...info.mock.calls].flat()).not.toContain(
        'Skipping Vercel tracing inject: project has an instrumentation file'
      );

      vi.stubEnv('VERCEL_BUILDER_DEBUG', '1');
      await inject(projectDir, packagesDir);
      expect(log).toHaveBeenCalledWith(
        'Skipping Vercel tracing inject: project has an instrumentation file'
      );
    } finally {
      log.mockRestore();
      info.mockRestore();
    }
  });

  it('does not inject outside the production build', async () => {
    const { projectDir, packagesDir } = await readyProject();

    const tracingConfig = await modifyConfig(
      projectDir,
      { enabled: '1', packagesDir },
      'phase-development-server'
    );

    expect(tracingConfig.injectInstrumentation).toBeUndefined();
    await expect(fs.stat(otelRoot(projectDir))).rejects.toThrow();
  });

  it('does not throw when the tracing directory cannot be written', async () => {
    const { projectDir, packagesDir } = await readyProject();
    await fs.mkdir(path.join(projectDir, '.vercel'));
    await fs.writeFile(path.join(projectDir, '.vercel', 'otel'), 'blocked');

    const tracingConfig = await inject(projectDir, packagesDir);

    expect(tracingConfig.injectInstrumentation).toBeUndefined();
  });

  it('does not add a second entry when called again', async () => {
    const { projectDir, packagesDir } = await readyProject();
    const tracingConfig = await inject(projectDir, packagesDir);
    await inject(projectDir, packagesDir, tracingConfig);

    expect(tracingConfig.injectInstrumentation).toEqual([INJECT_ENTRY]);
  });
});
