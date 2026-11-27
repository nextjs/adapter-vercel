import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  mergeRoutes,
  normalizeRoutes,
  type Route,
  type RouteWithSrc,
} from '@vercel/routing-utils';
import type { NextAdapter, NextConfig } from 'next';
import { afterEach, describe, expect, it } from 'vitest';
import adapter from './index';
import { blockErrorPageRoutes } from './routing';

type BuildContext = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];

function matchingRoute(routes: readonly RouteWithSrc[], pathname: string) {
  return routes.find((route) => new RegExp(route.src, 'i').test(pathname));
}

describe('blockErrorPageRoutes', () => {
  it.each(['/_error', '/_error/', '/_error.rsc', '/_ERROR'])(
    'sends a direct request for %s to the 404 page',
    (pathname) => {
      const routes = blockErrorPageRoutes({}, '/404');
      expect(matchingRoute(routes, pathname)).toEqual({
        src: '^/_error(?:\\.rsc)?/?$',
        dest: '/404',
        status: 404,
        check: true,
        override: true,
      });
    }
  );

  it.each(['/_errors', '/_error/nested', '/nested/_error', '/x_error'])(
    'leaves %s alone',
    (pathname) => {
      expect(
        matchingRoute(blockErrorPageRoutes({}, '/404'), pathname)
      ).toBeUndefined();
    }
  );

  it('uses the not-found fallback the error phase uses, even /_error itself', () => {
    expect(blockErrorPageRoutes({}, '/_not-found')[0]?.dest).toBe(
      '/_not-found'
    );
    expect(blockErrorPageRoutes({}, '/_error')[0]?.dest).toBe('/_error');
  });

  it('matches only below the basePath', () => {
    const routes = blockErrorPageRoutes({ basePath: '/docs.v2' }, '/404');
    expect(matchingRoute(routes, '/docs.v2/_error')?.dest).toBe('/docs.v2/404');
    expect(matchingRoute(routes, '/_error')).toBeUndefined();
    // the basePath is escaped, so `.` doesn't match any character
    expect(matchingRoute(routes, '/docsXv2/_error')).toBeUndefined();
  });

  it('covers locale-prefixed and unprefixed requests with i18n', () => {
    const config: NextConfig = {
      basePath: '/docs',
      i18n: { locales: ['en', 'fr-FR'], defaultLocale: 'en' },
    };
    const routes = blockErrorPageRoutes(config, '/404');
    expect(routes).toEqual([
      {
        src: '^/docs/(?<nextLocale>en|fr\\-FR)/_error(?:\\.rsc)?/?$',
        dest: '/docs/$nextLocale/404',
        status: 404,
        check: true,
        override: true,
      },
      {
        src: '^/docs/_error(?:\\.rsc)?/?$',
        dest: '/docs/en/404',
        status: 404,
        check: true,
        override: true,
      },
    ]);
    expect(matchingRoute(routes, '/docs/fr-FR/_error')).toBe(routes[0]);
    expect(matchingRoute(routes, '/docs/_error/')).toBe(routes[1]);
    expect(matchingRoute(routes, '/docs/de/_error')).toBeUndefined();
  });
});

describe('adapter-generated routes', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true }))
    );
  });

  async function generateRoutes(
    config: NextConfig,
    { shouldNormalizeNextData = false } = {}
  ): Promise<Route[]> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-routing-'));
    roots.push(root);
    const distDir = path.join(root, '.next');
    const staticPath = path.join(distDir, 'static/chunk.js');
    await fs.mkdir(path.dirname(staticPath), { recursive: true });
    await Promise.all([
      fs.writeFile(staticPath, ''),
      fs.writeFile(
        path.join(distDir, 'routes-manifest.json'),
        JSON.stringify({ staticRoutes: [], dynamicRoutes: [] })
      ),
    ]);
    const context = {
      projectDir: root,
      repoRoot: root,
      distDir,
      buildId: 'build-id',
      nextVersion: '16.5.0-canary.40',
      config: { basePath: '', experimental: {}, ...config },
      outputs: {
        appRoutes: [],
        appPages: [],
        pages: [],
        pagesApi: [],
        staticFiles: [
          {
            type: 'STATIC_FILE',
            id: 'chunk',
            pathname: '/_next/static/chunk.js',
            filePath: staticPath,
          },
        ],
        prerenders: [],
      },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        fallback: [],
        dynamicRoutes: [],
        onMatch: [],
        shouldNormalizeNextData,
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
    if (!adapter.onBuildComplete) throw new Error('Expected build hook');
    await adapter.onBuildComplete(context);
    const generated = JSON.parse(
      await fs.readFile(path.join(distDir, 'output/config.json'), 'utf8')
    ) as { routes: Route[] };
    expect(normalizeRoutes(generated.routes).error).toBeNull();
    return generated.routes;
  }

  /**
   * `vercel build` passes the adapter's routes through `mergeRoutes`, which
   * reorders each phase, so this is the order the proxy runs them in.
   */
  function deployedOrder(routes: Route[]): Route[] {
    return mergeRoutes({
      builds: [{ use: '@vercel/next', entrypoint: 'package.json', routes }],
    });
  }

  /**
   * Follows a request through the `before_filesystem` routes to the first one
   * that sets a status, applying the `continue` rewrites on the way. Only the
   * route features those rewrites use are modeled; `x-nextjs-data` is the
   * only header the request carries.
   */
  function firstStatusRoute(
    routes: readonly Route[],
    requestPath: string,
    { hasDataHeader = false } = {}
  ): { route?: RouteWithSrc; path: string } {
    const hasHeader = (key: string) => hasDataHeader && key === 'x-nextjs-data';
    let currentPath = requestPath;
    for (const route of routes) {
      if ('handle' in route) break;
      const conditionsHold =
        (route.has ?? []).every(
          (condition) => condition.type === 'header' && hasHeader(condition.key)
        ) &&
        !(route.missing ?? []).some(
          (condition) => condition.type === 'header' && hasHeader(condition.key)
        );
      const match = new RegExp(route.src, 'i').exec(currentPath);
      if (!conditionsHold || !match) continue;
      if (route.status) return { route, path: currentPath };
      if (route.dest) {
        currentPath = route.dest.replace(
          /\$(\w+)/g,
          (_, key: string) =>
            (/^\d+$/.test(key) ? match[Number(key)] : match.groups?.[key]) ?? ''
        );
      }
    }
    return { path: currentPath };
  }

  function handleIndex(routes: readonly Route[], handle: string) {
    return routes.findIndex(
      (route) => 'handle' in route && route.handle === handle
    );
  }

  it('blocks a direct /_error request before the filesystem phase and keeps it as the error fallback', async () => {
    const routes = await generateRoutes({});
    const blockIndex = routes.findIndex(
      (route) => 'src' in route && route.src === '^/_error(?:\\.rsc)?/?$'
    );
    const filesystemIndex = handleIndex(routes, 'filesystem');
    expect(blockIndex).toBeGreaterThan(-1);
    expect(blockIndex).toBeLessThan(filesystemIndex);
    // With no /404 or /_not-found output, /_error is the 404 and 500 page.
    expect(routes[blockIndex]).toMatchObject({ dest: '/_error', status: 404 });
    expect(routes.slice(handleIndex(routes, 'error') + 1)).toEqual([
      { src: '/.*', dest: '/_error', status: 404 },
      { src: '/.*', dest: '/_error', status: 500 },
    ]);
  });

  it('blocks locale-prefixed /_error requests after the default locale is added', async () => {
    const routes = await generateRoutes({
      i18n: { locales: ['en', 'fr'], defaultLocale: 'en' },
    });
    const blockIndex = routes.findIndex(
      (route) =>
        'src' in route &&
        route.src === '^/(?<nextLocale>en|fr)/_error(?:\\.rsc)?/?$'
    );
    const defaultLocaleIndex = routes.findIndex(
      (route) => 'src' in route && route.dest === '/en/$1'
    );
    expect(defaultLocaleIndex).toBeGreaterThan(-1);
    expect(blockIndex).toBeGreaterThan(defaultLocaleIndex);
    expect(blockIndex).toBeLessThan(handleIndex(routes, 'filesystem'));
  });

  it.each([
    ['a direct request', '/_error', false],
    ['a data request', '/_next/data/build-id/_error.json', true],
  ])(
    'blocks %s for /_error in the deployed route order when data URLs are normalized',
    async (_, requestPath, hasDataHeader) => {
      const routes = deployedOrder(
        await generateRoutes({}, { shouldNormalizeNextData: true })
      );
      expect(firstStatusRoute(routes, requestPath, { hasDataHeader })).toEqual({
        route: {
          src: '^/_error(?:\\.rsc)?/?$',
          dest: '/_error',
          status: 404,
          check: true,
          override: true,
        },
        path: '/_error',
      });
    }
  );

  it('leaves other data requests to the filesystem', async () => {
    const routes = deployedOrder(
      await generateRoutes({}, { shouldNormalizeNextData: true })
    );
    expect(
      firstStatusRoute(routes, '/_next/data/build-id/page.json', {
        hasDataHeader: true,
      }).route
    ).toBeUndefined();
  });
});
