import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import type { NextAdapter } from 'next';
import { expect, it } from 'vitest';
import { loadReferenceAdapter } from '../../test/reference-adapter';

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
      path.resolve(__dirname, '../../node_modules'),
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
      const modes: Record<string, number> = {};
      const walk = async (dir: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (process.platform !== 'win32')
            modes[path.relative(ctx.distDir, file)] =
              (await fs.lstat(file)).mode & 0o7777;
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
      return { files, modes };
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
        await require('../../dist/go/index.js').onBuildComplete(goCtx);
        const actual = await snapshot();
        expect(actual).toEqual(expected);
        return actual.files;
      },
    });
  } finally {
    if (previous === undefined) delete process.env.NEXT_ADAPTER_VERCEL_CONFIG;
    else process.env.NEXT_ADAPTER_VERCEL_CONFIG = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

it.each([
  { prepared: true, own: false, production: true, injected: true },
  { prepared: true, own: true, production: true, injected: false },
  { prepared: false, own: false, production: true, injected: false },
  { prepared: true, own: false, production: false, injected: false },
])(
  'matches default tracing injection and fetch configuration: %j',
  async (scenario) => {
    const previous = process.env.VERCEL_DEFAULT_NEXT_TRACING_ENTRY;
    try {
      await fixture(async ({ ctx, write, compare }) => {
        const entry =
          './.vercel/otel/node_modules/@vercel/default-tracing/instrumentation.mjs';
        process.env.VERCEL_DEFAULT_NEXT_TRACING_ENTRY = scenario.prepared
          ? entry
          : '';
        await write(entry, 'export async function register() {}');
        if (scenario.own)
          await write('instrumentation.ts', 'export function register() {}');
        ctx.config.outputFileTracingRoot = ctx.projectDir;
        ctx.config.instrumentationInject = [];
        const goConfig = structuredClone(ctx.config);
        const phase = scenario.production
          ? 'phase-production-build'
          : 'phase-development-server';
        const hookContext = {
          projectDir: ctx.projectDir,
          phase,
          nextVersion: ctx.nextVersion,
        };
        const reference = loadReferenceAdapter();
        if (!reference.modifyConfig) throw new Error('Missing config hook');
        await reference.modifyConfig(ctx.config, hookContext);
        await require('../../dist/go/index.js').modifyConfig(
          goConfig,
          hookContext
        );
        expect(goConfig).toEqual(ctx.config);
        ctx.outputs.middleware = {
          ...ctx.outputs.appRoutes[0],
          type: 'MIDDLEWARE',
          id: 'middleware',
          pathname: '/middleware',
          sourcePage: 'middleware',
          config: { matchers: [] },
        } as Context['outputs']['middleware'];
        const files = await compare();
        for (const name of ['api/test', 'middleware']) {
          expect(files[`functions/${name}.func/.vc-config.json`]).toMatchObject(
            {
              shouldDisableAutomaticFetchInstrumentation: scenario.injected,
            }
          );
        }
      });
    } finally {
      if (previous === undefined)
        delete process.env.VERCEL_DEFAULT_NEXT_TRACING_ENTRY;
      else process.env.VERCEL_DEFAULT_NEXT_TRACING_ENTRY = previous;
    }
  }
);

it('matches JavaScript sourcemap stripping and preserves template-literal data', async () => {
  await fixture(async ({ ctx, write, compare }) => {
    const whitespace = [
      '\t',
      '\v',
      '\f',
      ' ',
      '\u00a0',
      '\u1680',
      ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)),
      '\u202f',
      '\u205f',
      '\u3000',
      '\ufeff',
    ];
    const nonWhitespace = ['\u0085', '\u180e', '\u200b'];
    const map = '//# sourceMappingURL=data:application/json;base64,AAAA';
    const templateMap = map.replace('AAAA', 'BBBB');
    const comments = whitespace.map((char) => `${char}${map}${char}AAAA`);
    const templates = nonWhitespace.map(
      (char, i) => `globalThis.value${i} = \`\n${templateMap}${char}BBBB\n\`;`
    );
    const lines = ['\n', '\r\n', '\r', '\u2028', '\u2029'];
    const source = [
      ...comments,
      ...templates,
      ...lines.map(
        (separator) =>
          `globalThis.before = true;${separator}${map}${separator}${map}${separator}globalThis.after = true;`
      ),
    ].join('\n');
    const output = ctx.outputs.appRoutes[0];
    Object.assign(output, {
      runtime: 'edge',
      filePath: await write('.next/server/edge.js', source),
    });
    const files = await compare();
    const handler = (
      files['functions/api/test.func/index.js'] as Buffer
    ).toString('utf8');
    const globals: Record<string, unknown> = {};
    runInNewContext(
      handler.slice(0, handler.indexOf('export default')),
      globals
    );
    for (const [i, char] of nonWhitespace.entries()) {
      expect(globals[`value${i}`]).toBe(`\n${templateMap}${char}BBBB\n`);
    }
    expect(globals.before).toBe(true);
    expect(globals.after).toBe(true);
  });
});

it.skipIf(process.platform === 'win32')(
  'preserves copied file and directory permissions',
  async () => {
    await fixture(async ({ write, compare }) => {
      await fs.chmod(await write('public/shared/data.txt', 'data'), 0o666);
      await fs.chmod(
        path.dirname(await write('public/shared/other.txt', 'other')),
        0o1770
      );
      await compare();
    });
  }
);

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

it('keeps root pages function settings when src/pages is an ordinary file', async () => {
  await fixture(async ({ ctx, write, compare }) => {
    await fs.rm(path.join(ctx.projectDir, 'app'), { recursive: true });
    await write('src/pages', 'Not a directory');
    await write('pages/api/test.ts');
    const route = ctx.outputs.appRoutes[0];
    ctx.outputs.appRoutes = [];
    ctx.outputs.pagesApi = [
      { ...route, type: 'PAGES_API', sourcePage: '/api/test' },
    ] as Context['outputs']['pagesApi'];
    process.env.NEXT_ADAPTER_VERCEL_CONFIG = JSON.stringify({
      functions: { 'pages/api/test.ts': { maxDuration: 23, memory: 2048 } },
    });
    const files = await compare();
    expect(files['functions/api/test.func/.vc-config.json']).toMatchObject({
      maxDuration: 23,
      memory: 2048,
    });
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
