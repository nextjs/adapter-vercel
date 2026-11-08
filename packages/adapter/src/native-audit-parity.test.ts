import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { NextAdapter } from 'next';
import { expect, it } from 'vitest';
import { loadReferenceAdapter } from '../test/reference-adapter';

const require = createRequire(import.meta.url);
const { defaultConfig } = require('next/dist/server/config-shared');
type Context = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];

async function fixture(
  check: (fixture: {
    ctx: Context;
    write: (name: string, content?: string) => Promise<string>;
    compare: () => Promise<Record<string, unknown>>;
  }) => Promise<void>
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-audit-parity-'));
  const previous = process.env.NEXT_ADAPTER_VERCEL_CONFIG;
  process.env.NEXT_ADAPTER_VERCEL_CONFIG = JSON.stringify({
    functions: { 'app/**': { maxDuration: 23 } },
  });
  try {
    const write = async (name: string, content = 'module.exports = {};') => {
      const file = path.join(root, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
      return file;
    };
    await fs.symlink(
      path.resolve(__dirname, '../node_modules'),
      path.join(root, 'node_modules')
    );
    await write('package.json', JSON.stringify({ engines: { node: '22.x' } }));
    await write(
      '.next/routes-manifest.json',
      '{"version":3,"headers":[],"staticRoutes":[],"dynamicRoutes":[]}'
    );
    await write('app/api/test/route.ts');
    const chunk = await write('.next/static/chunks/main.js');
    const output = {
      id: 'route',
      type: 'APP_ROUTE',
      runtime: 'nodejs',
      pathname: '/api/test',
      sourcePage: '/api/test/route',
      filePath: await write('.next/server/route.js'),
      assets: {},
      assetsHashes: {},
      config: {},
    };
    const ctx = {
      config: { ...defaultConfig },
      projectDir: root,
      repoRoot: root,
      distDir: path.join(root, '.next'),
      nextVersion: '16.4.5',
      buildId: 'audit',
      routing: {
        beforeMiddleware: [],
        beforeFiles: [],
        afterFiles: [],
        fallback: [],
        dynamicRoutes: [],
        onMatch: [],
        shouldNormalizeNextData: false,
        rsc: {
          header: 'rsc',
          prefetchHeader: 'next-router-prefetch',
          prefetchSegmentHeader: 'next-router-segment-prefetch',
          prefetchSegmentDirSuffix: '.segments',
          prefetchSegmentSuffix: '.segment.rsc',
          varyHeader: 'rsc, next-router-state-tree',
          contentTypeHeader: 'text/x-component',
        },
      },
      outputs: {
        appPages: [],
        appRoutes: [output],
        pages: [],
        pagesApi: [],
        staticFiles: [
          {
            id: 'chunk',
            type: 'STATIC_FILE',
            pathname: '/_next/static/chunks/main.js',
            filePath: chunk,
          },
        ],
        prerenders: [],
      },
    } as unknown as Context;
    const snapshot = async () => {
      const files: Record<string, unknown> = {};
      const walk = async (dir: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(file);
          else {
            const bytes = await fs.readFile(file);
            files[
              path
                .relative(path.join(ctx.distDir, 'output'), file)
                .split(path.sep)
                .join('/')
            ] = file.endsWith('.json') ? JSON.parse(bytes.toString()) : bytes;
          }
        }
      };
      await walk(path.join(ctx.distDir, 'output'));
      return files;
    };
    await check({
      ctx,
      write,
      compare: async () => {
        // Preserve alias identity, and prevent reference mutations reaching Go.
        const goCtx = structuredClone(ctx);
        const reference = loadReferenceAdapter();
        if (!reference.onBuildComplete)
          throw new Error('Missing reference adapter hook');
        await reference.onBuildComplete(ctx);
        const expected = await snapshot();
        await fs.rm(path.join(ctx.distDir, 'output'), { recursive: true });
        await require('../dist/index.js').onBuildComplete(goCtx);
        const actual = await snapshot();
        expect(actual).toEqual(expected);
        return actual;
      },
    });
  } finally {
    if (previous === undefined) delete process.env.NEXT_ADAPTER_VERCEL_CONFIG;
    else process.env.NEXT_ADAPTER_VERCEL_CONFIG = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

it('keeps route-handler-only rewrites unchanged without segment fallback', async () => {
  await fixture(async ({ ctx, compare }) => {
    for (const phase of ['beforeFiles', 'afterFiles', 'fallback'] as const) {
      ctx.routing[phase].push({
        sourceRegex: `^/${phase}(?:\\/)?$`,
        destination: '/api/test?keep=1',
      });
    }
    const files = await compare();
    const config = files['config.json'] as { routes: Array<{ src?: string }> };
    expect(
      config.routes.filter((route) => route.src?.includes('segment'))
    ).toEqual([]);
  });
});

it.each([
  [undefined, undefined],
  [null, undefined],
  [null, null],
  [null, 42],
  [undefined, null],
  [undefined, 0],
  [0, 42],
  [17, 42],
])(
  'matches workflow maxDuration precedence (%s, %s)',
  async (generated, output) => {
    await fixture(async ({ ctx, write, compare }) => {
      process.env.NEXT_ADAPTER_VERCEL_CONFIG = JSON.stringify({
        functions: { 'app/.well-known/**': { maxDuration: 23 } },
      });
      const route = ctx.outputs.appRoutes[0];
      route.pathname = '/.well-known/workflow/v1/step';
      route.sourcePage = '/.well-known/workflow/v1/step/route';
      route.config = { maxDuration: output } as typeof route.config;
      await write('app/.well-known/workflow/v1/step/route.ts');
      await write(
        'app/.well-known/workflow/v1/config.json',
        JSON.stringify({ steps: { maxDuration: generated } })
      );
      await compare();
    });
  }
);

it.each([
  ['app/**', '/api/test/route'],
  ['app/**', '/.hidden/test/route'],
  ['app/.hidden/**', '/.hidden/test/route'],
  ['app/{.hidden,api}/**', '/.hidden/test/route'],
  ['app/!(other)/**', '/api/test/route'],
  ['app/!(other)/**', '/.hidden/test/route'],
  ['!app/**', '/.hidden/test/route'],
  ['app/**/route.ts', '/.hidden/test/route'],
  ['app/**/route.ts', '/api/test/route'],
  ['app/**/.hidden/**', '/api/.hidden/test/route'],
  ['app/?/route.ts', '/😀/route'],
  ['app/??/route.ts', '/😀/route'],
  ['app/😀*/route.ts', '/😀/route'],
  ['app/😀?/route.ts', '/😀a/route'],
])(
  'matches TypeScript function pattern %s for %s',
  async (pattern, sourcePage) => {
    await fixture(async ({ ctx, write, compare }) => {
      process.env.NEXT_ADAPTER_VERCEL_CONFIG = JSON.stringify({
        functions: { [pattern]: { maxDuration: 23 } },
      });
      ctx.outputs.appRoutes[0].sourcePage = sourcePage;
      await write(`app${sourcePage}.ts`);
      await compare();
    });
  }
);

it.each([true, false])(
  'preserves hash identity separately from equal contents (shared: %s)',
  async (shared) => {
    await fixture(async ({ ctx, write, compare }) => {
      ctx.outputs.appRoutes = [];
      const hashes = {};
      const page = {
        id: 'page',
        type: 'PAGES',
        runtime: 'nodejs',
        pathname: '/main',
        sourcePage: '/main',
        filePath: await write('.next/server/main.js'),
        assets: {},
        assetsHashes: hashes,
        config: {},
      };
      await write('pages/main.ts');
      await write('pages/404.ts');
      await write('pages/api/test.ts');
      ctx.outputs.pages = [
        page,
        {
          ...page,
          id: '404',
          pathname: '/404',
          sourcePage: '/404',
          filePath: await write('.next/server/404.js'),
          assets: { nf: await write('.next/server/nf.js') },
          assetsHashes: { nf: 'nf-hash' },
        },
      ] as unknown as Context['outputs']['pages'];
      ctx.outputs.pagesApi = [
        {
          ...page,
          id: 'api',
          type: 'PAGES_API',
          pathname: '/api/test',
          sourcePage: '/api/test',
          filePath: await write('.next/server/api.js'),
          assetsHashes: shared ? hashes : {},
        },
      ] as unknown as Context['outputs']['pagesApi'];
      const files = await compare();
      const config = files['functions/api/test.func/.vc-config.json'] as {
        fileHashes: Record<string, string>;
      };
      expect(config.fileHashes.nf).toBe(shared ? 'nf-hash' : undefined);
    });
  }
);
