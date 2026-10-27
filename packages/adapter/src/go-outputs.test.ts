import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdapterOutputType } from 'next/dist/shared/lib/constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectGoRouteOutputs,
  type GoRouteOutput,
  handleGoOutputs,
} from './go-outputs';
import { GO_ROUTING_CONFIG, GO_ROUTING_ENV } from './go-routing';
import * as outputUtils from './outputs';
import { getSourceFilePathFromPage, usesSrcDirectory } from './outputs';

describe('hosted Go route outputs', () => {
  let root: string;
  let projectDir: string;
  let vercelOutputDir: string;
  let proxyPath: string;
  let binaryPath: string;
  let assetPath: string;
  let packagerPath: string;
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
    proxyPath = path.join(root, 'proxy');
    binaryPath = path.join(root, 'compiled-route');
    assetPath = path.join(root, 'message.txt');
    packagerPath = path.join(root, 'packager.cjs');
    await Promise.all([
      fs.writeFile(proxyPath, 'proxy binary'),
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
      assets: { 'data/message.txt': assetPath },
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

  async function writePackager(extraSource = '') {
    await fs.writeFile(
      packagerPath,
      `
      exports.version = 1;
      exports.prepareGoFunction = async ({ userServerPath }) => ({
        files: {
          executable: { fsPath: ${JSON.stringify(proxyPath)}, mode: 0o755 },
          'user-server': { fsPath: userServerPath, mode: 0o755 },
        },
        config: {
          runtime: 'executable', handler: 'executable', runtimeLanguage: 'go',
          architecture: 'x86_64', supportsResponseStreaming: true,
        },
      });
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

  it('packages separate Go functions with executable modes, assets and no Node grouping metadata', async () => {
    const second = output({
      id: 'app/api/other/route',
      pathname: '/api/other',
    });
    await handle([output(), second]);
    for (const route of ['api/hello', 'api/other']) {
      const functionDir = path.join(
        vercelOutputDir,
        'functions',
        `${route}.func`
      );
      expect(await readConfig(route)).toEqual({
        environment: { [GO_ROUTING_ENV]: GO_ROUTING_CONFIG },
        runtime: 'executable',
        handler: 'executable',
        runtimeLanguage: 'go',
        architecture: 'x86_64',
        supportsResponseStreaming: true,
        operationType: 'API',
        framework: { slug: 'nextjs', version: '16.3.0-canary.96' },
      });
      expect(
        await fs.readFile(path.join(functionDir, 'user-server'), 'utf8')
      ).toBe('precompiled application');
      expect(
        await fs.readFile(path.join(functionDir, 'executable'), 'utf8')
      ).toBe('proxy binary');
      expect(
        await fs.readFile(path.join(functionDir, 'data/message.txt'), 'utf8')
      ).toBe('hello asset');
      expect(
        (await fs.stat(path.join(functionDir, 'user-server'))).mode & 0o777
      ).toBe(0o755);
      expect(
        (await fs.stat(path.join(functionDir, 'executable'))).mode & 0o777
      ).toBe(0o755);
      expect(await fs.readdir(functionDir)).not.toContain(
        '___next_launcher.cjs'
      );
    }
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
    expect(output()).not.toHaveProperty('sourceFile');
    expect(output()).not.toHaveProperty('target');
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
    expect(await usesSrcDirectory(projectDir, 'app')).toBe(false);
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
      const secondAsset = path.join(root, 'second-message.txt');
      await fs.writeFile(secondBinary, 'second compiled application');
      await fs.writeFile(secondAsset, 'second handler asset');
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
            assets:
              index === 0
                ? { 'data/message.txt': assetPath }
                : { 'second-message.txt': secondAsset },
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
      expect(
        await fs.readFile(path.join(functionDir, 'user-server'), 'utf8')
      ).toBe('second compiled application');
      expect(
        await fs.readFile(path.join(functionDir, 'second-message.txt'), 'utf8')
      ).toBe('second handler asset');
      await expect(
        fs.stat(path.join(functionDir, 'data/message.txt'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readConfig(functionName)).toMatchObject({ maxDuration: 20 });
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

  it('replaces prior Go functions on reruns and removes stale assets', async () => {
    await handle([output()]);
    await fs.writeFile(binaryPath, 'updated precompiled application');
    const nextAsset = path.join(root, 'next-message.txt');
    await fs.writeFile(nextAsset, 'updated asset');
    await handle([
      output({
        assets: { 'next-message.txt': nextAsset },
        config: { maxDuration: 20 },
      }),
    ]);
    const functionDir = path.join(vercelOutputDir, 'functions/api/hello.func');
    expect(
      await fs.readFile(path.join(functionDir, 'user-server'), 'utf8')
    ).toBe('updated precompiled application');
    expect(
      await fs.readFile(path.join(functionDir, 'next-message.txt'), 'utf8')
    ).toBe('updated asset');
    await expect(
      fs.stat(path.join(functionDir, 'data/message.txt'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readConfig()).toMatchObject({
      maxDuration: 20,
      runtimeLanguage: 'go',
    });
  });

  it('preserves a prior Go function when preparing its replacement fails', async () => {
    await handle([output()]);
    await expect(
      handle([output({ assets: { missing: path.join(root, 'missing') } })])
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const functionDir = path.join(vercelOutputDir, 'functions/api/hello.func');
    expect(
      await fs.readFile(path.join(functionDir, 'user-server'), 'utf8')
    ).toBe('precompiled application');
    expect(
      await fs.readFile(path.join(functionDir, 'data/message.txt'), 'utf8')
    ).toBe('hello asset');
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
    await writePackager('exports.version = 2;');
    await expect(handle([output()])).rejects.toThrow('protocol version 1');
  });

  it('rejects invalid host runtime metadata', async () => {
    await writePackager(`const prepare = exports.prepareGoFunction;
      exports.prepareGoFunction = async (options) => {
        const result = await prepare(options); result.config.runtime = 'nodejs24.x'; return result;
      };`);
    await expect(handle([output()])).rejects.toThrow(
      'Invalid Go executable runtime configuration'
    );
  });

  it('removes a partial function when a required asset cannot be copied', async () => {
    await expect(
      handle([output({ assets: { missing: path.join(root, 'missing') } })])
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(vercelOutputDir, 'functions/api/hello.func'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
