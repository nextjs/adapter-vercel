import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { normalizeRoutes, type RouteWithSrc } from '@vercel/routing-utils';
import type { NextAdapter } from 'next';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoRouteOutput } from '../test/native-operations';

const require = createRequire(import.meta.url);
const adapter = require('../dist/index.js') as NextAdapter;

type BuildContext = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];
type DynamicRoute = BuildContext['routing']['dynamicRoutes'][number];

// Matcher shapes captured from the unchanged Next.js producer. The additional
// conditions and query entries exercise preservation without generating matchers.
const producerRoutes: Record<'split' | 'collapsed', DynamicRoute[]> = {
  split: [
    {
      source: '/catch/[...slug].rsc',
      sourceRegex:
        '^/base[/]?/catch/(?<nxtPslug>.+?)(\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$',
      destination: '/base/catch/[...slug]$2?nxtPslug=$nxtPslug',
      has: [
        {
          type: 'cookie',
          key: 'producer-bypass',
          value: 'yes',
        },
      ],
      missing: [
        {
          type: 'header',
          key: 'x-skip-producer-route',
        },
      ],
    },
    {
      source: '/catch/[...slug]',
      sourceRegex: '^/base[/]?/catch/(?<nxtPslug>.+?)(?:/)?$',
      destination: '/base/catch/[...slug]?nxtPslug=$nxtPslug',
    },
    {
      source: '/native/[id].rsc',
      sourceRegex:
        '^/base[/]?/native/(?<nxtPid>[^/]+?)(\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$',
      destination: '/base/native/[id]$2?nxtPid=$nxtPid',
    },
    {
      source: '/native/[id]',
      sourceRegex: '^/base[/]?/native/(?<nxtPid>[^/]+?)(?:/)?$',
      destination:
        '/base/native/[id]?keep=one&nxtPid=$nxtPid&key=one&nxtIid=$nxtPid&key=two&encoded=%2F%24nxtPid%3F&capture=$nxtPid&nxtIextra=$nxtPid',
    },
    {
      source: '/node/[id].rsc',
      sourceRegex:
        '^/base[/]?/node/(?<nxtPid>[^/]+?)(\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$',
      destination: '/base/node/[id]$2?nxtPid=$nxtPid',
    },
    {
      source: '/node/[id]',
      sourceRegex: '^/base[/]?/node/(?<nxtPid>[^/]+?)(?:/)?$',
      destination: '/base/node/[id]?nxtPid=$nxtPid',
    },
    {
      source: '/optional/[[...slug]].rsc',
      sourceRegex:
        '^/base[/]?/optional(?:/(?<nxtPslug>.+?))?(\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$',
      destination: '/base/optional/[[...slug]]$2?nxtPslug=$nxtPslug',
    },
    {
      source: '/optional/[[...slug]]',
      sourceRegex: '^/base[/]?/optional(?:/(?<nxtPslug>.+?))?(?:/)?$',
      destination: '/base/optional/[[...slug]]?nxtPslug=$nxtPslug',
    },
    {
      source: '/node/[id]',
      sourceRegex:
        '^/base[/]?/node/(?<nxtPid>[^/]+?)\\.segments/(?<segmentPath>.+?)\\.segment\\.rsc(?:/)?$',
      destination:
        '/base/node/[id].segments/$segmentPath.segment.rsc?nxtPid=$nxtPid',
    },
    {
      source: '/node/[id].segments/[...slug]',
      sourceRegex:
        '^/base[/]?/node/(?<nxtPid>[^/]+?)\\.segments/(?<nxtPslug>.+?)(?:/)?$',
      destination:
        '/base/node/[id].segments/[...slug]?nxtPid=$nxtPid&nxtPslug=$nxtPslug',
    },
  ],
  collapsed: [
    {
      source: '/catch/[...slug]',
      sourceRegex:
        '^/base[/]?/catch/(?<nxtPslug>.+?)(\\.rsc|\\.segments/.+\\.segment\\.rsc|)(?:/)?$',
      destination: '/base/catch/[...slug]$2?nxtPslug=$nxtPslug',
      has: [
        {
          type: 'cookie',
          key: 'producer-bypass',
          value: 'yes',
        },
      ],
      missing: [
        {
          type: 'header',
          key: 'x-skip-producer-route',
        },
      ],
    },
    {
      source: '/native/[id]',
      sourceRegex:
        '^/base[/]?/native/(?<nxtPid>[^/]+?)(\\.rsc|\\.segments/.+\\.segment\\.rsc|)(?:/)?$',
      destination:
        '/base/native/[id]$2?keep=one&nxtPid=$nxtPid&key=one&nxtIid=$nxtPid&key=two&encoded=%2F%24nxtPid%3F&capture=$nxtPid&nxtIextra=$nxtPid',
    },
    {
      source: '/node/[id]',
      sourceRegex:
        '^/base[/]?/node/(?<nxtPid>[^/]+?)(\\.rsc|\\.segments/.+\\.segment\\.rsc|)(?:/)?$',
      destination: '/base/node/[id]$2?nxtPid=$nxtPid',
    },
    {
      source: '/optional/[[...slug]]',
      sourceRegex:
        '^/base[/]?/optional(?:/(?<nxtPslug>.+?))?(\\.rsc|\\.segments/.+\\.segment\\.rsc|)(?:/)?$',
      destination: '/base/optional/[[...slug]]$2?nxtPslug=$nxtPslug',
    },
    {
      source: '/node/[id].segments/[...slug]',
      sourceRegex:
        '^/base[/]?/node/(?<nxtPid>[^/]+?)\\.segments/(?<nxtPslug>.+?)(?:/)?$',
      destination:
        '/base/node/[id].segments/[...slug]?nxtPid=$nxtPid&nxtPslug=$nxtPslug',
    },
  ],
};

const expectedDestinations: Record<'split' | 'collapsed', string[]> = {
  split: [
    '/base/catch/[...slug]$2',
    '/base/catch/[...slug]',
    '/base/native/[id]$2',
    '/base/native/[id]?keep=one&key=one&key=two&encoded=%2F%24nxtPid%3F&capture=$nxtPid',
    '/base/node/[id]$2?nxtPid=$nxtPid',
    '/base/node/[id]?nxtPid=$nxtPid',
    '/base/optional/[[...slug]]$2',
    '/base/optional/[[...slug]]',
    '/base/node/[id].segments/$segmentPath.segment.rsc?nxtPid=$nxtPid',
    '/base/node/[id].segments/[...slug]',
  ],
  collapsed: [
    '/base/catch/[...slug]$2',
    '/base/native/[id]$2?keep=one&key=one&key=two&encoded=%2F%24nxtPid%3F&capture=$nxtPid',
    '/base/node/[id]$2?nxtPid=$nxtPid',
    '/base/optional/[[...slug]]$2',
    '/base/node/[id].segments/[...slug]',
  ],
};

function goOutput(pathname: string, filePath: string): GoRouteOutput {
  return {
    type: 'APP_ROUTE',
    runtime: 'go',
    id: pathname,
    pathname: `/base${pathname}`,
    sourcePage: `/(group)${pathname}/route`,
    filePath,
    assets: {},
    assetsHashes: {},
    config: {},
  } as GoRouteOutput;
}

describe('adapter-generated mixed Go and Node routing', () => {
  const roots: string[] = [];
  const savedPackager = process.env.NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH;
  const savedConfig = process.env.NEXT_ADAPTER_VERCEL_CONFIG;

  afterEach(async () => {
    for (const [key, value] of Object.entries({
      NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH: savedPackager,
      NEXT_ADAPTER_VERCEL_CONFIG: savedConfig,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true }))
    );
  });

  it.each([
    ['split', false],
    ['collapsed', false],
    ['split', true],
  ] as const)(
    'omits Go destination parameters and preserves producer matching and Node routing (%s, Node RSC output=%s)',
    async (form, hasNodeRscOutput) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'go-routing-'));
      roots.push(root);
      await fs.symlink(
        path.resolve(__dirname, '../node_modules'),
        path.join(root, 'node_modules'),
        'junction'
      );
      const distDir = path.join(root, '.next');
      const binaryPath = path.join(root, 'user-server');
      const packagerPath = path.join(root, 'packager.cjs');
      const staticPath = path.join(distDir, 'fixture.txt');
      const nodeSource = path.join(root, 'app/node/[id]/page.tsx');
      const nodeEntrypoint = path.join(distDir, 'server/app/node/[id]/page.js');
      await fs.mkdir(path.dirname(nodeSource), { recursive: true });
      await fs.mkdir(path.dirname(nodeEntrypoint), { recursive: true });
      await Promise.all([
        fs.writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ private: true, engines: { node: '22.x' } })
        ),
        fs.writeFile(
          path.join(distDir, 'routes-manifest.json'),
          JSON.stringify({ staticRoutes: [], dynamicRoutes: [] })
        ),
        fs.writeFile(staticPath, 'static'),
        fs.writeFile(binaryPath, 'precompiled server'),
        fs.writeFile(nodeSource, 'export default function Page() {}'),
        fs.writeFile(nodeEntrypoint, 'exports.handler = () => {};'),
        fs.writeFile(
          packagerPath,
          `exports.version = 1;
exports.prepareGoFunction = ({ userServerPath }) => ({
  files: {
    executable: { fsPath: userServerPath, mode: 0o755 },
    'user-server': { fsPath: userServerPath, mode: 0o755 },
  },
});`
        ),
      ]);
      const goOutputs = [
        '/native/[id]',
        '/catch/[...slug]',
        '/optional/[[...slug]]',
        '/node/[id].segments/[...slug]',
        '/static-go',
      ].map((pathname) => goOutput(pathname, binaryPath));
      for (const output of goOutputs) {
        const source = path.join(root, 'app', `${output.sourcePage}.go`);
        await fs.mkdir(path.dirname(source), { recursive: true });
        await fs.writeFile(source, 'package main');
      }
      process.env.NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH = packagerPath;
      process.env.NEXT_ADAPTER_VERCEL_CONFIG = '{}';
      const dynamicRoutes = structuredClone(producerRoutes[form]);
      const originalRoutes = structuredClone(dynamicRoutes);
      const context = {
        projectDir: root,
        repoRoot: root,
        distDir,
        buildId: 'go-routing',
        nextVersion: '16.4.0-canary.38',
        config: {
          basePath: '/base',
          pageExtensions: ['tsx', 'ts'],
          experimental: {},
        },
        outputs: {
          appRoutes: goOutputs,
          appPages: [
            {
              type: 'APP_PAGE',
              runtime: 'nodejs',
              id: '/node/[id]',
              pathname: '/base/node/[id]',
              sourcePage: '/node/[id]/page',
              filePath: nodeEntrypoint,
              assets: {},
              assetsHashes: {},
              config: {},
            },
          ],
          pages: [],
          pagesApi: [],
          staticFiles: [
            {
              type: 'STATIC_FILE',
              id: 'static',
              pathname: '/base/_next/static/a.txt',
              filePath: staticPath,
            },
          ],
          prerenders: [],
        },
        routing: {
          beforeMiddleware: [],
          middlewareMatchers: [],
          beforeFiles: [
            {
              sourceRegex: '^/base/alias/(?<value>[^/]+)$',
              destination: '/base/native/$value?key=rewritten',
            },
          ],
          afterFiles: [],
          fallback: [],
          dynamicRoutes,
          onMatch: [],
          shouldNormalizeNextData: false,
          rsc: {
            header: 'rsc',
            prefetchHeader: 'next-router-prefetch',
            prefetchSegmentHeader: 'next-router-segment-prefetch',
            prefetchSegmentDirSuffix: '.segments',
            prefetchSegmentSuffix: '.segment.rsc',
            varyHeader: 'rsc',
            contentTypeHeader: 'text/x-component',
          },
        },
      } as unknown as BuildContext;
      if (hasNodeRscOutput) {
        const sourcePage = '/native/[id].rsc/page';
        const source = path.join(root, 'app', `${sourcePage}.tsx`);
        await fs.mkdir(path.dirname(source), { recursive: true });
        await fs.writeFile(source, 'export default function Page() {}');
        const nodeOutput = context.outputs.appPages[0];
        if (!nodeOutput) throw new Error('Expected Node output');
        context.outputs.appPages.push({
          ...nodeOutput,
          id: '/native/[id].rsc',
          pathname: '/base/native/[id].rsc',
          sourcePage,
        });
      }
      if (!adapter.onBuildComplete) throw new Error('Expected build hook');
      await adapter.onBuildComplete(context);
      const generated = JSON.parse(
        await fs.readFile(path.join(distDir, 'output/config.json'), 'utf8')
      ) as { routes: RouteWithSrc[] };
      expect(normalizeRoutes(generated.routes).error).toBeNull();
      const rewriteIndex = generated.routes.findIndex(
        (route) => 'handle' in route && route.handle === 'rewrite'
      );
      const hitIndex = generated.routes.findIndex(
        (route) => 'handle' in route && route.handle === 'hit'
      );
      const emittedDynamicRoutes = generated.routes.slice(
        rewriteIndex + 1,
        hitIndex
      );
      const destinations = [...expectedDestinations[form]];
      if (hasNodeRscOutput) {
        destinations[2] = '/base/native/[id]$2?nxtPid=$nxtPid';
      }
      expect(emittedDynamicRoutes).toEqual(
        dynamicRoutes.map((route, index) => ({
          src: route.sourceRegex,
          dest: destinations[index],
          check: true,
          ...(route.has ? { has: route.has } : {}),
          ...(route.missing ? { missing: route.missing } : {}),
        }))
      );
      expect(dynamicRoutes).toEqual(originalRoutes);
      for (const route of emittedDynamicRoutes) {
        expect(route.headers).toBeUndefined();
        expect(route.transforms).toBeUndefined();
        expect(route.important).toBeUndefined();
      }
      // Numeric suffix references retain their capture positions, and the
      // supplied matcher keeps percent-encoded catch-all values untouched.
      expect(emittedDynamicRoutes[0].dest).toBe('/base/catch/[...slug]$2');
      const match = new RegExp(emittedDynamicRoutes[0].src).exec(
        '/base/catch/one%2Ftwo/three%20four.rsc'
      );
      expect(match?.groups?.nxtPslug).toBe('one%2Ftwo/three%20four');
      expect(match?.[2]).toBe('.rsc');
      const matchingDestination = (pathname: string) =>
        emittedDynamicRoutes.find((route) =>
          new RegExp(route.src).test(pathname)
        )?.dest;
      expect(
        matchingDestination('/base/node/123.segments/piece.segment.rsc')
      ).toBe('/base/node/[id]$2?nxtPid=$nxtPid');
      expect(matchingDestination('/base/node/123.segments/piece.txt')).toBe(
        '/base/node/[id].segments/[...slug]'
      );
      const hitEnd = generated.routes.findIndex(
        (route, index) => index > hitIndex && 'handle' in route
      );
      expect(generated.routes.slice(hitIndex + 1, hitEnd)).toEqual([
        {
          src: '/base/?(?:index)?(?:/)?$',
          headers: { 'x-matched-path': '/' },
          continue: true,
          important: true,
        },
        {
          src: '/base/((?!index$).*?)(?:/)?$',
          headers: { 'x-matched-path': '/$1' },
          continue: true,
          important: true,
        },
      ]);
      const rewrite = generated.routes.find(
        (route) => route.src === '^/base/alias/(?<value>[^/]+)$'
      );
      expect(rewrite).toMatchObject({
        dest: '/base/native/$value?key=rewritten',
        headers: {
          'x-nextjs-rewritten-path': '/base/native/$value',
          'x-nextjs-rewritten-query': 'key=rewritten',
        },
      });
      expect(rewrite?.transforms).toBeUndefined();
      for (const output of goOutputs) {
        const functionDir = path.join(
          distDir,
          'output/functions',
          `${output.pathname}.func`
        );
        const functionConfig = JSON.parse(
          await fs.readFile(path.join(functionDir, '.vc-config.json'), 'utf8')
        );
        expect(functionConfig).toEqual({
          runtime: 'executable',
          handler: 'executable',
          runtimeLanguage: 'go',
          architecture: 'x86_64',
          supportsResponseStreaming: true,
          operationType: 'API',
          framework: { slug: 'nextjs', version: context.nextVersion },
        });
        expect(
          await fs.readFile(path.join(functionDir, 'user-server'), 'utf8')
        ).toBe('precompiled server');
        expect((await fs.readdir(functionDir)).sort()).toEqual([
          '.vc-config.json',
          'executable',
          'user-server',
        ]);
      }
      const nodeConfig = JSON.parse(
        await fs.readFile(
          path.join(
            distDir,
            'output/functions/base/node/[id].func/.vc-config.json'
          ),
          'utf8'
        )
      );
      expect(nodeConfig).toMatchObject({
        runtime: 'nodejs22.x',
        handler: '___next_launcher.cjs',
        experimentalAllowBundling: true,
        supportsMultiPayloads: true,
      });
    }
  );
});
