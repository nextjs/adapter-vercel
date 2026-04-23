import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Route, RouteWithSrc } from '@vercel/routing-utils';
import type { NextAdapter } from 'next';
import { afterEach, describe, expect, it } from 'vitest';
import adapter from './index';
import { getStaticExportGlobalFallbackRoute } from './routing';

const htmlDocumentRequest = [
  {
    type: 'header' as const,
    key: 'accept',
    value: '.*text/html.*',
  },
];

function expectRouteMatches(
  route: RouteWithSrc,
  matchingPaths: string[],
  excludedPaths: string[]
) {
  expect(route.src).toBeDefined();

  const matcher = new RegExp(route.src!);

  for (const pathname of matchingPaths) {
    expect(matcher.test(pathname), pathname).toBe(true);
  }

  for (const pathname of excludedPaths) {
    expect(matcher.test(pathname), pathname).toBe(false);
  }
}

describe('getStaticExportGlobalFallbackRoute', () => {
  it('returns no route unless output export emitted a global fallback file', () => {
    expect(
      getStaticExportGlobalFallbackRoute({
        config: {},
        staticFilePathnames: ['/docs/_fallback'],
      })
    ).toBeUndefined();
    expect(
      getStaticExportGlobalFallbackRoute({
        config: { output: 'export', basePath: '/docs' },
        staticFilePathnames: ['/docs/index'],
      })
    ).toBeUndefined();
  });

  it('creates a basePath-aware document fallback route', () => {
    const route = getStaticExportGlobalFallbackRoute({
      config: { output: 'export', basePath: '/docs' },
      staticFilePathnames: ['/docs/_fallback'],
    });

    expect(route).toEqual({
      src: '^/docs(?:/(?!_next(?:/|$)).*)?$',
      dest: '/docs/_fallback',
      has: htmlDocumentRequest,
      check: true,
    });

    expectRouteMatches(
      route!,
      ['/docs', '/docs/blog/one'],
      ['/', '/blog/one', '/docs/_next/static/chunk.js']
    );
  });

  it('creates a root document fallback route that skips Next.js assets', () => {
    const route = getStaticExportGlobalFallbackRoute({
      config: { output: 'export' },
      staticFilePathnames: ['/_fallback'],
    });

    expect(route).toEqual({
      src: '^/(?!_next(?:/|$)).*',
      dest: '/_fallback',
      has: htmlDocumentRequest,
      check: true,
    });

    expectRouteMatches(route!, ['/', '/blog/one'], ['/_next/static/chunk.js']);
  });
});

describe('static export fallback adapter routes', () => {
  const testDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...testDirs].map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
    testDirs.clear();
  });

  it('orders the global fallback after route-specific dynamic fallbacks', async () => {
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adapter-vercel-')
    );
    testDirs.add(projectDir);

    const distDir = path.join(projectDir, '.next');
    const staticRoot = path.join(projectDir, 'static-src');

    await fs.mkdir(path.join(projectDir, 'public'), { recursive: true });
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, 'routes-manifest.json'),
      JSON.stringify({
        version: 3,
        pages404: true,
        basePath: '/docs',
        redirects: [],
        headers: [],
        dynamicRoutes: [],
        staticRoutes: [],
        dataRoutes: [],
        rewrites: [],
      })
    );

    const createStaticFile = async (relativePath: string) => {
      const filePath = path.join(staticRoot, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, relativePath);
      return filePath;
    };

    const staticFile = async (id: string, pathname: string) => ({
      id,
      type: 'STATIC_FILE',
      pathname,
      filePath: await createStaticFile(`${id}.html`),
    });

    const nextStaticFile = {
      id: 'next-static',
      type: 'STATIC_FILE',
      pathname: '/docs/_next/static/chunk',
      filePath: await createStaticFile('_next/static/chunk.js'),
    };

    await (adapter as NextAdapter).onBuildComplete!({
      buildId: 'build-id',
      config: {
        basePath: '/docs',
        output: 'export',
        trailingSlash: false,
        images: {},
        experimental: {},
      },
      distDir,
      nextVersion: '0.0.0-test',
      outputs: {
        appPages: [],
        appRoutes: [],
        middleware: undefined,
        pages: [],
        pagesApi: [],
        prerenders: [],
        staticFiles: [
          await staticFile('global-fallback', '/docs/_fallback'),
          await staticFile('route-fallback', '/docs/blog/__fallback'),
          nextStaticFile,
        ],
      },
      projectDir,
      repoRoot: projectDir,
      routing: {
        beforeFiles: [],
        beforeMiddleware: [],
        afterFiles: [],
        dynamicRoutes: [
          {
            source: '/blog/[slug]',
            sourceRegex: '^/docs/blog/([^/]+?)(?:/)?$',
            destination: '/docs/blog/__fallback',
            has: htmlDocumentRequest,
          },
        ],
        fallback: [],
        middlewareMatchers: [],
        onMatch: [],
        rsc: {
          header: 'rsc',
          prefetchHeader: 'next-router-prefetch',
          prefetchSegmentDirSuffix: '.segments',
          prefetchSegmentHeader: 'next-router-segment-prefetch',
          prefetchSegmentSuffix: '.segment.rsc',
          contentTypeHeader: 'text/x-component',
          varyHeader:
            'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
        },
        shouldNormalizeNextData: false,
      },
    } as Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0]);

    const configJson = JSON.parse(
      await fs.readFile(path.join(distDir, 'output/config.json'), 'utf8')
    ) as { routes: Route[] };

    const routeSpecificFallbackIndex = configJson.routes.findIndex(
      (route) => 'dest' in route && route.dest === '/docs/blog/__fallback'
    );
    const globalFallbackIndex = configJson.routes.findIndex(
      (route) => 'dest' in route && route.dest === '/docs/_fallback'
    );
    const hitHandleIndex = configJson.routes.findIndex(
      (route) => 'handle' in route && route.handle === 'hit'
    );

    expect(routeSpecificFallbackIndex).toBeGreaterThan(-1);
    expect(globalFallbackIndex).toBeGreaterThan(routeSpecificFallbackIndex);
    expect(globalFallbackIndex).toBeLessThan(hitHandleIndex);
    expect(configJson.routes[globalFallbackIndex]).toEqual({
      src: '^/docs(?:/(?!_next(?:/|$)).*)?$',
      dest: '/docs/_fallback',
      has: htmlDocumentRequest,
      check: true,
    });
  });
});
