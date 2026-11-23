import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdapterOutputType } from 'next/constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectGoRouteOutputs,
  type GoMiddlewareOutput,
  type GoRouteOutput,
  handleGoOutputs,
} from './go-outputs';
import * as outputUtils from './outputs';
import {
  getSourceFilePathFromPage,
  handleMiddleware,
  usesSrcDirectory,
} from './outputs';

describe('hosted Go route outputs', () => {
  let root: string;
  let projectDir: string;
  let vercelOutputDir: string;
  let binaryPath: string;
  let assetPath: string;
  let packagerPath: string;
  let packagerCalls: string;
  let layoutDir: string;
  let packagerIndex = 0;
  const savedEnv = {
    packager: process.env.NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH,
    config: process.env.NEXT_ADAPTER_VERCEL_CONFIG,
    regions: process.env.VERCEL_FUNCTION_REGIONS,
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-go-'));
    projectDir = path.join(root, 'project');
    vercelOutputDir = path.join(projectDir, '.next', 'output');
    await fs.mkdir(projectDir, { recursive: true });
    await writeSource('/api/hello/route');
    binaryPath = path.join(root, 'compiled-route');
    assetPath = path.join(root, 'message.txt');
    packagerPath = path.join(root, 'packager.cjs');
    packagerCalls = path.join(root, 'packager-calls.jsonl');
    layoutDir = path.join(root, 'layouts');
    await Promise.all([
      fs.writeFile(binaryPath, 'precompiled application'),
      fs.writeFile(assetPath, 'hello asset'),
    ]);
    process.env.NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH = packagerPath;
    process.env.NEXT_ADAPTER_VERCEL_CONFIG = '{}';
    delete process.env.VERCEL_FUNCTION_REGIONS;
    await writePackager();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries({
      NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH: savedEnv.packager,
      NEXT_ADAPTER_VERCEL_CONFIG: savedEnv.config,
      VERCEL_FUNCTION_REGIONS: savedEnv.regions,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  function output(overrides: Partial<GoRouteOutput> = {}): GoRouteOutput {
    return {
      type: AdapterOutputType.APP_ROUTE,
      runtime: 'go',
      id: 'app/api/hello/route',
      pathname: '/api/hello',
      sourcePage: '/api/hello/route',
      filePath: binaryPath,
      assets: {},
      assetsHashes: {},
      config: {},
      ...overrides,
    };
  }

  async function writeSource(
    sourcePage: string,
    src = false,
    extension = 'go'
  ) {
    const filePath = path.join(
      projectDir,
      src ? 'src/app' : 'app',
      `${sourcePage}.${extension}`
    );
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      extension === 'go' ? 'package main' : 'export const GET = () => {}'
    );
    return filePath;
  }

  function collections(appRoutes: unknown[] = []) {
    return {
      appRoutes,
      appPages: [] as unknown[],
      pages: [] as unknown[],
      pagesApi: [] as unknown[],
      staticFiles: [] as unknown[],
      prerenders: [] as { parentOutputId: string }[],
      middleware: undefined as unknown,
    };
  }

  function handle(outputs: GoRouteOutput[], config = {}) {
    return handleGoOutputs(outputs, {
      projectDir,
      vercelOutputDir,
      nextVersion: '16.3.0-canary.96',
      config,
    });
  }

  function imageDigest(binary: string) {
    return `sha256:${createHash('sha256').update(binary).digest('hex')}`;
  }

  function imageHandler(binary: string) {
    return `registry.example.com/next-go@${imageDigest(binary)}`;
  }

  async function calls() {
    const contents = await fs.readFile(packagerCalls, 'utf8').catch(() => '');
    return contents.trim()
      ? contents
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  }

  async function writePackager(extraSource = '', layout = false) {
    packagerPath = path.join(root, `packager-${packagerIndex++}.cjs`);
    process.env.NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH = packagerPath;
    await fs.writeFile(
      packagerPath,
      `
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const { createHash } = require('node:crypto');
      const record = (event) => fs.appendFile(${JSON.stringify(packagerCalls)}, JSON.stringify(event) + '\\n');
      exports.version = 2;
      exports.prepareGoFunction = async ({ userServerPath }) => {
        await record({ prepare: userServerPath });
        const binary = await fs.readFile(userServerPath);
        const digest = createHash('sha256').update(binary).digest('hex');
        if (${layout}) {
          const directory = path.join(${JSON.stringify(layoutDir)}, digest);
          await fs.mkdir(path.join(directory, 'blobs', 'sha256'), { recursive: true });
          await fs.writeFile(path.join(directory, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
          await fs.writeFile(path.join(directory, 'index.json'), JSON.stringify({ schemaVersion: 2 }));
          await fs.writeFile(path.join(directory, 'blobs', 'sha256', digest), binary);
          return { handler: 'sha256:' + digest, image: { type: 'oci-layout', directory } };
        }
        return { handler: 'registry.example.com/next-go@sha256:' + digest };
      };
      exports.close = async () => {
        await record({ close: true });
      };
      ${extraSource}
    `
    );
  }

  async function readConfig(route = 'api/hello') {
    return JSON.parse(
      await fs.readFile(
        path.join(
          vercelOutputDir,
          'functions',
          `${route}.func`,
          '.vc-config.json'
        ),
        'utf8'
      )
    );
  }

  it('packages separate Go container functions with only config and no Node grouping metadata', async () => {
    const secondBinaryPath = path.join(root, 'compiled-other-route');
    await Promise.all([
      writeSource('/api/other/route'),
      fs.writeFile(secondBinaryPath, 'other precompiled application'),
    ]);
    const first = output();
    const second = output({
      id: 'app/api/other/route',
      pathname: '/api/other',
      sourcePage: '/api/other/route',
      filePath: secondBinaryPath,
    });
    await handle([first, second]);
    for (const { route, binary } of [
      {
        route: 'api/hello',
        binary: 'precompiled application',
      },
      {
        route: 'api/other',
        binary: 'other precompiled application',
      },
    ]) {
      const functionDir = path.join(
        vercelOutputDir,
        'functions',
        `${route}.func`
      );
      expect(await readConfig(route)).toEqual({
        runtime: 'container',
        handler: imageHandler(binary),
        runtimeLanguage: 'go',
        architecture: 'x86_64',
        supportsResponseStreaming: true,
        operationType: 'API',
        framework: { slug: 'nextjs', version: '16.3.0-canary.96' },
      });
      expect(await fs.readdir(functionDir)).toEqual(['.vc-config.json']);
    }
    expect(await calls()).toEqual([
      { prepare: binaryPath },
      { prepare: secondBinaryPath },
      { close: true },
    ]);
  });

  it('resolves sourcePage under src/app for overrides and route duration precedence', async () => {
    await fs.rm(path.join(projectDir, 'app'), { recursive: true });
    await writeSource('/api/hello/route', true);
    process.env.NEXT_ADAPTER_VERCEL_CONFIG = JSON.stringify({
      functions: {
        'src/app/api/hello/route.go': {
          maxDuration: 30,
          memory: 1024,
          regions: ['fra1'],
          architecture: 'x86_64',
        },
      },
    });
    await handle([
      output({
        config: { maxDuration: 60, preferredRegion: ['iad1'] },
      }),
    ]);
    expect(await readConfig()).toMatchObject({
      maxDuration: 60,
      memory: 1024,
      regions: ['fra1'],
      architecture: 'x86_64',
    });
  });

  it.each([false, true])(
    'resolves grouped dynamic Go sources with src=%s',
    async (src) => {
      const sourcePage = '/(api)/items/[slug]/route';
      if (src) await fs.rm(path.join(projectDir, 'app'), { recursive: true });
      await writeSource(sourcePage, src);
      const sourcePath = `${src ? 'src/' : ''}app/(api)/items/[slug]/route.go`;
      process.env.NEXT_ADAPTER_VERCEL_CONFIG = JSON.stringify({
        functions: { [sourcePath]: { maxDuration: 42, memory: 1024 } },
      });
      await handle([output({ sourcePage })]);
      expect(await readConfig()).toMatchObject({
        maxDuration: 42,
        memory: 1024,
      });
    }
  );

  it('normalizes Windows source paths for function overrides', async () => {
    vi.spyOn(outputUtils, 'getSourceFilePathFromPage').mockResolvedValue(
      'src\\app\\api\\hello\\route.go'
    );
    process.env.NEXT_ADAPTER_VERCEL_CONFIG = JSON.stringify({
      functions: {
        'src/app/api/hello/route.go': { maxDuration: 42 },
      },
    });
    await handle([output()]);
    expect(await readConfig()).toMatchObject({ maxDuration: 42 });
  });

  it('requires no new source identity field and resolves App Router Go before Pages Router files', async () => {
    const pageSource = path.join(projectDir, 'pages/api/hello/route.go');
    await fs.mkdir(path.dirname(pageSource), { recursive: true });
    await fs.writeFile(pageSource, 'package handler');
    process.env.NEXT_ADAPTER_VERCEL_CONFIG = JSON.stringify({
      functions: {
        'pages/api/hello/route.go': { maxDuration: 5 },
        'app/api/hello/route.go': { maxDuration: 25 },
      },
    });
    await handle([output()]);
    expect(await readConfig()).toMatchObject({ maxDuration: 25 });
  });

  it('prefers root app over an ignored src/app directory', async () => {
    await writeSource('/api/hello/route', true);
    process.env.NEXT_ADAPTER_VERCEL_CONFIG = JSON.stringify({
      functions: {
        'app/api/hello/route.go': { maxDuration: 25 },
        'src/app/api/hello/route.go': { maxDuration: 5 },
      },
    });
    await handle([output()]);
    expect(await readConfig()).toMatchObject({ maxDuration: 25 });
  });

  it('does not match a JavaScript handler when resolving a Go sourcePage', async () => {
    await fs.rm(path.join(projectDir, 'app/api/hello/route.go'));
    await writeSource('/api/hello/route', false, 'ts');
    await expect(
      handle([output()], { pageExtensions: ['ts', 'go'] })
    ).rejects.toThrow('Could not resolve Go route.go source');
  });

  it('resolves route.go even when a sibling extensionless route directory exists', async () => {
    await fs.mkdir(path.join(projectDir, 'app/api/hello/route'));
    await handle([output()]);
    expect(await readConfig()).toMatchObject({ runtimeLanguage: 'go' });
  });

  it('does not match a deeper route when the canonical sourcePage is missing', async () => {
    await writeSource('/api/route/route');
    await expect(
      handle([output({ sourcePage: '/api/route' })])
    ).rejects.toThrow('Could not resolve Go route.go source for /api/route');
  });

  it('preserves default Node source resolution behavior', async () => {
    await writeSource('/api/hello/route', false, 'ts');
    expect(
      await getSourceFilePathFromPage({
        workPath: projectDir,
        page: '/api/hello/route',
        pageExtensions: ['ts'],
        usesSrcDir: await usesSrcDirectory(projectDir),
      })
    ).toBe('app/api/hello/route.ts');
  });

  it('normalizes home region preferences when no function override exists', async () => {
    process.env.VERCEL_FUNCTION_REGIONS = 'fra1,iad1';
    await handle([output({ config: { preferredRegion: 'home' } })]);
    expect(await readConfig()).toMatchObject({ regions: ['fra1', 'iad1'] });
  });

  it('rejects an architecture override that disagrees with the compiled target', async () => {
    process.env.NEXT_ADAPTER_VERCEL_CONFIG = JSON.stringify({
      functions: { 'app/**/*.go': { architecture: 'arm64' } },
    });
    await expect(handle([output()])).rejects.toThrow('architecture conflicts');
  });

  it('rejects unsupported global regions without leaving a partial function', async () => {
    await expect(
      handle([output({ config: { preferredRegion: 'global' } })])
    ).rejects.toThrow('preferredRegion="global"');
    await expect(
      fs.stat(path.join(vercelOutputDir, 'functions/api/hello.func'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('normalizes a basePath root into its index function', async () => {
    await handle([output({ pathname: '/base' })], { basePath: '/base' });
    expect(await readConfig('base/index')).toMatchObject({
      runtimeLanguage: 'go',
    });
  });

  it.each([false, true])(
    'packages proxy.go middleware and matcher routes with src=%s',
    async (src) => {
      const sourcePage = src ? '/src/proxy' : '/proxy';
      const source = path.join(projectDir, sourcePage.slice(1) + '.go');
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, 'package main');
      const middleware: GoMiddlewareOutput = {
        ...output(),
        type: AdapterOutputType.MIDDLEWARE,
        id: '/_middleware',
        pathname: '/_middleware',
        sourcePage,
        config: {
          matchers: [
            {
              source: '/protected/:path*',
              sourceRegex: '^/protected/.*$',
              has: undefined,
              missing: undefined,
            },
          ],
          maxDuration: 42,
        },
      };
      const all = collections();
      all.middleware = middleware;
      expect(collectGoRouteOutputs(all)).toEqual([middleware]);
      await handleGoOutputs([middleware], {
        config: { basePath: src ? '/_middleware' : '' } as never,
        projectDir,
        nextVersion: '16.5.0',
        vercelOutputDir,
      });
      const functionConfig = JSON.parse(
        await fs.readFile(
          path.join(
            vercelOutputDir,
            'functions/_middleware.func/.vc-config.json'
          ),
          'utf8'
        )
      );
      expect(functionConfig).toMatchObject({
        runtime: 'container',
        handler: imageHandler('precompiled application'),
        runtimeLanguage: 'go',
        maxDuration: 42,
      });
      expect(functionConfig).not.toHaveProperty('useWebApi');
      expect(functionConfig).not.toHaveProperty('supportsMultiPayloads');
      const routes = await handleMiddleware(middleware, {
        config: {} as never,
        projectDir,
        repoRoot: projectDir,
        distDir: path.join(projectDir, '.next'),
        nextVersion: '16.5.0',
        vercelOutputDir,
        prerenderFallbackFalseMap: {},
      });
      expect(routes).toEqual([
        expect.objectContaining({
          middlewarePath: '/_middleware',
          src: '^/protected/.*$',
          continue: true,
          override: true,
        }),
      ]);
    }
  );

  it('does not load a Go host module for Node-only output', async () => {
    delete process.env.NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH;
    const nodeOutput = { ...output(), runtime: 'nodejs' };
    expect(collectGoRouteOutputs(collections([nodeOutput]))).toEqual([]);
    await expect(handle([])).resolves.toBeUndefined();
  });

  it('recognizes Go alongside existing Node and Edge outputs', () => {
    const go = output();
    const all = collections([
      { ...go, runtime: 'nodejs' },
      go,
      { ...go, runtime: 'edge' },
    ]);
    expect(collectGoRouteOutputs(all)).toEqual([go]);
  });

  it.each([
    'appPages',
    'pages',
    'pagesApi',
    'staticFiles',
    'middleware',
  ] as const)('rejects Go in %s', (kind) => {
    const all = collections();
    if (kind === 'middleware') all.middleware = output();
    else all[kind].push(output());
    expect(() => collectGoRouteOutputs(all)).toThrow(
      `Go ${kind} outputs are unsupported`
    );
  });

  it('rejects an unknown runtime instead of silently dropping output', () => {
    expect(() =>
      collectGoRouteOutputs(collections([{ ...output(), runtime: 'unknown' }]))
    ).toThrow('Unsupported Next.js adapter output runtime');
  });

  it('rejects Go prerender parents and duplicate output ids', () => {
    const all = collections([output()]);
    all.prerenders.push({ parentOutputId: output().id });
    expect(() => collectGoRouteOutputs(all)).toThrow(
      'cannot be prerender parents'
    );
    expect(() =>
      collectGoRouteOutputs(collections([output(), output()]))
    ).toThrow('Duplicate Go output id');
  });

  it.each([
    '../escape',
    '/absolute',
    'a/../../escape',
    'a\\file',
    'C:/absolute',
    './alias',
    'executable',
    'Executable',
    'USER-SERVER',
    'user-server/nested',
    '.vc-config.json',
    '.VC-CONFIG.JSON',
  ])('rejects unsafe or reserved asset destination %s', async (destination) => {
    await expect(
      handle([output({ assets: { [destination]: assetPath } })])
    ).rejects.toThrow(/Go (asset destination|function asset destination)/);
    await expect(fs.stat(vercelOutputDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects overlapping asset destinations', async () => {
    await expect(
      handle([
        output({
          assets: {
            data: assetPath,
            'data-file': assetPath,
            'data/file': assetPath,
          },
        }),
      ])
    ).rejects.toThrow('Conflicting Go asset destinations');
  });

  it.each([
    { 'data/file.txt': 'data/FILE.txt' },
    { DATA: 'data/file.txt' },
    { 'Data/first.txt': 'data/second.txt' },
  ])('rejects case-folded asset collisions', async (destinations) => {
    const [first, second] = Object.entries(destinations)[0];
    await expect(
      handle([output({ assets: { [first]: assetPath, [second]: assetPath } })])
    ).rejects.toThrow('Conflicting Go asset destinations');
  });

  it.each([
    '/../route',
    'app/api/hello/route',
    '/api/hello/route.ts',
    '/api/../route',
  ])('rejects invalid source identity %s', async (sourcePage) => {
    await expect(handle([output({ sourcePage })])).rejects.toThrow(
      /Go sourcePage/
    );
  });

  it.each([
    { basePath: '', reverse: false },
    { basePath: '', reverse: true },
    { basePath: '/base', reverse: false },
    { basePath: '/base', reverse: true },
  ])(
    'keeps the last Go output for root/index aliases with $basePath and reverse=$reverse',
    async ({ basePath, reverse }) => {
      await writeSource('/route');
      await writeSource('/index/route');
      const secondBinary = path.join(root, 'second-compiled-route');
      await fs.writeFile(secondBinary, 'second compiled application');
      const rootPath = basePath || '/';
      const indexPath = `${basePath}/index`;
      const pathnames = reverse ? [indexPath, rootPath] : [rootPath, indexPath];
      await handle(
        pathnames.map((pathname, index) =>
          output({
            id: `route-${index}`,
            pathname,
            sourcePage: pathname === rootPath ? '/route' : '/index/route',
            filePath: index === 0 ? binaryPath : secondBinary,
            config: { maxDuration: index === 0 ? 10 : 20 },
          })
        ),
        { basePath }
      );
      const functionName = `${basePath.slice(1)}${basePath ? '/' : ''}index`;
      const functionDir = path.join(
        vercelOutputDir,
        'functions',
        `${functionName}.func`
      );
      expect(await fs.readdir(functionDir)).toEqual(['.vc-config.json']);
      expect(await readConfig(functionName)).toMatchObject({
        handler: imageHandler('second compiled application'),
        maxDuration: 20,
      });
    }
  );

  it('rejects case-folded pathname collisions and preserves an existing non-Go function', async () => {
    await expect(
      handle([
        output({ pathname: '/API/hello' }),
        output({ id: 'other', pathname: '/api/hello' }),
      ])
    ).rejects.toThrow('Conflicting Go function output');
    const existing = path.join(vercelOutputDir, 'functions/api/hello.func');
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, 'node.js'), 'node output');
    await expect(handle([output()])).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(path.join(existing, 'node.js'), 'utf8')).toBe(
      'node output'
    );
  });

  it.each(['container', 'executable'])(
    'replaces prior %s Go functions on reruns and removes stale files',
    async (runtime) => {
      // Start with a layout to ensure a registry-mode rerun removes it.
      await writePackager('', true);
      await handle([output()]);
      const functionDir = path.join(
        vercelOutputDir,
        'functions/api/hello.func'
      );
      if (runtime === 'executable') {
        const previousConfig = await readConfig();
        await fs.writeFile(
          path.join(functionDir, '.vc-config.json'),
          JSON.stringify({
            ...previousConfig,
            runtime: 'executable',
            handler: 'executable',
          })
        );
        await fs.writeFile(
          path.join(functionDir, 'executable'),
          'old launcher'
        );
        await fs.writeFile(path.join(functionDir, 'user-server'), 'old server');
      }
      await fs.writeFile(path.join(functionDir, 'stale.txt'), 'old asset');
      await fs.writeFile(binaryPath, 'updated precompiled application');
      await writePackager();
      await handle([
        output({
          config: { maxDuration: 20 },
        }),
      ]);
      expect(await fs.readdir(functionDir)).toEqual(['.vc-config.json']);
      expect(await readConfig()).toMatchObject({
        runtime: 'container',
        handler: imageHandler('updated precompiled application'),
        maxDuration: 20,
        runtimeLanguage: 'go',
      });
      expect(await calls()).toEqual([
        { prepare: binaryPath },
        { close: true },
        { prepare: binaryPath },
        { close: true },
      ]);
    }
  );

  it('preserves a prior Go function and cleans staging when layout assembly fails', async () => {
    await handle([output()]);
    const previousConfig = await readConfig();
    await writePackager('', true);
    const copy = fs.cp;
    let copied = false;
    vi.spyOn(fs, 'cp').mockImplementation(
      async (source, destination, options) => {
        await copy(source, destination, options);
        copied = true;
        throw new Error('layout copy failed');
      }
    );
    await expect(handle([output()])).rejects.toThrow('layout copy failed');
    expect(copied).toBe(true);
    const functionDir = path.join(vercelOutputDir, 'functions/api/hello.func');
    expect(await readConfig()).toEqual(previousConfig);
    expect(await fs.readdir(functionDir)).toEqual(['.vc-config.json']);
    const entries = await fs.readdir(path.join(vercelOutputDir, 'functions'), {
      recursive: true,
    });
    expect(
      entries.filter((entry) =>
        path.basename(entry).startsWith('.go-function-')
      )
    ).toEqual([]);
    expect(await calls()).toEqual([
      { prepare: binaryPath },
      { close: true },
      { prepare: binaryPath },
      { close: true },
    ]);
  });

  it('rejects a symlink function output without writing into its target', async () => {
    const target = path.join(root, 'unrelated-function');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'keep'), 'untouched');
    const functionDir = path.join(vercelOutputDir, 'functions/api/hello.func');
    await fs.mkdir(path.dirname(functionDir), { recursive: true });
    await fs.symlink(target, functionDir, 'dir');
    await expect(handle([output()])).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readdir(target)).toEqual(['keep']);
    expect((await fs.lstat(functionDir)).isSymbolicLink()).toBe(true);
  });

  it('rejects a symlink parent directory without writing into its target', async () => {
    const target = path.join(root, 'unrelated-directory');
    await fs.mkdir(target);
    const functionsDir = path.join(vercelOutputDir, 'functions');
    await fs.mkdir(functionsDir, { recursive: true });
    await fs.symlink(target, path.join(functionsDir, 'api'), 'dir');
    await expect(handle([output()])).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readdir(target)).toEqual([]);
  });

  it('requires a compatible host module', async () => {
    delete process.env.NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH;
    await expect(handle([output()])).rejects.toThrow(
      'hosted @vercel/next Go packager'
    );
    process.env.NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH = packagerPath;
    await writePackager('exports.version = 1;');
    await expect(handle([output()])).rejects.toThrow('protocol version 2');
    expect(await calls()).toEqual([]);
  });

  it.each([
    'null',
    '[]',
    '{}',
    '{ handler: null }',
    '{ handler: 123 }',
    "{ handler: '' }",
    "{ handler: 'image', files: {} }",
    "{ handler: 'image', extra: true }",
  ])('rejects an invalid container response: %s', async (response) => {
    await writePackager(`exports.prepareGoFunction = () => (${response});`);
    await expect(handle([output()])).rejects.toThrow(
      'Go packager must return a container image handler and optional image'
    );
    await expect(fs.stat(vercelOutputDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await calls()).toEqual([{ close: true }]);
  });

  it.each([
    'null',
    '[]',
    '{}',
    "{ type: 'registry', directory: '/layout' }",
    "{ type: 'oci-layout' }",
    "{ type: 'oci-layout', directory: 42 }",
    "{ type: 'oci-layout', directory: '' }",
    "{ type: 'oci-layout', directory: 'relative/layout' }",
    "{ type: 'oci-layout', directory: '/layout', files: {} }",
  ])('rejects an invalid OCI layout response: %s', async (image) => {
    await writePackager(
      `exports.prepareGoFunction = () => ({ handler: 'sha256:abc', image: ${image} });`
    );
    await expect(handle([output()])).rejects.toThrow(
      'Go packager image must be an OCI layout with an absolute directory'
    );
    await expect(fs.stat(vercelOutputDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await calls()).toEqual([{ close: true }]);
  });

  it.each(['null', 'true', "'close'"])(
    'rejects a non-function close hook: %s',
    async (close) => {
      await writePackager(`exports.close = ${close};`);
      await expect(handle([output()])).rejects.toThrow('protocol version 2');
      expect(await calls()).toEqual([]);
    }
  );

  it('accepts a packager without a close hook', async () => {
    await writePackager('delete exports.close;');
    await handle([output()]);
    expect(await readConfig()).toMatchObject({ runtime: 'container' });
    expect(await calls()).toEqual([{ prepare: binaryPath }]);
  });

  it('calls close after writing the function', async () => {
    const configPath = path.join(
      vercelOutputDir,
      'functions/api/hello.func/.vc-config.json'
    );
    await writePackager(`const close = exports.close;
      exports.close = async () => {
        const config = JSON.parse(await fs.readFile(${JSON.stringify(configPath)}, 'utf8'));
        if (config.runtime !== 'container') throw new Error('Function was not written before close');
        await close();
      };`);
    await handle([output()]);
    expect(await calls()).toEqual([{ prepare: binaryPath }, { close: true }]);
  });

  it('calls close when build configuration is invalid', async () => {
    process.env.NEXT_ADAPTER_VERCEL_CONFIG = '{';
    await expect(handle([output()])).rejects.toThrow();
    expect(await calls()).toEqual([{ close: true }]);
  });

  it('rejects separate assets before packaging any functions', async () => {
    await expect(
      handle([
        output(),
        output({
          id: 'with-assets',
          pathname: '/api/assets',
          assets: { 'data/message.txt': assetPath },
        }),
      ])
    ).rejects.toThrow(/cannot include separate assets.*go:embed/);
    expect(await calls()).toEqual([{ close: true }]);
    await expect(fs.stat(vercelOutputDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('copies OCI layouts into each function and preserves the staged layouts', async () => {
    await writePackager('', true);
    const secondBinaryPath = path.join(root, 'other-binary');
    await fs.writeFile(secondBinaryPath, 'other application');
    await handle([
      output(),
      output({ id: 'shared', pathname: '/api/shared' }),
      output({
        id: 'other',
        pathname: '/api/other',
        filePath: secondBinaryPath,
      }),
    ]);
    for (const [route, binary] of [
      ['api/hello', 'precompiled application'],
      ['api/shared', 'precompiled application'],
      ['api/other', 'other application'],
    ]) {
      const functionDir = path.join(
        vercelOutputDir,
        'functions',
        `${route}.func`
      );
      const digest = imageDigest(binary).slice('sha256:'.length);
      const blob = path.join('blobs', 'sha256', digest);
      expect(await readConfig(route)).toMatchObject({
        runtime: 'container',
        handler: imageDigest(binary),
        image: { type: 'oci-layout', path: 'image' },
      });
      expect((await fs.readdir(functionDir)).sort()).toEqual([
        '.vc-config.json',
        'image',
      ]);
      for (const file of ['oci-layout', 'index.json', blob]) {
        expect(
          await fs.readFile(path.join(functionDir, 'image', file))
        ).toEqual(await fs.readFile(path.join(layoutDir, digest, file)));
      }
    }
    const digest = imageDigest('precompiled application').slice(
      'sha256:'.length
    );
    const blob = path.join('blobs', 'sha256', digest);
    await fs.writeFile(
      path.join(vercelOutputDir, 'functions/api/hello.func/image', blob),
      'changed copy'
    );
    expect(
      await fs.readFile(
        path.join(vercelOutputDir, 'functions/api/shared.func/image', blob),
        'utf8'
      )
    ).toBe('precompiled application');
    expect(await fs.readFile(path.join(layoutDir, digest, blob), 'utf8')).toBe(
      'precompiled application'
    );
    expect(await calls()).toEqual([
      { prepare: binaryPath },
      { prepare: binaryPath },
      { prepare: secondBinaryPath },
      { close: true },
    ]);
  });

  it.each([false, true])(
    'writes nothing when the second image fails, with existing output=%s',
    async (existing) => {
      const functionsDir = path.join(vercelOutputDir, 'functions');
      let previousConfig: unknown;
      let previousEntries: string[] | undefined;
      if (existing) {
        await handle([output()]);
        previousConfig = await readConfig();
        await fs.writeFile(
          path.join(functionsDir, 'api/hello.func/keep'),
          'untouched'
        );
        previousEntries = await fs.readdir(functionsDir, { recursive: true });
        await fs.writeFile(packagerCalls, '');
      }
      await fs.writeFile(binaryPath, 'updated application');
      await writePackager(
        `const prepare = exports.prepareGoFunction;
        let count = 0;
        exports.prepareGoFunction = async (options) => {
          const result = await prepare(options);
          if (++count === 2) throw new Error('second image failed');
          return result;
        };`,
        true
      );
      await expect(
        handle([output(), output({ id: 'other', pathname: '/api/other' })])
      ).rejects.toThrow('second image failed');
      if (existing) {
        expect(await readConfig()).toEqual(previousConfig);
        expect(
          await fs.readFile(
            path.join(functionsDir, 'api/hello.func/keep'),
            'utf8'
          )
        ).toBe('untouched');
        expect(await fs.readdir(functionsDir, { recursive: true })).toEqual(
          previousEntries
        );
      } else {
        await expect(fs.stat(vercelOutputDir)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      expect(await calls()).toEqual([
        { prepare: binaryPath },
        { prepare: binaryPath },
        { close: true },
      ]);
    }
  );
});
