import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  mergeRoutes,
  normalizeRoutes,
  type Route,
} from '@vercel/routing-utils';
import type { NextAdapter, NextConfig } from 'next';
import { afterEach, describe, expect, it } from 'vitest';
import adapter from './index';

type BuildContext = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];

const buildId = 'build-id';
// The matcher Next.js emits for `matcher: '/inspection'`.
const inspectionMatcher =
  '^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/inspection(\\.json)?[\\/#\\?]?$';

/**
 * Follows a `_next/data` request (which carries `x-nextjs-data`) through the
 * `continue` rewrites before `handle: 'filesystem'`, like the proxy does, and
 * returns the path each middleware route receives. Only the route features
 * these rewrites use are modeled.
 */
function tracePathsSeenByMiddleware(
  routes: readonly Route[],
  requestPath: string
): { seenByMiddleware: string[]; beforeFilesystem: string } {
  const seenByMiddleware: string[] = [];
  let currentPath = requestPath;
  for (const route of routes) {
    if ('handle' in route) {
      if (route.handle === 'filesystem') break;
      continue;
    }
    const conditionsHold =
      (route.has ?? []).every(
        (condition) =>
          condition.type === 'header' && condition.key === 'x-nextjs-data'
      ) &&
      !(route.missing ?? []).some(
        (condition) =>
          condition.type === 'header' && condition.key === 'x-nextjs-data'
      );
    const match = new RegExp(route.src, 'i').exec(currentPath);
    if (!conditionsHold || !match || route.status) continue;
    if (route.middlewarePath) seenByMiddleware.push(currentPath);
    if (route.dest) {
      currentPath = route.dest.replace(
        /\$(\w+)/g,
        (_, key: string) =>
          (/^\d+$/.test(key) ? match[Number(key)] : match.groups?.[key]) ?? ''
      );
    }
  }
  return { seenByMiddleware, beforeFilesystem: currentPath };
}

describe('Proxy URL normalization on Vercel', () => {
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
    matcher = inspectionMatcher
  ): Promise<Route[]> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-url-'));
    roots.push(root);
    const distDir = path.join(root, '.next');
    const middlewareEntrypoint = path.join(distDir, 'server/middleware.js');
    const pageEntrypoint = path.join(distDir, 'server/pages/inspection.js');
    const staticPath = path.join(distDir, 'static/chunk.js');
    await fs.mkdir(path.dirname(staticPath), { recursive: true });
    await fs.mkdir(path.dirname(pageEntrypoint), { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ private: true, engines: { node: '22.x' } })
      ),
      fs.writeFile(
        path.join(distDir, 'routes-manifest.json'),
        JSON.stringify({ staticRoutes: [], dynamicRoutes: [] })
      ),
      fs.writeFile(middlewareEntrypoint, 'exports.handler = () => {};'),
      fs.writeFile(pageEntrypoint, 'exports.handler = () => {};'),
      fs.writeFile(staticPath, ''),
    ]);
    const context = {
      projectDir: root,
      repoRoot: root,
      distDir,
      buildId,
      nextVersion: '16.5.0-canary.40',
      config: { basePath: '', experimental: {}, ...config },
      outputs: {
        appRoutes: [],
        appPages: [],
        pages: [
          {
            type: 'PAGES',
            runtime: 'nodejs',
            id: '/inspection',
            pathname: '/inspection',
            sourcePage: '/inspection',
            filePath: pageEntrypoint,
            assets: {},
            assetsHashes: {},
            config: {},
          },
        ],
        pagesApi: [],
        staticFiles: [
          {
            type: 'STATIC_FILE',
            id: 'chunk',
            pathname: `${config.basePath ?? ''}/_next/static/chunk.js`,
            filePath: staticPath,
          },
        ],
        prerenders: [],
        middleware: {
          type: 'MIDDLEWARE',
          runtime: 'nodejs',
          id: '/proxy',
          pathname: '/proxy',
          sourcePage: 'proxy',
          filePath: middlewareEntrypoint,
          assets: {},
          assetsHashes: {},
          config: {
            matchers: [
              {
                source: '/inspection',
                sourceRegex: matcher,
              },
            ],
          },
        },
      },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        fallback: [],
        dynamicRoutes: [],
        onMatch: [],
        shouldNormalizeNextData: true,
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
    // `vercel build` passes the routes through `mergeRoutes`, which reorders
    // each phase, so this is the order the proxy runs them in.
    return mergeRoutes({
      builds: [
        {
          use: '@vercel/next',
          entrypoint: 'package.json',
          routes: generated.routes,
        },
      ],
    });
  }

  const dataUrl = `/_next/data/${buildId}/inspection.json`;

  it('shows Proxy the page path for a data URL by default', async () => {
    const routes = await generateRoutes({});
    expect(tracePathsSeenByMiddleware(routes, dataUrl)).toEqual({
      seenByMiddleware: ['/inspection'],
      beforeFilesystem: dataUrl,
    });
  });

  it.each([
    ['skipProxyUrlNormalize', { skipProxyUrlNormalize: true }],
    [
      'the deprecated skipMiddlewareUrlNormalize',
      { skipMiddlewareUrlNormalize: true },
    ],
  ] satisfies [string, NextConfig][])(
    'shows Proxy the data URL as sent with %s',
    async (_, config) => {
      const routes = await generateRoutes(config);
      expect(tracePathsSeenByMiddleware(routes, dataUrl)).toEqual({
        seenByMiddleware: [dataUrl],
        beforeFilesystem: dataUrl,
      });
      // Routes between Proxy and the final denormalize still see the page path.
      const filesystemIndex = routes.findIndex(
        (route) => 'handle' in route && route.handle === 'filesystem'
      );
      const finalDenormalizeIndex = routes
        .slice(0, filesystemIndex)
        .findLastIndex(
          (route) =>
            'src' in route && route.dest === `/_next/data/${buildId}/index.json`
        );
      expect(
        tracePathsSeenByMiddleware(
          [
            ...routes.slice(0, finalDenormalizeIndex),
            { src: '.*', middlewarePath: '/after-proxy', continue: true },
          ],
          dataUrl
        ).seenByMiddleware
      ).toEqual([dataUrl, '/inspection']);
    }
  );

  it('keeps basePath and trailingSlash in the data URL Proxy sees', async () => {
    const routes = await generateRoutes(
      { basePath: '/docs', trailingSlash: true, skipProxyUrlNormalize: true },
      `^/docs${inspectionMatcher.slice(1)}`
    );
    const docsDataUrl = `/docs/_next/data/${buildId}/inspection.json`;
    expect(tracePathsSeenByMiddleware(routes, docsDataUrl)).toEqual({
      seenByMiddleware: [docsDataUrl],
      beforeFilesystem: docsDataUrl,
    });
  });
});
