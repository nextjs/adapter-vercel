import fs from 'node:fs/promises';
import os from 'node:os';
import { posix as path, relative as relativeOnDisk } from 'node:path';
import { AdapterOutputType } from 'next/dist/shared/lib/constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FuncOutputs, handleNodeOutputs } from './outputs';

// Exercise Windows native relative paths on Ubuntu without replacing POSIX
// function paths or the real filesystem used to write/read the output files.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      relative: actual.win32.relative,
      sep: actual.win32.sep,
    },
  };
});

describe('Node output Windows filesystem paths', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-node-paths-'))
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('writes POSIX function paths for a nested project, traces, fallback and environment loader', async () => {
    const projectDir = path.join(repoRoot, 'apps/web');
    const distDir = path.join(projectDir, '.output/next');
    const vercelOutputDir = path.join(repoRoot, '.vercel/output');
    const contents = {
      'apps/web/package.json': JSON.stringify({ engines: { node: '22.x' } }),
      'apps/web/.env.production': 'PUBLIC_TEST_MESSAGE=fixture',
      'apps/web/.output/next/routes-manifest.json': JSON.stringify({
        headers: [{ source: '/hello' }],
        deploymentId: 'fixture-build',
      }),
      'apps/web/.output/next/server/pages/hello.js': 'hello entrypoint',
      'apps/web/.output/next/server/pages/404.js': 'not found entrypoint',
      'shared/message.txt': 'hello asset',
      'shared/fallback.txt': 'not found asset',
      'node_modules/next/package.json': JSON.stringify({ name: 'next' }),
      'node_modules/@next/env/package.json': JSON.stringify({
        name: '@next/env',
        main: 'index.js',
      }),
      'node_modules/@next/env/index.js': 'exports.loadEnvConfig = () => {};',
    };
    for (const [relativePath, content] of Object.entries(contents)) {
      const filePath = path.join(repoRoot, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
    }
    const outputs: FuncOutputs = [
      {
        id: 'hello',
        type: AdapterOutputType.PAGES,
        pathname: '/hello',
        sourcePage: '/hello',
        filePath: path.join(distDir, 'server/pages/hello.js'),
        runtime: 'nodejs',
        assets: {
          'app-data/message.txt': path.join(repoRoot, 'shared/message.txt'),
        },
        assetsHashes: { 'app-data/message.txt': 'hello-asset-hash' },
        config: {},
      },
      {
        id: 'not-found',
        type: AdapterOutputType.PAGES,
        pathname: '/404',
        sourcePage: '/404',
        filePath: path.join(distDir, 'server/pages/404.js'),
        runtime: 'nodejs',
        assets: {
          'fallback-data.txt': path.join(repoRoot, 'shared/fallback.txt'),
        },
        assetsHashes: { 'fallback-data.txt': 'fallback-asset-hash' },
        config: {},
      },
    ];

    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, 'mkdir').mockImplementation(async (directory, options) => {
      if (typeof directory !== 'string') {
        throw new Error('Expected a function output directory path');
      }
      expect(
        relativeOnDisk(repoRoot, directory),
        `Function output directory escaped the fixture: ${directory}`
      ).not.toMatch(/^(?:\.\.(?:[\\/]|$)|[\\/]|[A-Za-z]:)/);
      return mkdir(directory, options);
    });

    await handleNodeOutputs(outputs, {
      config: {},
      distDir,
      // Both slash styles are accepted by Windows path operations. Keeping
      // real on-disk paths forward-slash separated lets this run in Linux CI.
      repoRoot: repoRoot.replaceAll('/', '\\'),
      projectDir,
      nextVersion: '16.3.0-canary.96',
      prerenderFallbackFalseMap: {},
      vercelOutputDir,
    });

    const functionDir = path.join(vercelOutputDir, 'functions/hello.func');
    const config = JSON.parse(
      await fs.readFile(path.join(functionDir, '.vc-config.json'), 'utf8')
    );
    expect(config.handler).toBe('apps/web/___next_launcher.cjs');
    expect(config.filePathMap).toEqual({
      'app-data/message.txt': 'shared/message.txt',
      'apps/web/.output/next/server/pages/hello.js':
        'apps/web/.output/next/server/pages/hello.js',
      'apps/web/.env.production': 'apps/web/.env.production',
      'node_modules/@next/env/index.js': 'node_modules/@next/env/index.js',
      'fallback-data.txt': 'shared/fallback.txt',
      'apps/web/.output/next/server/pages/404.js':
        'apps/web/.output/next/server/pages/404.js',
      'apps/web/.output/next/routes-manifest.json':
        'apps/web/.output/next/routes-manifest-deterministic.json',
    });
    expect(config).toMatchObject({
      launcherType: 'Nodejs',
      runtime: 'nodejs22.x',
      experimentalAllowBundling: true,
      supportsMultiPayloads: true,
    });
    expect(config.fileHashes).toMatchObject({
      'app-data/message.txt': 'hello-asset-hash',
      'fallback-data.txt': 'fallback-asset-hash',
      'node_modules/@next/env/index.js': expect.any(String),
      'apps/web/.output/next/routes-manifest.json': expect.any(String),
    });
    for (const [destination, source] of Object.entries(config.filePathMap)) {
      for (const location of [destination, source]) {
        expect(location).not.toMatch(/\\|^(?:\/|[A-Za-z]:|\.\.(?:\/|$))/);
      }
      await expect(
        fs.access(path.join(repoRoot, source as string))
      ).resolves.toBeUndefined();
    }
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(
            repoRoot,
            config.filePathMap['apps/web/.output/next/routes-manifest.json']
          ),
          'utf8'
        )
      )
    ).toEqual({ headers: [], onMatchHeaders: [] });
    const launcher = await fs.readFile(
      path.join(functionDir, config.handler),
      'utf8'
    );
    expect(launcher).toContain('".output/next"');
    expect(launcher).toContain('"../../node_modules/@next/env/index.js"');
  });
});
