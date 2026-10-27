import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  injectDefaultTracing,
  VERCEL_DEFAULT_TRACING_ENABLED,
  VERCEL_OTEL_PACKAGES_DIR,
} from './tracing';

const INJECT_ENTRY = './.vercel/otel/instrumentation.js';
const WRAPPER_SOURCE = `import { registerOTel } from '@vercel/otel'

export function register() {
  registerOTel({ serviceName: process.env.VERCEL_PROJECT_NAME })
}
`;

type TracingConfig = {
  pageExtensions?: string[];
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
    const nextReal = path.join(projectDir, 'next-real');
    await fs.mkdir(path.join(nextReal, 'dist', 'build'), { recursive: true });
    await fs.writeFile(
      path.join(nextReal, 'package.json'),
      JSON.stringify({ name: 'next', version: '0.0.0' })
    );
    await fs.writeFile(
      path.join(nextReal, 'dist', 'build', 'builtin-instrumentation.js'),
      'module.exports = { resolveInstrumentationInject() {} }\n'
    );
    await fs.mkdir(path.join(projectDir, 'node_modules'), { recursive: true });
    await fs.symlink(nextReal, path.join(projectDir, 'node_modules', 'next'));

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
    await writePackage(
      path.join(otelReal, 'node_modules', '@opentelemetry', 'api'),
      '@opentelemetry/api',
      '1.6.0'
    );
    await fs.mkdir(path.join(packagesDir, '@vercel'), { recursive: true });
    await fs.symlink(otelReal, path.join(packagesDir, '@vercel', 'otel'));
    await writePackage(
      path.join(packagesDir, '@opentelemetry', 'api-logs'),
      '@opentelemetry/api-logs',
      '0.46.0'
    );

    return { projectDir, packagesDir };
  }

  function config(): TracingConfig {
    return { pageExtensions: ['ts', 'tsx', 'js', 'jsx'] };
  }

  async function inject(
    projectDir: string,
    packagesDir: string | undefined,
    tracingConfig: TracingConfig = config(),
    phase: string = PHASE_PRODUCTION_BUILD,
    enabled: string | null = '1'
  ): Promise<TracingConfig> {
    vi.stubEnv(VERCEL_DEFAULT_TRACING_ENABLED, enabled ?? undefined);
    vi.stubEnv(VERCEL_OTEL_PACKAGES_DIR, packagesDir);
    await injectDefaultTracing(tracingConfig, { phase, projectDir });
    return tracingConfig;
  }

  function otelRoot(projectDir: string): string {
    return path.join(projectDir, '.vercel', 'otel');
  }

  it('writes the tracing tree and injects one entry', async () => {
    const { projectDir, packagesDir } = await readyProject();
    const tracingConfig = await inject(projectDir, packagesDir);

    expect(tracingConfig.injectInstrumentation).toEqual([INJECT_ENTRY]);

    const wrapper = path.join(otelRoot(projectDir), 'instrumentation.js');
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
    await expect(
      fs.stat(path.join(copiedOtel, 'node_modules', '@opentelemetry', 'api'))
    ).rejects.toThrow();

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
    const apiEntry = req.resolve('@opentelemetry/api');
    expect(apiEntry.includes(`${path.sep}.vercel${path.sep}`)).toBe(false);
    expect(await fs.realpath(apiEntry)).toBe(
      await fs.realpath(
        path.join(
          projectDir,
          'node_modules',
          '@opentelemetry',
          'api',
          'index.js'
        )
      )
    );
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

  it.each([
    ['unset', null],
    ['0', '0'],
    ['true', 'true'],
  ])('does not inject when default tracing is %s', async (_label, enabled) => {
    const { projectDir, packagesDir } = await readyProject();

    const tracingConfig = await inject(
      projectDir,
      packagesDir,
      config(),
      PHASE_PRODUCTION_BUILD,
      enabled
    );

    expect(tracingConfig.injectInstrumentation).toBeUndefined();
    await expect(fs.stat(otelRoot(projectDir))).rejects.toThrow();
  });

  it('does not inject when the packages dir env is unset', async () => {
    const { projectDir } = await readyProject();

    const tracingConfig = await inject(projectDir, undefined);

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

  it('does not inject when @opentelemetry/api is below 1.6.0', async () => {
    const { projectDir, packagesDir } = await readyProject();
    await writePackage(
      path.join(projectDir, 'node_modules', '@opentelemetry', 'api'),
      '@opentelemetry/api',
      '1.5.0'
    );

    const tracingConfig = await inject(projectDir, packagesDir);

    expect(tracingConfig.injectInstrumentation).toBeUndefined();
    await expect(fs.stat(otelRoot(projectDir))).rejects.toThrow();
  });

  it.each(['1.10.0', '2.0.0'])(
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

  it.each(['1.6.0', '1.9.1'])(
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

  it('does not inject when the build image is missing a package', async () => {
    const { projectDir, packagesDir } = await readyProject();
    await fs.rm(path.join(packagesDir, '@opentelemetry'), { recursive: true });

    const tracingConfig = await inject(projectDir, packagesDir);

    expect(tracingConfig.injectInstrumentation).toBeUndefined();
    await expect(fs.stat(otelRoot(projectDir))).rejects.toThrow();
  });

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

  it('does not inject when Next.js has no injectInstrumentation module', async () => {
    const { projectDir, packagesDir } = await readyProject();
    await fs.rm(path.join(projectDir, 'node_modules', 'next'));

    const tracingConfig = await inject(projectDir, packagesDir);

    expect(tracingConfig.injectInstrumentation).toBeUndefined();
    await expect(fs.stat(otelRoot(projectDir))).rejects.toThrow();
  });

  it('does not inject outside the production build', async () => {
    const { projectDir, packagesDir } = await readyProject();

    const tracingConfig = await inject(
      projectDir,
      packagesDir,
      config(),
      'phase-development-server'
    );

    expect(tracingConfig.injectInstrumentation).toBeUndefined();
    await expect(fs.stat(otelRoot(projectDir))).rejects.toThrow();
  });

  it('treats instrumentation.mjs as a project file when pageExtensions is unset', async () => {
    const { projectDir, packagesDir } = await readyProject();
    await fs.writeFile(
      path.join(projectDir, 'instrumentation.mjs'),
      'export function register() {}\n'
    );

    const tracingConfig = await inject(projectDir, packagesDir, {});

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
